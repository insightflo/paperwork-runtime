#![forbid(unsafe_code)]
//! budget.* JSON-RPC methods: pure threshold/window evaluation plus
//! company-scoped cost-event recording, per-scope spend sums, active-policy
//! listing, and fenced incident upsert/resolve. All PG I/O reuses
//! heartbeat.rs's hardened direct-PG path (exec_db): loopback-only DSN
//! apply-or-reject, DNS permit cap, deadline-gated commit (-32001..-32005),
//! driver abort. Param gates are fail-closed: non-object params or schema
//! mismatch => -32602 and domain rejections (invalid window, non-company
//! scope, illegal transition, out-of-range amounts) fire before any PG I/O.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_budget::{evaluate_threshold, utc_month_window, validate_incident_transition, BudgetIncidentRow, BudgetIncidentStatus, BudgetPolicyRow, BudgetScopeType, BudgetThresholdType, BudgetWindowKind, CostEventRow, SQL_INSERT_COST_EVENT, SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE, SQL_RESOLVE_INCIDENT_FENCED, SQL_SUM_SCOPE_SPEND_AGENT, SQL_SUM_SCOPE_SPEND_COMPANY, SQL_SUM_SCOPE_SPEND_PROJECT, SQL_UPSERT_OPEN_INCIDENT};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct EvalP { limit_cents: i64, observed_cents: i64, warn_percent: i32, hard_stop_enabled: bool }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct MonthP { now: DateTime<Utc> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct RecordP { company_id: Uuid, agent_id: Uuid, #[serde(default)] issue_id: Option<Uuid>, #[serde(default)] project_id: Option<Uuid>, #[serde(default)] goal_id: Option<Uuid>, #[serde(default)] heartbeat_run_id: Option<Uuid>, #[serde(default)] billing_code: Option<String>, provider: String, #[serde(default)] biller: Option<String>, #[serde(default)] billing_type: Option<String>, model: String, input_tokens: i32, cached_input_tokens: i32, output_tokens: i32, cost_cents: i64, occurred_at: DateTime<Utc> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct SumP { company_id: Uuid, scope_type: BudgetScopeType, scope_id: Uuid, window_start: DateTime<Utc>, window_end: DateTime<Utc> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct PoliciesP { company_id: Uuid, scope_type: BudgetScopeType, scope_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct UpsertP { company_id: Uuid, policy_id: Uuid, scope_type: BudgetScopeType, scope_id: Uuid, metric: String, window_kind: BudgetWindowKind, window_start: DateTime<Utc>, window_end: DateTime<Utc>, threshold_type: BudgetThresholdType, amount_limit: i64, amount_observed: i64, #[serde(default)] approval_id: Option<Uuid> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResolveP { incident_id: Uuid, company_id: Uuid, target_status: BudgetIncidentStatus }

enum Db { Record(RecordP), Sum(SumP), Policies(PoliciesP), Upsert(UpsertP), Resolve(ResolveP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn event_json(r: &Row) -> Value { serde_json::to_value(CostEventRow { id: r.get(0), company_id: r.get(1), agent_id: r.get(2), issue_id: r.get(3), project_id: r.get(4), goal_id: r.get(5), heartbeat_run_id: r.get(6), billing_code: r.get(7), provider: r.get(8), biller: r.get(9), billing_type: r.get(10), model: r.get(11), input_tokens: r.get(12), cached_input_tokens: r.get(13), output_tokens: r.get(14), cost_cents: r.get(15), occurred_at: r.get(16), created_at: r.get(17) }).unwrap_or(Value::Null) }
fn policy_json(r: &Row) -> Value { serde_json::to_value(BudgetPolicyRow { id: r.get(0), company_id: r.get(1), scope_type: r.get(2), scope_id: r.get(3), metric: r.get(4), window_kind: r.get(5), amount: r.get(6), warn_percent: r.get(7), hard_stop_enabled: r.get(8), notify_enabled: r.get(9), is_active: r.get(10), created_by_user_id: r.get(11), updated_by_user_id: r.get(12), created_at: r.get(13), updated_at: r.get(14) }).unwrap_or(Value::Null) }
fn incident_json(r: &Row) -> Value { serde_json::to_value(BudgetIncidentRow { id: r.get(0), company_id: r.get(1), policy_id: r.get(2), scope_type: r.get(3), scope_id: r.get(4), metric: r.get(5), window_kind: r.get(6), window_start: r.get(7), window_end: r.get(8), threshold_type: r.get(9), amount_limit: r.get(10), amount_observed: r.get(11), status: r.get(12), approval_id: r.get(13), resolved_at: r.get(14), created_at: r.get(15), updated_at: r.get(16) }).unwrap_or(Value::Null) }

fn cents(v: i64) -> Result<i32, Fail> { i32::try_from(v).ok().filter(|v| *v >= 0).ok_or(DBERR) }
fn valid_cents(v: i64) -> bool { cents(v).is_ok() }
fn valid_window(s: DateTime<Utc>, e: DateTime<Utc>) -> bool { e > s }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Record(p) => {
            let row = tx.query_opt(SQL_INSERT_COST_EVENT, &[&p.company_id, &p.agent_id, &p.issue_id, &p.project_id, &p.goal_id, &p.heartbeat_run_id, &p.billing_code, &p.provider, &p.biller.as_deref().unwrap_or(p.provider.as_str()), &p.billing_type.as_deref().unwrap_or("unknown"), &p.model, &p.input_tokens, &p.cached_input_tokens, &p.output_tokens, &cents(p.cost_cents)?, &p.occurred_at]).await.map_err(pre)?;
            Step::Commit(tx, match row { // no row: ownership guard rejected the insert, tx wrote nothing
                Some(r) => json!({"recorded":true,"event":event_json(&r)}), None => json!({"recorded":false}) })
        }
        Db::Sum(p) => {
            let row = match p.scope_type {
                BudgetScopeType::Company => tx.query_one(SQL_SUM_SCOPE_SPEND_COMPANY, &[&p.company_id, &p.window_start, &p.window_end]).await,
                BudgetScopeType::Agent => tx.query_one(SQL_SUM_SCOPE_SPEND_AGENT, &[&p.company_id, &p.scope_id, &p.window_start, &p.window_end]).await,
                BudgetScopeType::Project => tx.query_one(SQL_SUM_SCOPE_SPEND_PROJECT, &[&p.company_id, &p.scope_id, &p.window_start, &p.window_end]).await,
            }.map_err(pre)?;
            Step::Done(json!({"observed_cents": row.get::<_, i64>(0)})) // read-only: tx dropped, never committed
        }
        Db::Policies(p) => {
            let rows = tx.query(SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE, &[&p.company_id, &p.scope_type.as_str(), &p.scope_id]).await.map_err(pre)?;
            Step::Done(json!({"policies": rows.iter().map(policy_json).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
        Db::Upsert(p) => {
            let (amount_limit, amount_observed) = (cents(p.amount_limit)?, cents(p.amount_observed)?);
            let row = tx.query_opt(SQL_UPSERT_OPEN_INCIDENT, &[&p.company_id, &p.policy_id, &p.scope_type.as_str(), &p.scope_id, &p.metric, &p.window_kind.as_str(), &p.window_start, &p.window_end, &p.threshold_type.as_str(), &amount_limit, &amount_observed, &p.approval_id]).await.map_err(pre)?;
            Step::Commit(tx, match row { // no row: policy fence rejected the upsert, tx wrote nothing
                Some(r) => json!({"upserted":true,"incident":incident_json(&r)}), None => json!({"upserted":false}) })
        }
        Db::Resolve(p) => {
            let row = tx.query_opt(SQL_RESOLVE_INCIDENT_FENCED, &[&p.incident_id, &p.company_id, &p.target_status.as_str()]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"resolved":true,"incident":incident_json(&r)}), None => json!({"resolved":false}) })
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Windows, amounts, scope, and incident transitions
/// are re-validated before any PG I/O (unset DATABASE_URL still yields -32602).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "budget.evaluate_threshold" => { let p = need!(EvalP); ok(id, json!({"threshold": evaluate_threshold(p.limit_cents, p.observed_cents, p.warn_percent, p.hard_stop_enabled).map(|t| t.as_str())})) }
        "budget.utc_month_window" => { let p = need!(MonthP); let (s, e) = utc_month_window(p.now); ok(id, json!({"window_start": s, "window_end": e})) }
        "budget.record_cost_event" => { let p = need!(RecordP); if !valid_cents(p.cost_cents) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Record(p)) }
        "budget.sum_scope_spend" => { let p = need!(SumP); if !valid_window(p.window_start, p.window_end) || (p.scope_type == BudgetScopeType::Company && p.scope_id != p.company_id) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Sum(p)) }
        "budget.list_active_policies" => { let p = need!(PoliciesP); exec_db(id, env, OP_TIMEOUT, Db::Policies(p)) }
        "budget.upsert_incident_fenced" => { let p = need!(UpsertP); if !valid_window(p.window_start, p.window_end) || !valid_cents(p.amount_limit) || !valid_cents(p.amount_observed) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Upsert(p)) }
        "budget.resolve_incident_fenced" => { let p = need!(ResolveP); if validate_incident_transition(BudgetIncidentStatus::Open, p.target_status).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Resolve(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn record(u: Uuid) -> Value { json!({"company_id":u,"agent_id":u,"provider":"openai","model":"m","input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"cost_cents":5,"occurred_at":"2026-06-15T12:00:00Z"}) }
    fn upsert(u: Uuid) -> Value { json!({"company_id":u,"policy_id":u,"scope_type":"company","scope_id":u,"metric":"billed_cents","window_kind":"lifetime","window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z","threshold_type":"hard","amount_limit":100,"amount_observed":150}) }
    fn sum(u: Uuid) -> Value { json!({"company_id":u,"scope_type":"agent","scope_id":u,"window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z"}) }
    fn resolve(u: Uuid) -> Value { json!({"incident_id":u,"company_id":u,"target_status":"resolved"}) }

    #[test]
    fn pure_threshold_boundaries_and_month_window() {
        let e = env("");
        let v = |p: Value| call("budget.evaluate_threshold", p, &e);
        assert_eq!(v(json!({"limit_cents":1000,"observed_cents":800,"warn_percent":80,"hard_stop_enabled":true}))["result"], json!({"threshold":"soft"}));
        assert_eq!(v(json!({"limit_cents":1000,"observed_cents":1000,"warn_percent":80,"hard_stop_enabled":true}))["result"], json!({"threshold":"hard"}));
        assert_eq!(v(json!({"limit_cents":1000,"observed_cents":1000,"warn_percent":80,"hard_stop_enabled":false}))["result"], json!({"threshold":"soft"}));
        assert_eq!(v(json!({"limit_cents":1000,"observed_cents":799,"warn_percent":80,"hard_stop_enabled":true}))["result"], json!({"threshold":null}));
        let w = |p: Value| call("budget.utc_month_window", p, &e);
        assert_eq!(w(json!({"now":"2026-12-20T15:30:00Z"}))["result"], json!({"window_start":"2026-12-01T00:00:00Z","window_end":"2027-01-01T00:00:00Z"}));
        assert_eq!(w(json!({"now":"2026-11-01T00:00:00Z"}))["result"], json!({"window_start":"2026-11-01T00:00:00Z","window_end":"2026-12-01T00:00:00Z"}));
    }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let (e, u) = (env(""), Uuid::nil());
        for p in [json!(null), json!([]), json!("x")] {
            assert_eq!(code(&call("budget.evaluate_threshold", p, &e)), -32602); }
        assert_eq!(code(&dispatch_with(json!(1), "budget.list_active_policies", None, &e)), -32602); // missing params
        for (m, p) in [
            ("budget.evaluate_threshold", json!({"limit_cents":1,"observed_cents":1,"warn_percent":1,"hard_stop_enabled":true,"x":0})),
            ("budget.utc_month_window", json!({"now":"not-a-date"})),
            ("budget.record_cost_event", json!({"company_id":u})),
            ("budget.sum_scope_spend", json!({"company_id":u,"scope_type":"tenant","scope_id":u,"window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z"})),
            ("budget.list_active_policies", json!({"company_id":u,"scope_type":"project","scope_id":u,"z":1})),
            ("budget.upsert_incident_fenced", json!({"company_id":u,"policy_id":u,"scope_type":"company","scope_id":u,"metric":"m","window_kind":"bogus","window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z","threshold_type":"hard","amount_limit":1,"amount_observed":1})),
            ("budget.upsert_incident_fenced", json!({"company_id":u,"policy_id":u,"scope_type":"company","scope_id":u,"metric":"m","window_kind":"lifetime","window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z","threshold_type":"bogus","amount_limit":1,"amount_observed":1})),
            ("budget.resolve_incident_fenced", json!({"incident_id":u,"company_id":u,"target_status":"bogus"})),
            ("budget.resolve_incident_fenced", json!({"incident_id":"x","company_id":u,"target_status":"resolved"})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        let mut ok_opt = record(u); ok_opt["issue_id"] = json!(null); ok_opt["billing_code"] = json!("bc"); // optional fields: null/missing ok
        assert_eq!(code(&call("budget.record_cost_event", ok_opt, &e)), -32002);
        let mut bad_opt = record(u); bad_opt["issue_id"] = json!(5);
        assert_eq!(code(&call("budget.record_cost_event", bad_opt, &e)), -32602);
    }

    #[test]
    fn pre_io_rejection_before_any_pg_io() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves rejection precedes DSN checks
        for w in ["2026-06-01T00:00:00Z", "2026-05-31T23:59:59Z"] {
            let mut bad = upsert(u); bad["window_end"] = json!(w);
            assert_eq!(code(&call("budget.upsert_incident_fenced", bad, &none)), -32602, "{w}"); }
        let mut bad_amt = upsert(u); bad_amt["amount_observed"] = json!(-1);
        assert_eq!(code(&call("budget.upsert_incident_fenced", bad_amt, &none)), -32602);
        assert_eq!(code(&call("budget.resolve_incident_fenced", json!({"incident_id":u,"company_id":u,"target_status":"open"}), &none)), -32602);
        assert_eq!(code(&call("budget.sum_scope_spend", json!({"company_id":u,"scope_type":"company","scope_id":Uuid::new_v4(),"window_start":"2026-06-01T00:00:00Z","window_end":"2026-07-01T00:00:00Z"}), &none)), -32602);
        let mut bad_sum = sum(u); bad_sum["window_end"] = bad_sum["window_start"].clone();
        assert_eq!(code(&call("budget.sum_scope_spend", bad_sum, &none)), -32602);
        let mut bad_cost = record(u); bad_cost["cost_cents"] = json!(-5);
        assert_eq!(code(&call("budget.record_cost_event", bad_cost, &none)), -32602);
    }

    #[test]
    fn db_unconfigured_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("budget.record_cost_event", record(u)),
                ("budget.sum_scope_spend", sum(u)),
                ("budget.list_active_policies", json!({"company_id":u,"scope_type":"project","scope_id":u})),
                ("budget.upsert_incident_fenced", upsert(u)),
                ("budget.resolve_incident_fenced", resolve(u)),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn unknown_method_and_health_capabilities() {
        assert_eq!(code(&call("budget.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("budget.", json!({}), &env(""))), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &env(""))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["budget.evaluate_threshold", "budget.utc_month_window", "budget.record_cost_event", "budget.sum_scope_spend",
                  "budget.list_active_policies", "budget.upsert_incident_fenced", "budget.resolve_incident_fenced"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

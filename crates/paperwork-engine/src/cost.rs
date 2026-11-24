#![forbid(unsafe_code)]
//! cost.* JSON-RPC methods: company-scoped cost-event recording, listing,
//! per-company window spend sums, and spend snapshots backed by the
//! engine-cost domain crate. All PG I/O reuses heartbeat.rs's hardened
//! direct-PG path (exec_db): loopback-only DSN apply-or-reject, DNS permit
//! cap, deadline-gated commit (-32001..-32005), driver abort. Param gates
//! are fail-closed: non-object params or schema mismatch => -32602 and
//! domain rejections (invalid window, negative tokens, empty provider/model,
//! out-of-range amounts) fire before any PG I/O.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_cost::{clamp_list_limit, validate_cost_cents, validate_cost_window, BillingType, CompanySpendSnapshotRow, CostEventRow, SQL_GET_COMPANY_SPEND_SNAPSHOT, SQL_INSERT_COST_EVENT, SQL_LIST_COST_EVENTS, SQL_SUM_COMPANY_COST_WINDOW};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct RecordP { company_id: Uuid, agent_id: Uuid, #[serde(default)] issue_id: Option<Uuid>, #[serde(default)] project_id: Option<Uuid>, #[serde(default)] goal_id: Option<Uuid>, #[serde(default)] heartbeat_run_id: Option<Uuid>, #[serde(default)] billing_code: Option<String>, provider: String, #[serde(default)] biller: Option<String>, #[serde(default)] billing_type: Option<BillingType>, model: String, input_tokens: i32, cached_input_tokens: i32, output_tokens: i32, cost_cents: i64, occurred_at: DateTime<Utc> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default)] agent_id: Option<Uuid>, #[serde(default)] from: Option<DateTime<Utc>>, #[serde(default)] to: Option<DateTime<Utc>>, #[serde(default = "default_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct SummarizeP { company_id: Uuid, #[serde(default)] from: Option<DateTime<Utc>>, #[serde(default)] to: Option<DateTime<Utc>> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct SnapshotP { company_id: Uuid }

fn default_limit() -> i64 { 100 } // mirrors the HTTP list default

enum Db { Record(RecordP), List(ListP), Summarize(SummarizeP), Snapshot(SnapshotP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn event_json(r: &Row) -> Result<Value, Fail> {
    serde_json::to_value(CostEventRow {
        id: r.get(0), company_id: r.get(1), agent_id: r.get(2), issue_id: r.get(3), project_id: r.get(4), goal_id: r.get(5), heartbeat_run_id: r.get(6),
        billing_code: r.get(7), provider: r.get(8), biller: r.get(9), billing_type: BillingType::parse(&r.get::<_, String>(10)).map_err(|_| DBERR)?,
        model: r.get(11), input_tokens: r.get(12), cached_input_tokens: r.get(13), output_tokens: r.get(14), cost_cents: r.get(15), occurred_at: r.get(16), created_at: r.get(17),
    }).map_err(|_| DBERR)
}
fn snapshot_json(r: &Row) -> Value { serde_json::to_value(CompanySpendSnapshotRow { company_id: r.get(0), budget_monthly_cents: r.get(1), spent_monthly_cents: r.get(2) }).unwrap_or(Value::Null) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Record(p) => {
            let (biller, billing_type, cost_cents) = (p.biller.as_deref().unwrap_or(p.provider.as_str()), p.billing_type.unwrap_or(BillingType::Unknown).as_str(), validate_cost_cents(p.cost_cents).map_err(|_| DBERR)?);
            let row = tx.query_opt(SQL_INSERT_COST_EVENT, &[&p.company_id, &p.agent_id, &p.issue_id, &p.project_id, &p.goal_id, &p.heartbeat_run_id, &p.billing_code, &p.provider, &biller, &billing_type, &p.model, &p.input_tokens, &p.cached_input_tokens, &p.output_tokens, &cost_cents, &p.occurred_at]).await.map_err(pre)?;
            Step::Commit(tx, match row { // no row: ownership guard rejected the insert, tx wrote nothing
                Some(r) => json!({"recorded":true,"event":event_json(&r)?}), None => json!({"recorded":false}) })
        }
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_COST_EVENTS, &[&p.company_id, &p.agent_id, &p.from, &p.to, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"events": rows.iter().map(event_json).collect::<Result<Vec<_>, Fail>>()?})) // read-only: tx dropped, never committed
        }
        Db::Summarize(p) => {
            let row = tx.query_one(SQL_SUM_COMPANY_COST_WINDOW, &[&p.company_id, &p.from, &p.to]).await.map_err(pre)?;
            Step::Done(json!({"spend_cents": row.get::<_, i64>(0)})) // read-only: tx dropped, never committed
        }
        Db::Snapshot(p) => {
            let row = tx.query_opt(SQL_GET_COMPANY_SPEND_SNAPSHOT, &[&p.company_id]).await.map_err(pre)?;
            Step::Done(match row { // read-only: tx dropped, never committed
                Some(r) => { let s = snapshot_json(&r); json!({"found":true,"company_id":s["company_id"],"budget_monthly_cents":s["budget_monthly_cents"],"spent_monthly_cents":s["spent_monthly_cents"]}) }
                None => json!({"found":false}) })
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Windows, amounts, tokens, and provider/model are
/// re-validated before any PG I/O (unset DATABASE_URL still yields -32602).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "cost.record_event" => {
            let p = need!(RecordP);
            if validate_cost_cents(p.cost_cents).is_err() || p.provider.trim().is_empty() || p.model.trim().is_empty()
                || p.input_tokens < 0 || p.cached_input_tokens < 0 || p.output_tokens < 0 { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Record(p))
        }
        "cost.list_events" => { let p = need!(ListP); if validate_cost_window(p.from, p.to).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "cost.summarize_window" => { let p = need!(SummarizeP); if validate_cost_window(p.from, p.to).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Summarize(p)) }
        "cost.get_spend_snapshot" => { let p = need!(SnapshotP); exec_db(id, env, OP_TIMEOUT, Db::Snapshot(p)) }
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
    fn window(u: Uuid) -> Value { json!({"company_id":u,"from":"2026-06-01T00:00:00Z","to":"2026-07-01T00:00:00Z"}) }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let (e, u) = (env(""), Uuid::nil());
        for p in [json!(null), json!([]), json!("x")] {
            assert_eq!(code(&call("cost.list_events", p, &e)), -32602); }
        assert_eq!(code(&dispatch_with(json!(1), "cost.get_spend_snapshot", None, &e)), -32602); // missing params
        for (m, p) in [
            ("cost.record_event", json!({"company_id":u})),
            ("cost.list_events", json!({"company_id":u,"z":1})),
            ("cost.summarize_window", json!({"company_id":u,"from":"x"})),
            ("cost.get_spend_snapshot", json!({"company_id":"x"})),
            ("cost.record_event", { let mut r = record(u); r["billing_type"] = json!("bogus"); r }),
            ("cost.record_event", { let mut r = record(u); r["cost_cents"] = json!(-5); r }),
            ("cost.record_event", { let mut r = record(u); r["input_tokens"] = json!(-1); r }),
            ("cost.record_event", { let mut r = record(u); r["cached_input_tokens"] = json!(-1); r }),
            ("cost.record_event", { let mut r = record(u); r["output_tokens"] = json!(-1); r }),
            ("cost.record_event", { let mut r = record(u); r["provider"] = json!("  "); r }),
            ("cost.record_event", { let mut r = record(u); r["model"] = json!(""); r }),
            ("cost.list_events", json!({"company_id":u,"from":"2026-07-01T00:00:00Z","to":"2026-06-01T00:00:00Z"})),
            ("cost.summarize_window", json!({"company_id":u,"from":"2026-07-01T00:00:00Z","to":"2026-06-01T00:00:00Z"})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        let mut ok_opt = record(u); ok_opt["issue_id"] = json!(null); ok_opt["billing_type"] = json!("metered_api"); ok_opt["billing_code"] = json!("bc"); // optional fields: null/missing ok
        assert_eq!(code(&call("cost.record_event", ok_opt, &e)), -32002);
        let mut bad_opt = record(u); bad_opt["issue_id"] = json!(5);
        assert_eq!(code(&call("cost.record_event", bad_opt, &e)), -32602);
    }

    #[test]
    fn pre_io_rejection_before_any_pg_io() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves rejection precedes DSN checks
        let mut bad = record(u); bad["cost_cents"] = json!(-5);
        assert_eq!(code(&call("cost.record_event", bad.clone(), &none)), -32602);
        bad["provider"] = json!(" ");
        assert_eq!(code(&call("cost.record_event", bad.clone(), &none)), -32602);
        bad["model"] = json!("");
        assert_eq!(code(&call("cost.record_event", bad, &none)), -32602);
        for (m, p) in [
            ("cost.list_events", json!({"company_id":u,"from":"2026-07-01T00:00:00Z","to":"2026-06-01T00:00:00Z"})),
            ("cost.summarize_window", json!({"company_id":u,"from":"2026-07-01T00:00:00Z","to":"2026-06-01T00:00:00Z"})),
        ] { assert_eq!(code(&call(m, p, &none)), -32602, "{m}"); }
    }

    #[test]
    fn db_unconfigured_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("cost.record_event", record(u)),
                ("cost.list_events", json!({"company_id":u,"agent_id":u,"limit":10})),
                ("cost.summarize_window", window(u)),
                ("cost.get_spend_snapshot", json!({"company_id":u})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn unknown_method_and_health_capabilities() {
        assert_eq!(code(&call("cost.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("cost.", json!({}), &env(""))), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &env(""))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["cost.record_event", "cost.list_events", "cost.summarize_window", "cost.get_spend_snapshot"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

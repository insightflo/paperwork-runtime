#![forbid(unsafe_code)]
//! decision.* JSON-RPC methods: company-scoped operator-decision listing,
//! lookup, idempotent creation, and fenced resolution/cancellation over
//! heartbeat.rs's hardened direct-PG path (exec_db). Param gates are
//! fail-closed before PG I/O; reads return Step::Done and writes Step::Commit.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_decision::{validate_object_field, validate_optional_object_field, validate_quality_continuation, validate_request_hash, validate_request_key, validate_resolved_by, validate_source, validate_title, ContinuationMode, DecisionPriority, DecisionRow, DecisionStatus, InteractionType, SQL_CANCEL_OPERATOR_DECISION_FENCED, SQL_CREATE_OPERATOR_DECISION, SQL_GET_OPERATOR_DECISION_BY_ID, SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY, SQL_LIST_OPERATOR_DECISIONS, SQL_RESOLVE_OPERATOR_DECISION_FENCED, SCHEMA_VERSION};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default)] status: Option<DecisionStatus>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByIdP { decision_id: Uuid, company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByKeyP { company_id: Uuid, request_key: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CreateP { company_id: Uuid, request_key: String, request_hash: String, priority: DecisionPriority, interaction_type: InteractionType, title: String, description: String, source_type: String, source_id: String, source_context: Value, #[serde(default)] issue_id: Option<Uuid>, #[serde(default)] requested_by_agent_id: Option<Uuid>, #[serde(default)] requested_by_user_id: Option<String>, definition: Value, continuation_mode: ContinuationMode, #[serde(default)] quality_action_id: Option<Uuid>, #[serde(default)] quality_binding: Option<Value> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResolveP { decision_id: Uuid, company_id: Uuid, result: Value, resolved_by_user_id: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CancelP { decision_id: Uuid, company_id: Uuid }

enum Db { List(ListP), GetById(GetByIdP), GetByKey(GetByKeyP), Create(Box<CreateP>), Resolve(ResolveP), Cancel(CancelP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

/// Decode the shared 26-column projection fail-closed: any column/type/enum
/// decode failure yields JSON null rather than fabricating a decision row.
fn decision_json(r: &Row) -> Value {
    macro_rules! g { ($i:expr) => { match r.try_get($i) { Ok(v) => v, Err(_) => return Value::Null } } }
    macro_rules! e { ($i:expr, $parse:path) => {{ let raw: String = g!($i); match $parse(&raw) { Ok(v) => v, Err(_) => return Value::Null } }} }
    serde_json::to_value(DecisionRow {
        id: g!(0), company_id: g!(1), quality_action_id: g!(2), quality_binding: g!(3), request_key: g!(4), request_hash: g!(5), schema_version: g!(6),
        status: e!(7, DecisionStatus::parse), priority: e!(8, DecisionPriority::parse), interaction_type: e!(9, InteractionType::parse),
        title: g!(10), description: g!(11), source_type: g!(12), source_id: g!(13), source_context: g!(14), issue_id: g!(15),
        requested_by_agent_id: g!(16), requested_by_user_id: g!(17), definition: g!(18), result: g!(19), resolved_by_user_id: g!(20),
        resolved_at: g!(21), cancelled_at: g!(22), continuation_mode: e!(23, ContinuationMode::parse), created_at: g!(24), updated_at: g!(25),
    }).unwrap_or(Value::Null)
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::List(p) => {
            let status = p.status.map(|s| s.as_str());
            let rows = tx.query(SQL_LIST_OPERATOR_DECISIONS, &[&p.company_id, &status, &p.limit.clamp(1, 200)]).await.map_err(pre)?;
            Step::Done(json!({"decisions": rows.iter().map(decision_json).collect::<Vec<_>>() })) // read-only: tx dropped, never committed
        }
        Db::GetById(p) => {
            let row = tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_ID, &[&p.decision_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(json!({"decision": row.as_ref().map(decision_json).unwrap_or(Value::Null)})) // read-only: tx dropped, never committed
        }
        Db::GetByKey(p) => {
            let row = tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY, &[&p.company_id, &p.request_key]).await.map_err(pre)?;
            Step::Done(json!({"decision": row.as_ref().map(decision_json).unwrap_or(Value::Null)})) // read-only: tx dropped, never committed
        }
        Db::Create(p) => {
            let inserted = tx.query_opt(SQL_CREATE_OPERATOR_DECISION, &[&p.company_id, &p.request_key, &p.request_hash, &SCHEMA_VERSION, &p.priority.as_str(), &p.interaction_type.as_str(), &p.title, &p.description, &p.source_type, &p.source_id, &p.source_context, &p.issue_id, &p.requested_by_agent_id, &p.requested_by_user_id, &p.definition, &p.continuation_mode.as_str(), &p.quality_action_id, &p.quality_binding]).await.map_err(pre)?;
            let v = match inserted {
                Some(r) => json!({"created":true,"decision":decision_json(&r)}),
                None => {
                    let Some(r) = tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY, &[&p.company_id, &p.request_key]).await.map_err(pre)? else { return Err(DBERR) };
                    let hash: String = r.try_get(5).map_err(pre)?;
                    if hash == p.request_hash { json!({"created":false,"replayed":true,"decision":decision_json(&r)}) } else { json!({"created":false,"conflict":"request_key"}) }
                }
            };
            Step::Commit(tx, v)
        }
        Db::Resolve(p) => {
            let updated = tx.query_opt(SQL_RESOLVE_OPERATOR_DECISION_FENCED, &[&p.decision_id, &p.company_id, &p.result, &p.resolved_by_user_id]).await.map_err(pre)?;
            let v = match updated {
                Some(r) => json!({"resolved":true,"decision":decision_json(&r)}),
                None => match tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_ID, &[&p.decision_id, &p.company_id]).await.map_err(pre)? {
                    Some(r) => json!({"resolved":false,"decision":decision_json(&r)}),
                    None => json!({"resolved":false,"decision":Value::Null}),
                },
            };
            Step::Commit(tx, v)
        }
        Db::Cancel(p) => {
            let updated = tx.query_opt(SQL_CANCEL_OPERATOR_DECISION_FENCED, &[&p.decision_id, &p.company_id]).await.map_err(pre)?;
            let v = match updated {
                Some(r) => json!({"cancelled":true,"decision":decision_json(&r)}),
                None => match tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_ID, &[&p.decision_id, &p.company_id]).await.map_err(pre)? {
                    Some(r) => json!({"cancelled":false,"decision":decision_json(&r)}),
                    None => json!({"cancelled":false,"decision":Value::Null}),
                },
            };
            Step::Commit(tx, v)
        }
    })
}

/// Strict fail-closed gates: params must match the method schema exactly
/// (-32602), and domain invariants are revalidated before any PG I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "decision.list" => { let p = need!(ListP); if !(1..=200).contains(&p.limit) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "decision.get_by_id" => { let p = need!(GetByIdP); exec_db(id, env, OP_TIMEOUT, Db::GetById(p)) }
        "decision.get_by_request_key" => { let p = need!(GetByKeyP); if validate_request_key(&p.request_key).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::GetByKey(p)) }
        "decision.create" => { let p = need!(CreateP); if validate_request_key(&p.request_key).is_err() || validate_request_hash(&p.request_hash).is_err() || validate_title(&p.title).is_err() || validate_source(&p.source_type, &p.source_id).is_err() || validate_object_field("source_context", &p.source_context).is_err() || validate_object_field("definition", &p.definition).is_err() || validate_optional_object_field("quality_binding", p.quality_binding.as_ref()).is_err() || validate_quality_continuation(p.quality_action_id, p.continuation_mode).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Create(Box::new(p))) }
        "decision.resolve" => { let p = need!(ResolveP); if validate_object_field("result", &p.result).is_err() || validate_resolved_by(&p.resolved_by_user_id).is_err() { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Resolve(p)) }
        "decision.cancel" => { let p = need!(CancelP); exec_db(id, env, OP_TIMEOUT, Db::Cancel(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn create(u: Uuid) -> Value { json!({"company_id":u,"request_key":"rk","request_hash":"rh","priority":"medium","interaction_type":"single_select","title":"t","description":"d","source_type":"test","source_id":"s","source_context":{},"definition":{},"continuation_mode":"none"}) }
    fn resolve(u: Uuid) -> Value { json!({"decision_id":u,"company_id":u,"result":{},"resolved_by_user_id":"u"}) }
    fn valid() -> [( &'static str, Value); 6] { let u = Uuid::nil(); [
        ("decision.list", json!({"company_id":u,"limit":20})),
        ("decision.get_by_id", json!({"decision_id":u,"company_id":u})),
        ("decision.get_by_request_key", json!({"company_id":u,"request_key":"rk"})),
        ("decision.create", create(u)), ("decision.resolve", resolve(u)),
        ("decision.cancel", json!({"decision_id":u,"company_id":u})), ] }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let (e, u) = (env(""), Uuid::nil());
        for p in [json!(null), json!([]), json!("x")] { assert_eq!(code(&call("decision.list", p, &e)), -32602); }
        assert_eq!(code(&dispatch_with(json!(1), "decision.list", None, &e)), -32602); // missing params
        let mut extra = create(u); extra["x"] = json!(1);
        let mut wrong = resolve(u); wrong["decision_id"] = json!("not-a-uuid");
        assert_eq!(code(&call("decision.create", extra, &e)), -32602);
        assert_eq!(code(&call("decision.resolve", wrong, &e)), -32602);
        for (field, bad) in [("priority", "urgent"), ("interaction_type", "multi"), ("continuation_mode", "always")] {
            let mut p = create(u); p[field] = json!(bad); assert_eq!(code(&call("decision.create", p, &e)), -32602, "{field}"); }
        let mut p = json!({"company_id":u,"status":"open","limit":20}); assert_eq!(code(&call("decision.list", p.clone(), &e)), -32602);
        p["status"] = json!("pending"); assert_eq!(code(&call("decision.list", p, &e)), -32002);
    }

    #[test]
    fn pre_io_rejection_ordering_before_db_config() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves gates precede DSN checks
        for limit in [0, 201, -5] { assert_eq!(code(&call("decision.list", json!({"company_id":u,"limit":limit}), &none)), -32602, "{limit}"); }
        for key in ["", "   "] { assert_eq!(code(&call("decision.get_by_request_key", json!({"company_id":u,"request_key":key}), &none)), -32602); }
        let mut quality = create(u); quality["quality_action_id"] = json!(u); quality["continuation_mode"] = json!("issue_current_assignee");
        assert_eq!(code(&call("decision.create", quality, &none)), -32602);
        for (field, method) in [("source_context", "decision.create"), ("definition", "decision.create")] {
            let mut p = create(u); p[field] = json!([]); assert_eq!(code(&call(method, p, &none)), -32602, "{field}"); }
        let mut r = resolve(u); r["result"] = json!([]); assert_eq!(code(&call("decision.resolve", r, &none)), -32602);
        let mut r = resolve(u); r["resolved_by_user_id"] = json!(" \t"); assert_eq!(code(&call("decision.resolve", r, &none)), -32602);
        for (m, p) in valid() { assert_eq!(code(&call(m, p, &none)), -32002, "{m}"); }
    }

    #[test]
    fn db_unconfigured_for_all_methods() {
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in valid() { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn object_gates_and_unknown_method_and_capabilities() {
        let (e, u) = (env(""), Uuid::nil());
        for bad in [json!([]), json!("x"), json!(5)] {
            let mut p = create(u); p["quality_binding"] = bad.clone(); assert_eq!(code(&call("decision.create", p, &e)), -32602); }
        let mut p = create(u); p["quality_binding"] = json!(null); assert_eq!(code(&call("decision.create", p, &e)), -32002);
        assert_eq!(code(&call("decision.nope", json!({}), &e)), -32601);
        assert_eq!(code(&call("decision.", json!({}), &e)), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &e)["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["decision.list", "decision.get_by_id", "decision.get_by_request_key", "decision.create", "decision.resolve", "decision.cancel"] {
            assert_eq!(caps.iter().filter(|c| **c == json!(m)).count(), 1, "{m}"); }
    }
}

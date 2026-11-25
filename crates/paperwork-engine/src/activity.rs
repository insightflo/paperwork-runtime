#![forbid(unsafe_code)]
//! activity.* JSON-RPC methods: company-scoped activity_log append/list and
//! operator_decisions list/fenced-resolve. All PG I/O reuses heartbeat.rs's
//! hardened direct-PG path (exec_db): loopback-only DSN apply-or-reject, DNS
//! permit cap, deadline-gated commit (-32001..-32005), driver abort. Param
//! gates are fail-closed: non-object params or schema mismatch => -32602;
//! empty actor/resolver fields and non-object details/result rejected pre-I/O.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_activity::{clamp_list_limit, ActorType, ActivityEventRow, OperatorDecisionRow, OperatorDecisionStatus, SQL_APPEND_ACTIVITY_EVENT, SQL_LIST_ACTIVITY_EVENTS, SQL_LIST_OPERATOR_DECISIONS, SQL_RESOLVE_OPERATOR_DECISION_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct AppendP { company_id: Uuid, actor_type: ActorType, actor_id: String, action: String, entity_type: String, entity_id: String, #[serde(default)] agent_id: Option<Uuid>, #[serde(default)] run_id: Option<Uuid>, #[serde(default)] details: Option<Value> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListEventsP { company_id: Uuid, #[serde(default)] agent_id: Option<Uuid>, #[serde(default)] entity_type: Option<String>, #[serde(default)] entity_id: Option<String>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListDecisionsP { company_id: Uuid, #[serde(default)] status: Option<OperatorDecisionStatus>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResolveP { operator_decision_id: Uuid, company_id: Uuid, resolved_by_user_id: String, result: Value }

enum Db { Append(AppendP), Events(ListEventsP), Decisions(ListDecisionsP), Resolve(ResolveP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

// Column order matches the crate's RETURNING lists (queries.rs, private decoders):
// 0 id, 1 company_id, 2 actor_type, 3 actor_id, 4 action, 5 entity_type,
// 6 entity_id, 7 agent_id, 8 run_id, 9 details, 10 created_at
fn to_event(r: &Row) -> Result<ActivityEventRow, Fail> {
    let s: String = r.get(2);
    Ok(ActivityEventRow { id: r.get(0), company_id: r.get(1), actor_type: ActorType::parse(&s).map_err(|_| DBERR)?, actor_id: r.get(3), action: r.get(4), entity_type: r.get(5), entity_id: r.get(6), agent_id: r.get(7), run_id: r.get(8), details: r.get(9), created_at: r.get(10) })
}
fn event_json(r: ActivityEventRow) -> Value { json!({"id": r.id, "company_id": r.company_id, "actor_type": r.actor_type.as_str(), "actor_id": r.actor_id, "action": r.action, "entity_type": r.entity_type, "entity_id": r.entity_id, "agent_id": r.agent_id, "run_id": r.run_id, "details": r.details, "created_at": r.created_at}) }
// 0 id, 1 company_id, 2 quality_action_id, 3 quality_binding, 4 request_key,
// 5 request_hash, 6 schema_version, 7 status, 8 priority, 9 interaction_type,
// 10 title, 11 description, 12 source_type, 13 source_id, 14 source_context,
// 15 issue_id, 16 requested_by_agent_id, 17 requested_by_user_id, 18 definition,
// 19 result, 20 resolved_by_user_id, 21 resolved_at, 22 cancelled_at,
// 23 continuation_mode, 24 created_at, 25 updated_at
fn to_decision(r: &Row) -> Result<OperatorDecisionRow, Fail> {
    let s: String = r.get(7);
    Ok(OperatorDecisionRow { id: r.get(0), company_id: r.get(1), quality_action_id: r.get(2), quality_binding: r.get(3), request_key: r.get(4), request_hash: r.get(5), schema_version: r.get(6), status: OperatorDecisionStatus::parse(&s).map_err(|_| DBERR)?, priority: r.get(8), interaction_type: r.get(9), title: r.get(10), description: r.get(11), source_type: r.get(12), source_id: r.get(13), source_context: r.get(14), issue_id: r.get(15), requested_by_agent_id: r.get(16), requested_by_user_id: r.get(17), definition: r.get(18), result: r.get(19), resolved_by_user_id: r.get(20), resolved_at: r.get(21), cancelled_at: r.get(22), continuation_mode: r.get(23), created_at: r.get(24), updated_at: r.get(25) })
}
fn decision_json(r: OperatorDecisionRow) -> Value { json!({"id": r.id, "company_id": r.company_id, "quality_action_id": r.quality_action_id, "quality_binding": r.quality_binding, "request_key": r.request_key, "request_hash": r.request_hash, "schema_version": r.schema_version, "status": r.status.as_str(), "priority": r.priority, "interaction_type": r.interaction_type, "title": r.title, "description": r.description, "source_type": r.source_type, "source_id": r.source_id, "source_context": r.source_context, "issue_id": r.issue_id, "requested_by_agent_id": r.requested_by_agent_id, "requested_by_user_id": r.requested_by_user_id, "definition": r.definition, "result": r.result, "resolved_by_user_id": r.resolved_by_user_id, "resolved_at": r.resolved_at, "cancelled_at": r.cancelled_at, "continuation_mode": r.continuation_mode, "created_at": r.created_at, "updated_at": r.updated_at}) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Append(p) => {
            let row = tx.query_one(SQL_APPEND_ACTIVITY_EVENT, &[&p.company_id, &p.actor_type.as_str(), &p.actor_id, &p.action, &p.entity_type, &p.entity_id, &p.agent_id, &p.run_id, &p.details]).await.map_err(pre)?;
            Step::Commit(tx, json!({"event": event_json(to_event(&row)?)}))
        }
        Db::Events(p) => {
            let rows = tx.query(SQL_LIST_ACTIVITY_EVENTS, &[&p.company_id, &p.agent_id, &p.entity_type, &p.entity_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let events = rows.iter().map(|r| to_event(r).map(event_json)).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"events": events})) // read-only: tx dropped, never committed
        }
        Db::Decisions(p) => {
            let status = p.status.map(|s| s.as_str());
            let rows = tx.query(SQL_LIST_OPERATOR_DECISIONS, &[&p.company_id, &status, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let decisions = rows.iter().map(|r| to_decision(r).map(decision_json)).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"operator_decisions": decisions})) // read-only: tx dropped, never committed
        }
        Db::Resolve(p) => {
            let updated = tx.query_opt(SQL_RESOLVE_OPERATOR_DECISION_FENCED, &[&p.operator_decision_id, &p.company_id, &p.result, &p.resolved_by_user_id]).await.map_err(pre)?.map(|r| to_decision(&r)).transpose()?;
            Step::Commit(tx, match updated { Some(d) => json!({"updated": true, "operator_decision": decision_json(d)}), None => json!({"updated": false}) })
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Empty actor/resolver strings and non-object
/// details/result payloads are rejected before any PG I/O (crate's own guards).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "activity.append_event" => {
            let p = need!(AppendP);
            if [p.actor_id.trim(), p.action.trim(), p.entity_type.trim(), p.entity_id.trim()].iter().any(|s| s.is_empty()) || matches!(&p.details, Some(d) if !d.is_object()) { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Append(p))
        }
        "activity.list_events" => { let p = need!(ListEventsP); exec_db(id, env, OP_TIMEOUT, Db::Events(p)) }
        "activity.list_operator_decisions" => { let p = need!(ListDecisionsP); exec_db(id, env, OP_TIMEOUT, Db::Decisions(p)) }
        "activity.resolve_operator_decision_fenced" => {
            let p = need!(ResolveP);
            if p.resolved_by_user_id.trim().is_empty() || !p.result.is_object() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Resolve(p))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn append(u: Uuid, extra: &[(&str, Value)]) -> Value {
        let mut o = json!({"company_id":u,"actor_type":"agent","actor_id":"a1","action":"x.y","entity_type":"issue","entity_id":"I-1"});
        for (k, v) in extra { o.as_object_mut().unwrap().insert(k.to_string(), v.clone()); }
        o
    }

    #[test]
    fn param_shape_matrix_and_pre_io_gates() {
        let (u, e) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL
        for (m, p) in [
            ("activity.append_event", json!({})),
            ("activity.append_event", json!([])),
            ("activity.append_event", append(u, &[("x", json!(1))])),
            ("activity.append_event", append(u, &[("actor_type", json!("ghost"))])),
            ("activity.append_event", json!({"company_id":u,"actor_type":"agent","actor_id":"a","action":"x","entity_type":"issue"})),
            ("activity.list_events", json!({"company_id":u})),
            ("activity.list_events", json!({"company_id":u,"limit":1,"x":0})),
            ("activity.list_events", json!({"company_id":u,"agent_id":"nope","limit":1})),
            ("activity.list_operator_decisions", json!({"company_id":u})),
            ("activity.list_operator_decisions", json!({"company_id":u,"status":"bogus","limit":1})),
            ("activity.resolve_operator_decision_fenced", json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1"})),
            ("activity.resolve_operator_decision_fenced", json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1","result":{},"z":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // Empty/whitespace actor fields and non-object details: -32602 pre-I/O, not -32002.
        for (k, bad) in [("actor_id", " "), ("action", ""), ("entity_type", "\t"), ("entity_id", "  ")] {
            assert_eq!(code(&call("activity.append_event", append(u, &[(k, json!(bad))]), &e)), -32602, "{k}"); }
        for bad in [json!([1]), json!("s"), json!(5)] {
            assert_eq!(code(&call("activity.append_event", append(u, &[("details", bad.clone())]), &e)), -32602, "{bad}"); }
        for p in [
            json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"","result":{}}),
            json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":" \t","result":{}}),
            json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1","result":null}),
            json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1","result":[1]}),
            json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1","result":"s"}),
        ] { assert_eq!(code(&call("activity.resolve_operator_decision_fenced", p, &e)), -32602, "pre-io"); }
        assert_eq!(code(&dispatch_with(json!(1), "activity.append_event", None, &e)), -32602);
        assert_eq!(code(&call("activity.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("activity.append_event", append(u, &[])),
                ("activity.append_event", append(u, &[("agent_id", json!(u)), ("run_id", json!(u)), ("details", json!({"k":1}))])),
                ("activity.append_event", append(u, &[("details", Value::Null)])),
                ("activity.list_events", json!({"company_id":u,"limit":10})),
                ("activity.list_events", json!({"company_id":u,"agent_id":u,"entity_type":"issue","entity_id":"I-1","limit":0})),
                ("activity.list_operator_decisions", json!({"company_id":u,"limit":10})),
                ("activity.list_operator_decisions", json!({"company_id":u,"status":"pending","limit":10})),
                ("activity.resolve_operator_decision_fenced", json!({"operator_decision_id":u,"company_id":u,"resolved_by_user_id":"u1","result":{"outcome":"approve"}})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn row_mappers_emit_full_json_shape() {
        let t = DateTime::<Utc>::from_timestamp(0, 0).unwrap();
        let e = event_json(ActivityEventRow { id: Uuid::from_u128(1), company_id: Uuid::from_u128(2), actor_type: ActorType::Board, actor_id: "op".into(), action: "a.b".into(), entity_type: "issue".into(), entity_id: "I-1".into(), agent_id: None, run_id: None, details: None, created_at: t });
        assert_eq!((e["actor_type"].as_str().unwrap(), e.as_object().unwrap().len()), ("board", 11));
        let d = decision_json(OperatorDecisionRow { id: Uuid::from_u128(3), company_id: Uuid::from_u128(2), quality_action_id: None, quality_binding: None, request_key: "k".into(), request_hash: "h".into(), schema_version: 1, status: OperatorDecisionStatus::Pending, priority: "medium".into(), interaction_type: "action".into(), title: "t".into(), description: "d".into(), source_type: "s".into(), source_id: "sid".into(), source_context: json!({}), issue_id: None, requested_by_agent_id: Some(Uuid::from_u128(4)), requested_by_user_id: None, definition: json!({"x":1}), result: None, resolved_by_user_id: None, resolved_at: None, cancelled_at: None, continuation_mode: "resume".into(), created_at: t, updated_at: t });
        assert_eq!((d["status"].as_str().unwrap(), d.as_object().unwrap().len()), ("pending", 26));
        assert_eq!(d["requested_by_agent_id"], json!(Uuid::from_u128(4)));
    }

    #[test]
    fn health_lists_activity_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["activity.append_event", "activity.list_events", "activity.list_operator_decisions", "activity.resolve_operator_decision_fenced"] {
            assert!(caps.contains(&m), "missing {m}"); }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"activity.list_events","params":{"company_id":"00000000-0000-0000-0000-000000000000","limit":5}}"#, &env(""));
        assert_eq!(code(&r), -32002); // routed to exec_db; unconfigured fail-closed
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"activity.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

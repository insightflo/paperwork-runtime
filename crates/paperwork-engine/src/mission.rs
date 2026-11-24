#![forbid(unsafe_code)]
//! mission.* JSON-RPC methods: company-scoped mission get/list, rolling-state
//! get, session listing, and fenced status/revision writes. All PG I/O reuses
//! heartbeat.rs's hardened direct-PG path (exec_db): loopback-only DSN
//! apply-or-reject, DNS permit cap, deadline-gated commit (-32001..-32005),
//! driver abort. Param gates are fail-closed: non-object params or schema
//! mismatch => -32602; fenced ops re-validate before any PG I/O.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_mission::{clamp_list_limit, mission_transition_plan, validate_bump_revision, validate_mission_transition, MissionRollingStateRow, MissionRow, MissionSessionRow, MissionStatus, SQL_BUMP_MISSION_ROLLING_STATE_FENCED, SQL_GET_MISSION, SQL_GET_MISSION_ROLLING_STATE, SQL_LIST_MISSIONS_BY_COMPANY, SQL_LIST_MISSION_SESSIONS, SQL_TRANSITION_MISSION_STATUS_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetP { mission_id: Uuid, company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default)] status: Option<MissionStatus>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionP { mission_id: Uuid, company_id: Uuid, expected_status: MissionStatus, next_status: MissionStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct BumpP { mission_id: Uuid, company_id: Uuid, expected_revision: i32, state_json: Value, state_markdown: String }

enum Db { Get(GetP), List(ListP), Rolling(GetP), Sessions(GetP), Transition(TransitionP), Bump(BumpP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn to_mission(r: &Row) -> Result<MissionRow, Fail> {
    let s: String = r.get(5);
    Ok(MissionRow { id: r.get(0), company_id: r.get(1), owner_agent_id: r.get(2), title: r.get(3), description: r.get(4), status: MissionStatus::parse(&s).map_err(|_| DBERR)?, goal_id: r.get(6), project_id: r.get(7), source_mission_id: r.get(8), source_workflow_run_id: r.get(9), started_at: r.get(10), completed_at: r.get(11), created_at: r.get(12), updated_at: r.get(13) })
}
fn to_rolling(r: &Row) -> MissionRollingStateRow { MissionRollingStateRow { id: r.get(0), company_id: r.get(1), mission_id: r.get(2), revision: r.get(3), status: r.get(4), state_markdown: r.get(5), state_json: r.get(6), last_run_id: r.get(7), last_compacted_at: r.get(8), total_runs: r.get(9), total_input_tokens: r.get(10), total_output_tokens: r.get(11), total_cost_cents: r.get(12), created_at: r.get(13), updated_at: r.get(14) } }
fn to_session(r: &Row) -> MissionSessionRow { MissionSessionRow { id: r.get(0), mission_id: r.get(1), agent_id: r.get(2), company_id: r.get(3), session_secret_id: r.get(4), adapter_type: r.get(5), status: r.get(6), last_active_at: r.get(7), run_count: r.get(8), expires_at: r.get(9), created_at: r.get(10) } }
fn mission_json(r: &MissionRow) -> Value { json!({"id": r.id, "company_id": r.company_id, "owner_agent_id": r.owner_agent_id, "title": r.title, "description": r.description, "status": r.status.as_str(), "goal_id": r.goal_id, "project_id": r.project_id, "source_mission_id": r.source_mission_id, "source_workflow_run_id": r.source_workflow_run_id, "started_at": r.started_at, "completed_at": r.completed_at, "created_at": r.created_at, "updated_at": r.updated_at}) }
fn rolling_json(r: &MissionRollingStateRow) -> Value { json!({"id": r.id, "company_id": r.company_id, "mission_id": r.mission_id, "revision": i64::from(r.revision), "status": r.status, "state_markdown": r.state_markdown, "state_json": r.state_json, "last_run_id": r.last_run_id, "last_compacted_at": r.last_compacted_at, "total_runs": i64::from(r.total_runs), "total_input_tokens": r.total_input_tokens, "total_output_tokens": r.total_output_tokens, "total_cost_cents": r.total_cost_cents, "created_at": r.created_at, "updated_at": r.updated_at}) }
fn session_json(r: &MissionSessionRow) -> Value { json!({"id": r.id, "mission_id": r.mission_id, "agent_id": r.agent_id, "company_id": r.company_id, "session_secret_id": r.session_secret_id, "adapter_type": r.adapter_type, "status": r.status, "last_active_at": r.last_active_at, "run_count": r.run_count, "expires_at": r.expires_at, "created_at": r.created_at}) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Get(p) => {
            let row = tx.query_opt(SQL_GET_MISSION, &[&p.mission_id, &p.company_id]).await.map_err(pre)?.map(|r| to_mission(&r)).transpose()?;
            Step::Done(json!({"mission": row.map(|r| mission_json(&r))})) // read-only: tx dropped, never committed
        }
        Db::List(p) => {
            let status = p.status.map(|s| s.as_str());
            let rows = tx.query(SQL_LIST_MISSIONS_BY_COMPANY, &[&p.company_id, &status, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let missions = rows.iter().map(|r| to_mission(r).map(|m| mission_json(&m))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"missions": missions})) // read-only: tx dropped, never committed
        }
        Db::Rolling(p) => {
            let row = tx.query_opt(SQL_GET_MISSION_ROLLING_STATE, &[&p.mission_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(json!({"rolling_state": row.map(|r| rolling_json(&to_rolling(&r)))})) // read-only: tx dropped, never committed
        }
        Db::Sessions(p) => {
            let rows = tx.query(SQL_LIST_MISSION_SESSIONS, &[&p.mission_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(json!({"sessions": rows.iter().map(|r| session_json(&to_session(r))).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
        Db::Transition(p) => {
            validate_mission_transition(p.expected_status, p.next_status).map_err(|_| DBERR)?;
            let plan = mission_transition_plan(p.next_status);
            let row = tx.query_opt(SQL_TRANSITION_MISSION_STATUS_FENCED, &[&p.mission_id, &p.company_id, &p.next_status.as_str(), &plan.sets_started_at, &plan.sets_completed_at, &p.expected_status.as_str()]).await.map_err(pre)?.map(|r| to_mission(&r)).transpose()?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied": true, "mission": mission_json(&r)}),
                None => json!({"applied": false}) })
        }
        Db::Bump(p) => {
            let expected = validate_bump_revision(p.expected_revision).map_err(|_| DBERR)?;
            let row = tx.query_opt(SQL_BUMP_MISSION_ROLLING_STATE_FENCED, &[&p.mission_id, &p.company_id, &expected, &p.state_json, &p.state_markdown]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied": true, "rolling_state": rolling_json(&to_rolling(&r))}),
                None => json!({"applied": false}) })
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Fenced ops re-validate before any PG I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "mission.get" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Get(p)) }
        "mission.list_by_company" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "mission.get_rolling_state" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Rolling(p)) }
        "mission.list_sessions" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Sessions(p)) }
        "mission.transition_status_fenced" => {
            let p = need!(TransitionP);
            if validate_mission_transition(p.expected_status, p.next_status).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Transition(p))
        }
        "mission.bump_rolling_state_fenced" => {
            let p = need!(BumpP);
            if validate_bump_revision(p.expected_revision).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Bump(p))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }

    #[test]
    fn param_gates_and_unknown_method() {
        let (u, e) = (Uuid::nil(), env(""));
        for (m, p) in [
            ("mission.get", json!([])),
            ("mission.get", json!({})),
            ("mission.get", json!({"mission_id":u})),
            ("mission.get", json!({"mission_id":u,"company_id":u,"x":0})),
            ("mission.list_by_company", json!({"company_id":u})),
            ("mission.list_by_company", json!({"company_id":u,"status":"bogus","limit":10})),
            ("mission.list_by_company", json!({"company_id":u,"limit":10,"y":1})),
            ("mission.get_rolling_state", json!({"company_id":u})),
            ("mission.list_sessions", json!({"mission_id":u,"company_id":u,"z":2})),
            ("mission.transition_status_fenced", json!({"mission_id":u,"company_id":u,"expected_status":"active"})),
            ("mission.transition_status_fenced", json!({"mission_id":u,"company_id":u,"expected_status":"active","next_status":"bogus"})),
            ("mission.bump_rolling_state_fenced", json!({"mission_id":u,"company_id":u,"expected_revision":1,"state_json":{},"state_markdown":"s","w":0})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        assert_eq!(code(&dispatch_with(json!(1), "mission.get", None, &e)), -32602);
        assert_eq!(code(&call("mission.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn fenced_validation_fires_before_pg_io() {
        let (u, e) = (Uuid::nil(), env(""));
        // -32602 with an empty DATABASE_URL proves rejection happened before any PG I/O.
        for (m, p) in [
            ("mission.transition_status_fenced", json!({"mission_id":u,"company_id":u,"expected_status":"active","next_status":"active"})),
            ("mission.bump_rolling_state_fenced", json!({"mission_id":u,"company_id":u,"expected_revision":0,"state_json":{},"state_markdown":"s"})),
            ("mission.bump_rolling_state_fenced", json!({"mission_id":u,"company_id":u,"expected_revision":-1,"state_json":{},"state_markdown":"s"})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
    }

    #[test]
    fn db_unconfigured_gate_for_all_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("mission.get", json!({"mission_id":u,"company_id":u})),
                ("mission.list_by_company", json!({"company_id":u,"limit":10})),
                ("mission.get_rolling_state", json!({"mission_id":u,"company_id":u})),
                ("mission.list_sessions", json!({"mission_id":u,"company_id":u})),
                ("mission.transition_status_fenced", json!({"mission_id":u,"company_id":u,"expected_status":"planning","next_status":"active"})),
                ("mission.bump_rolling_state_fenced", json!({"mission_id":u,"company_id":u,"expected_revision":1,"state_json":{},"state_markdown":"s"})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn list_by_company_status_filter_is_optional_and_parses() {
        let (u, e) = (Uuid::nil(), env(""));
        // Omitting status and each of the 5 statuses must parse (reach the DB gate => -32002).
        for p in [json!({"company_id":u,"limit":5}), json!({"company_id":u,"status":"planning","limit":5}),
                  json!({"company_id":u,"status":"active","limit":5}), json!({"company_id":u,"status":"completed","limit":5}),
                  json!({"company_id":u,"status":"cancelled","limit":5}), json!({"company_id":u,"status":"paused","limit":5})] {
            assert_eq!(code(&call("mission.list_by_company", p, &e)), -32002);
        }
    }

    #[test]
    fn health_lists_mission_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["mission.get", "mission.list_by_company", "mission.get_rolling_state", "mission.list_sessions", "mission.transition_status_fenced", "mission.bump_rolling_state_fenced"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"mission.get","params":{"mission_id":"00000000-0000-0000-0000-000000000000","company_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"mission.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

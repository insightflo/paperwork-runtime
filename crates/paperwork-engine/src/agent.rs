#![forbid(unsafe_code)]
//! agent.* JSON-RPC methods: company-scoped agent registry reads plus one
//! fenced status transition over the shared direct-PG path (exec_db):
//! loopback-only DSN apply-or-reject, DNS permit cap, deadline-gated commit
//! (-32001..-32005), driver abort. Param gates are fail-closed and run
//! before any PG I/O: non-object/positional params, unknown fields, and
//! wrong-typed or unknown status strings => -32602; a well-formed but
//! ILLEGAL transition (e.g. terminated -> idle) is also rejected pre-I/O via
//! engine-agent's validate_agent_transition. The domain crate's decode and
//! statement helpers are sync-postgres flavored and do not cross to
//! tokio-postgres, so the same SQL text is re-executed on the shared tokio
//! transaction and rows are decoded into the domain row structs.
//! Divergence vs TS agentsService.terminate: transition_status_fenced with
//! new_status=terminated performs ONLY the status transition; the
//! agent_api_keys revocation side effect stays in TS until a cutover wave.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_agent::{validate_agent_transition, AgentRow, AgentStatus, AgentTaskSessionRow, AgentToolGrantRow, SQL_GET_AGENT, SQL_LIST_AGENTS_BY_COMPANY, SQL_LIST_AGENT_TASK_SESSIONS, SQL_LIST_AGENT_TOOL_GRANTS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::{FromSql, ToSql}, Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);
const AGENT_COLUMNS: &str = "id, company_id, name, role, title, icon, status, reports_to, capabilities, adapter_type, adapter_config, agent_config, runtime_config, budget_monthly_cents, spent_monthly_cents, pause_reason, paused_at, permissions, last_heartbeat_at, metadata, created_at, updated_at";

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetP { company_id: Uuid, agent_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct MaybeAgentP { company_id: Uuid, #[serde(default)] agent_id: Option<Uuid> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionP { company_id: Uuid, agent_id: Uuid, expected_status: AgentStatus, new_status: AgentStatus, #[serde(default)] pause_reason: Option<String> }

enum Db { Get(GetP), List(ListP), Sessions(MaybeAgentP), Grants(MaybeAgentP), Transition(TransitionP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn to_agent(r: &Row) -> Result<AgentRow, Fail> { Ok(AgentRow {
    id: col(r, 0)?, company_id: col(r, 1)?, name: col(r, 2)?, role: col(r, 3)?, title: col(r, 4)?, icon: col(r, 5)?,
    status: AgentStatus::parse(&col::<String>(r, 6)?).map_err(|_| DBERR)?, reports_to: col(r, 7)?, capabilities: col(r, 8)?,
    adapter_type: col(r, 9)?, adapter_config: col(r, 10)?, agent_config: col(r, 11)?, runtime_config: col(r, 12)?,
    budget_monthly_cents: col(r, 13)?, spent_monthly_cents: col(r, 14)?, pause_reason: col(r, 15)?, paused_at: col(r, 16)?,
    permissions: col(r, 17)?, last_heartbeat_at: col(r, 18)?, metadata: col(r, 19)?, created_at: col(r, 20)?, updated_at: col(r, 21)? }) }
fn to_session(r: &Row) -> Result<AgentTaskSessionRow, Fail> { Ok(AgentTaskSessionRow {
    id: col(r, 0)?, company_id: col(r, 1)?, agent_id: col(r, 2)?, adapter_type: col(r, 3)?, task_key: col(r, 4)?,
    session_params_json: col(r, 5)?, session_display_id: col(r, 6)?, last_run_id: col(r, 7)?, last_error: col(r, 8)?,
    created_at: col(r, 9)?, updated_at: col(r, 10)? }) }
fn to_grant(r: &Row) -> Result<AgentToolGrantRow, Fail> { Ok(AgentToolGrantRow {
    id: col(r, 0)?, company_id: col(r, 1)?, agent_id: col(r, 2)?, tool_id: col(r, 3)?, granted_by: col(r, 4)?, created_at: col(r, 5)? }) }

fn agent_json(a: &AgentRow) -> Value { json!({
    "id": a.id, "company_id": a.company_id, "name": a.name, "role": a.role, "title": a.title, "icon": a.icon,
    "status": a.status.as_str(), "reports_to": a.reports_to, "capabilities": a.capabilities, "adapter_type": a.adapter_type,
    "adapter_config": a.adapter_config, "agent_config": a.agent_config, "runtime_config": a.runtime_config,
    "budget_monthly_cents": a.budget_monthly_cents, "spent_monthly_cents": a.spent_monthly_cents,
    "pause_reason": a.pause_reason, "paused_at": a.paused_at, "permissions": a.permissions,
    "last_heartbeat_at": a.last_heartbeat_at, "metadata": a.metadata, "created_at": a.created_at, "updated_at": a.updated_at }) }
fn session_json(s: &AgentTaskSessionRow) -> Value { json!({
    "id": s.id, "company_id": s.company_id, "agent_id": s.agent_id, "adapter_type": s.adapter_type, "task_key": s.task_key,
    "session_params_json": s.session_params_json, "session_display_id": s.session_display_id, "last_run_id": s.last_run_id,
    "last_error": s.last_error, "created_at": s.created_at, "updated_at": s.updated_at }) }
fn grant_json(g: &AgentToolGrantRow) -> Value { json!({
    "id": g.id, "company_id": g.company_id, "agent_id": g.agent_id, "tool_id": g.tool_id, "granted_by": g.granted_by, "created_at": g.created_at }) }
fn applied_json(o: Option<AgentRow>) -> Value { match o { Some(a) => json!({"applied": true, "agent": agent_json(&a)}), None => json!({"applied": false, "reason": "fenced"}) } }

/// Byte-parity mirror of engine-agent's private transition_statement: $1
/// company, $2 agent, $3 expected status, $4 new status; $5 pause_reason is
/// declared in the text and bound in the params ONLY when the target is
/// paused, so text and bound-param count are built together.
fn transition_statement(target: AgentStatus) -> (String, usize) {
    let (side_columns, params) = if target == AgentStatus::Paused {
        ("pause_reason = COALESCE($5, 'manual'), paused_at = now()", 5)
    } else {
        ("pause_reason = NULL, paused_at = NULL", 4)
    };
    (format!("UPDATE agents SET status = $4, updated_at = now(), {side_columns} WHERE company_id = $1 AND id = $2 AND status = $3 RETURNING {AGENT_COLUMNS}"), params)
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Get(p) => {
            let agent = tx.query_opt(SQL_GET_AGENT, &[&p.company_id, &p.agent_id]).await.map_err(pre)?.map(|r| to_agent(&r)).transpose()?;
            Step::Done(json!({"agent": agent.map(|a| agent_json(&a))})) // read-only: tx dropped, never committed
        }
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_AGENTS_BY_COMPANY, &[&p.company_id]).await.map_err(pre)?;
            let agents = rows.iter().map(|r| to_agent(r).map(|a| agent_json(&a))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"agents": agents})) // read-only: tx dropped, never committed
        }
        Db::Sessions(p) => {
            let rows = tx.query(SQL_LIST_AGENT_TASK_SESSIONS, &[&p.company_id, &p.agent_id]).await.map_err(pre)?;
            let sessions = rows.iter().map(|r| to_session(r).map(|s| session_json(&s))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"sessions": sessions})) // read-only: tx dropped, never committed
        }
        Db::Grants(p) => {
            let rows = tx.query(SQL_LIST_AGENT_TOOL_GRANTS, &[&p.company_id, &p.agent_id]).await.map_err(pre)?;
            let grants = rows.iter().map(|r| to_grant(r).map(|g| grant_json(&g))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"grants": grants})) // read-only: tx dropped, never committed
        }
        Db::Transition(p) => {
            let (sql, n) = transition_statement(p.new_status);
            let (from, to) = (p.expected_status.as_str(), p.new_status.as_str());
            let mut params: Vec<&(dyn ToSql + Sync)> = Vec::with_capacity(n);
            params.push(&p.company_id); params.push(&p.agent_id); params.push(&from); params.push(&to);
            if n == 5 { params.push(&p.pause_reason); }
            debug_assert_eq!(params.len(), n);
            let row = tx.query_opt(&sql, &params).await.map_err(pre)?.map(|r| to_agent(&r)).transpose()?;
            Step::Commit(tx, applied_json(row))
        }
    })
}

/// Strict fail-closed gates run before any PG I/O: params must be a JSON
/// object matching the method schema exactly (-32602);
/// transition_status_fenced re-validates the legality matrix pre-I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "agent.get" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Get(p)) }
        "agent.list_by_company" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "agent.list_task_sessions" => { let p = need!(MaybeAgentP); exec_db(id, env, OP_TIMEOUT, Db::Sessions(p)) }
        "agent.list_tool_grants" => { let p = need!(MaybeAgentP); exec_db(id, env, OP_TIMEOUT, Db::Grants(p)) }
        "agent.transition_status_fenced" => {
            let p = need!(TransitionP);
            if validate_agent_transition(p.expected_status, p.new_status).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Transition(p))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ALL: [AgentStatus; 7] = [AgentStatus::Active, AgentStatus::Paused, AgentStatus::Idle, AgentStatus::Running, AgentStatus::Error, AgentStatus::PendingApproval, AgentStatus::Terminated];
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: &Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }

    #[test]
    fn param_gates_and_unknown_method() {
        let (u, e) = (Uuid::nil(), env(""));
        let tp = |extra: &[(&str, Value)]| {
            let mut o = serde_json::Map::from_iter([("company_id".into(), json!(u)), ("agent_id".into(), json!(u)), ("expected_status".into(), json!("idle")), ("new_status".into(), json!("paused"))]);
            for (k, v) in extra { o.insert((*k).into(), v.clone()); }
            Value::Object(o)
        };
        for (m, p) in [
            ("agent.get", json!([])), ("agent.get", json!({})), ("agent.get", json!({"company_id":u})),
            ("agent.get", json!({"company_id":u,"agent_id":u,"x":0})), ("agent.get", json!({"company_id":1,"agent_id":u})),
            ("agent.list_by_company", json!([])), ("agent.list_by_company", json!({"company_id":"nope"})),
            ("agent.list_by_company", json!({"company_id":u,"y":1})),
            ("agent.list_task_sessions", json!({})), ("agent.list_task_sessions", json!({"company_id":u,"agent_id":1})),
            ("agent.list_task_sessions", json!({"company_id":u,"z":2})),
            ("agent.list_tool_grants", json!([])), ("agent.list_tool_grants", json!({"company_id":u,"w":3})),
            ("agent.transition_status_fenced", json!({})), ("agent.transition_status_fenced", tp(&[("new_status", Value::Null)])),
            ("agent.transition_status_fenced", tp(&[("expected_status", json!("bogus"))])),
            ("agent.transition_status_fenced", tp(&[("new_status", json!("done"))])),
            ("agent.transition_status_fenced", tp(&[("expected_status", json!("terminated")), ("new_status", json!("idle"))])), // illegal, pre-I/O
            ("agent.transition_status_fenced", tp(&[("expected_status", json!("pending_approval")), ("new_status", json!("paused"))])), // gated source
            ("agent.transition_status_fenced", tp(&[("new_status", json!("idle"))])), // self-transition
            ("agent.transition_status_fenced", tp(&[("new_status", json!("pending_approval"))])), // gated target
            ("agent.transition_status_fenced", tp(&[("v", json!(1))])), // unknown field
        ] { assert_eq!(code(&call(m, &p, &e)), -32602, "{m} {p}"); }
        // -32602 with an empty DATABASE_URL proves rejection before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "agent.get", None, &e)), -32602);
        assert_eq!(code(&call("agent.nope", &json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_methods() {
        let u = Uuid::nil();
        let tp = |from: &str, to: &str| json!({"company_id":u,"agent_id":u,"expected_status":from,"new_status":to});
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("agent.get", json!({"company_id":u,"agent_id":u})),
                ("agent.list_by_company", json!({"company_id":u})),
                ("agent.list_task_sessions", json!({"company_id":u})), ("agent.list_task_sessions", json!({"company_id":u,"agent_id":u})),
                ("agent.list_tool_grants", json!({"company_id":u})), ("agent.list_tool_grants", json!({"company_id":u,"agent_id":u})),
                ("agent.transition_status_fenced", tp("idle", "paused")),
                ("agent.transition_status_fenced", tp("running", "terminated")),
                ("agent.transition_status_fenced", tp("pending_approval", "idle")),
            ] { assert_eq!(code(&call(m, &p, &e)), -32002, "{m}"); }
        }
    }

    // Byte-parity proof for all 7 targets: statement text, placeholder count,
    // and the $5/pause_reason binding rule match the domain crate exactly.
    #[test]
    fn transition_binds_match_placeholders_for_every_target() {
        let body = |side: &str| format!("UPDATE agents SET status = $4, updated_at = now(), {side} WHERE company_id = $1 AND id = $2 AND status = $3 RETURNING {AGENT_COLUMNS}");
        for target in ALL {
            let (sql, n) = transition_statement(target);
            let side = if target == AgentStatus::Paused { "pause_reason = COALESCE($5, 'manual'), paused_at = now()" } else { "pause_reason = NULL, paused_at = NULL" };
            assert_eq!(sql, body(side), "{target:?}");
            assert_eq!(sql.matches('$').count(), n, "{target:?}: {sql}");
            for i in 1..=n { assert!(sql.contains(&format!("${i}")), "{target:?}: {sql}"); }
            assert_eq!(sql.contains("$5"), target == AgentStatus::Paused, "{target:?}: {sql}");
        }
        // AGENT_COLUMNS is private in the domain crate; the exported read SQL
        // embeds it, so byte-equality there proves our copy is identical.
        assert_eq!(SQL_GET_AGENT, format!("SELECT {AGENT_COLUMNS} FROM agents WHERE company_id = $1 AND id = $2"));
        assert_eq!(SQL_LIST_AGENTS_BY_COMPANY, format!("SELECT {AGENT_COLUMNS} FROM agents WHERE company_id = $1 ORDER BY created_at ASC, id ASC"));
    }

    #[test]
    fn health_lists_agent_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["agent.get", "agent.list_by_company", "agent.list_task_sessions", "agent.list_tool_grants", "agent.transition_status_fenced"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"agent.list_by_company","params":{"company_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"agent.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

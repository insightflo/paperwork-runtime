#![forbid(unsafe_code)]
//! workflow.* JSON-RPC methods: run/step transition validation, pending-run
//! listing, and fenced run/step transitions. All PG I/O reuses heartbeat.rs's
//! hardened direct-PG path (exec_db): loopback-only DSN apply-or-reject, DNS
//! permit cap, deadline-gated commit (-32001..-32005), driver abort. Param
//! gates are fail-closed: non-object params or schema mismatch => -32602 and
//! illegal transitions are rejected before any PG I/O.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_workflow::{clamp_batch_limit, validate_run_transition, validate_step_transition, WorkflowDbError, WorkflowRunStatus, WorkflowStepStatus, SQL_LIST_PENDING_WORKFLOW_RUNS, SQL_LIST_STEP_RUNS_FOR_RUN, SQL_TRANSITION_STEP_RUN_FENCED, SQL_TRANSITION_WORKFLOW_RUN_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ValidateRunP { expected_statuses: Vec<WorkflowRunStatus>, next_status: WorkflowRunStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ValidateStepP { expected_statuses: Vec<WorkflowStepStatus>, next_status: WorkflowStepStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListPendingP { company_id: Uuid, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionRunP { run_id: Uuid, company_id: Uuid, expected_statuses: Vec<WorkflowRunStatus>, next_status: WorkflowRunStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionStepP { step_run_id: Uuid, workflow_run_id: Uuid, company_id: Uuid, expected_statuses: Vec<WorkflowStepStatus>, next_status: WorkflowStepStatus, expected_transition_version: i32 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListStepsP { company_id: Uuid, workflow_run_id: Uuid }

enum Db { ListPending(ListPendingP), TransitionRun(TransitionRunP), TransitionStep(TransitionStepP), ListSteps(ListStepsP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn pending_json(r: &Row) -> Value { json!({"id": r.get::<_, Uuid>(0), "workflow_id": r.get::<_, Uuid>(1), "company_id": r.get::<_, Uuid>(2), "mission_id": r.get::<_, Option<Uuid>>(3), "triggered_by": r.get::<_, String>(4), "created_at": r.get::<_, DateTime<Utc>>(5)}) }
fn step_json(r: &Row) -> Value { json!({"id": r.get::<_, Uuid>(0), "workflow_run_id": r.get::<_, Uuid>(1), "step_id": r.get::<_, String>(2), "status": r.get::<_, String>(3), "retry_count": r.get::<_, i32>(4), "status_transition_version": r.get::<_, i32>(5), "execution_generation": r.get::<_, i32>(6), "started_at": r.get::<_, Option<DateTime<Utc>>>(7), "completed_at": r.get::<_, Option<DateTime<Utc>>>(8)}) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::ListPending(p) => {
            let rows = tx.query(SQL_LIST_PENDING_WORKFLOW_RUNS, &[&p.company_id, &clamp_batch_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"runs": rows.iter().map(pending_json).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
        Db::TransitionRun(p) => {
            let plan = validate_run_transition(&p.expected_statuses, p.next_status).map_err(|_| DBERR)?;
            let exp: Vec<&str> = p.expected_statuses.iter().map(|s| s.as_str()).collect();
            let row = tx.query_opt(SQL_TRANSITION_WORKFLOW_RUN_FENCED, &[&p.run_id, &p.next_status.as_str(), &plan.sets_started_at, &plan.sets_completed_at, &p.company_id, &exp]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied":true,"run_id":r.get::<_, Uuid>(0),"status":r.get::<_, String>(1),"started_at":r.get::<_, Option<DateTime<Utc>>>(2),"completed_at":r.get::<_, Option<DateTime<Utc>>>(3)}),
                None => json!({"applied": false}) })
        }
        Db::TransitionStep(p) => {
            let plan = validate_step_transition(&p.expected_statuses, p.next_status).map_err(|_| DBERR)?;
            let exp: Vec<&str> = p.expected_statuses.iter().map(|s| s.as_str()).collect();
            let row = tx.query_opt(SQL_TRANSITION_STEP_RUN_FENCED, &[&p.step_run_id, &p.next_status.as_str(), &plan.sets_started_at, &plan.sets_completed_at, &p.workflow_run_id, &exp, &p.expected_transition_version, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied":true,"step_run_id":r.get::<_, Uuid>(0),"status":r.get::<_, String>(1),"status_transition_version":r.get::<_, i32>(2),"started_at":r.get::<_, Option<DateTime<Utc>>>(3),"completed_at":r.get::<_, Option<DateTime<Utc>>>(4)}),
                None => json!({"applied": false}) })
        }
        Db::ListSteps(p) => {
            let rows = tx.query(SQL_LIST_STEP_RUNS_FOR_RUN, &[&p.company_id, &p.workflow_run_id]).await.map_err(pre)?;
            Step::Done(json!({"steps": rows.iter().map(step_json).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
    })
}

fn run_validate_result(p: &ValidateRunP) -> Value {
    match validate_run_transition(&p.expected_statuses, p.next_status) {
        Ok(plan) => json!({"valid":true,"sets_started_at":plan.sets_started_at,"sets_completed_at":plan.sets_completed_at}),
        Err(WorkflowDbError::IllegalRunTransition { from, to }) => json!({"valid":false,"reason":"illegal_run_transition","from":from.as_str(),"to":to.as_str()}),
        Err(_) => Value::Null,
    }
}
fn step_validate_result(p: &ValidateStepP) -> Value {
    match validate_step_transition(&p.expected_statuses, p.next_status) {
        Ok(plan) => json!({"valid":true,"sets_started_at":plan.sets_started_at,"sets_completed_at":plan.sets_completed_at}),
        Err(WorkflowDbError::IllegalStepTransition { from, to }) => json!({"valid":false,"reason":"illegal_step_transition","from":from.as_str(),"to":to.as_str()}),
        Err(_) => Value::Null,
    }
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Fenced transitions re-validate before any PG I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "workflow.validate_run_transition" => {
            let p = need!(ValidateRunP);
            if p.expected_statuses.is_empty() { return err(id, -32602, "invalid_params") }
            ok(id, run_validate_result(&p))
        }
        "workflow.validate_step_transition" => {
            let p = need!(ValidateStepP);
            if p.expected_statuses.is_empty() { return err(id, -32602, "invalid_params") }
            ok(id, step_validate_result(&p))
        }
        "workflow.list_pending_runs" => { let p = need!(ListPendingP); exec_db(id, env, OP_TIMEOUT, Db::ListPending(p)) }
        "workflow.transition_run_fenced" => {
            let p = need!(TransitionRunP);
            if validate_run_transition(&p.expected_statuses, p.next_status).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::TransitionRun(p))
        }
        "workflow.transition_step_fenced" => {
            let p = need!(TransitionStepP);
            if validate_step_transition(&p.expected_statuses, p.next_status).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::TransitionStep(p))
        }
        "workflow.list_step_runs" => { let p = need!(ListStepsP); exec_db(id, env, OP_TIMEOUT, Db::ListSteps(p)) }
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
    fn validate_run_transition_matrix() {
        let v = |p: Value| call("workflow.validate_run_transition", p, &env(""));
        assert_eq!(v(json!({"expected_statuses":["pending"],"next_status":"running"}))["result"],
            json!({"valid":true,"sets_started_at":true,"sets_completed_at":false}));
        assert_eq!(v(json!({"expected_statuses":["running"],"next_status":"completed"}))["result"],
            json!({"valid":true,"sets_started_at":false,"sets_completed_at":true}));
        assert_eq!(v(json!({"expected_statuses":["completed"],"next_status":"running"}))["result"],
            json!({"valid":false,"reason":"illegal_run_transition","from":"completed","to":"running"}));
        for bad in [json!(null), json!([]), json!({}), json!({"expected_statuses":[],"next_status":"running"}),
                    json!({"expected_statuses":["pending"],"next_status":"bogus"}),
                    json!({"expected_statuses":["pending"],"next_status":"running","x":1})] {
            assert_eq!(code(&v(bad.clone())), -32602, "{bad}");
        }
    }

    #[test]
    fn validate_step_transition_matrix() {
        let v = |p: Value| call("workflow.validate_step_transition", p, &env(""));
        assert_eq!(v(json!({"expected_statuses":["pending"],"next_status":"running"}))["result"],
            json!({"valid":true,"sets_started_at":true,"sets_completed_at":false}));
        assert_eq!(v(json!({"expected_statuses":["pending"],"next_status":"skipped"}))["result"],
            json!({"valid":true,"sets_started_at":false,"sets_completed_at":true}));
        assert_eq!(v(json!({"expected_statuses":["skipped"],"next_status":"running"}))["result"],
            json!({"valid":false,"reason":"illegal_step_transition","from":"skipped","to":"running"}));
        for bad in [json!(null), json!([]), json!({}), json!({"expected_statuses":[],"next_status":"running"}),
                    json!({"expected_statuses":["pending"],"next_status":"bogus"}),
                    json!({"expected_statuses":["pending"],"next_status":"running","x":1})] {
            assert_eq!(code(&v(bad.clone())), -32602, "{bad}");
        }
    }

    #[test]
    fn db_method_param_gates_and_pre_io_rejection() {
        let (u, e) = (Uuid::nil(), env(""));
        for (m, p) in [
            ("workflow.list_pending_runs", json!({})),
            ("workflow.list_pending_runs", json!([])),
            ("workflow.list_pending_runs", json!({"company_id":u,"limit":1,"x":0})),
            ("workflow.transition_run_fenced", json!({})),
            ("workflow.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":[],"next_status":"running"})),
            ("workflow.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":["completed"],"next_status":"running"})),
            ("workflow.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":["pending"],"next_status":"running","y":1})),
            ("workflow.transition_step_fenced", json!({"step_run_id":u,"workflow_run_id":u,"company_id":u,"expected_statuses":[],"next_status":"running","expected_transition_version":0})),
            ("workflow.transition_step_fenced", json!({"step_run_id":u,"workflow_run_id":u,"company_id":u,"expected_statuses":["running"],"next_status":"skipped","expected_transition_version":0})),
            ("workflow.transition_step_fenced", json!({"step_run_id":u,"workflow_run_id":u,"company_id":u,"expected_statuses":["pending"],"next_status":"running"})),
            ("workflow.list_step_runs", json!({"company_id":u})),
            ("workflow.list_step_runs", json!({"company_id":u,"workflow_run_id":u,"z":9})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // -32602 with an empty DATABASE_URL proves rejection happened before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "workflow.list_pending_runs", None, &e)), -32602);
        assert_eq!(code(&call("workflow.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("workflow.list_pending_runs", json!({"company_id":u,"limit":10})),
                ("workflow.transition_run_fenced", json!({"run_id":u,"company_id":u,"expected_statuses":["pending"],"next_status":"running"})),
                ("workflow.transition_step_fenced", json!({"step_run_id":u,"workflow_run_id":u,"company_id":u,"expected_statuses":["pending"],"next_status":"running","expected_transition_version":0})),
                ("workflow.list_step_runs", json!({"company_id":u,"workflow_run_id":u})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn health_lists_workflow_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["workflow.validate_run_transition", "workflow.validate_step_transition", "workflow.list_pending_runs",
                  "workflow.transition_run_fenced", "workflow.transition_step_fenced", "workflow.list_step_runs"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"workflow.validate_run_transition","params":{"expected_statuses":["pending"],"next_status":"running"}}"#, &env(""));
        assert_eq!(r["result"]["valid"], true);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"workflow.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

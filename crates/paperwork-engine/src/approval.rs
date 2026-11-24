#![forbid(unsafe_code)]
//! approval.* JSON-RPC methods: pure status-transition validation, company-
//! scoped get/list, and fenced create/resolve/revision/resubmit/cancel writes.
//! All PG I/O reuses heartbeat.rs's hardened direct-PG path (exec_db): loopback-
//! only DSN apply-or-reject, DNS permit cap, deadline-gated commit (-32001..
//! -32005), driver abort. Param gates are fail-closed: non-object params or
//! schema mismatch => -32602; empty decision actors are rejected pre-I/O.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_approval::{clamp_list_limit, classify_resolution_outcome, validate_approval_transition, ApprovalDbError, ApprovalRow, ApprovalStatus, ResolutionOutcome, SQL_CANCEL_APPROVAL_FENCED, SQL_CREATE_APPROVAL, SQL_GET_APPROVAL_BY_ID, SQL_LIST_APPROVALS_BY_COMPANY, SQL_REQUEST_REVISION_FENCED, SQL_RESOLVE_APPROVAL_FENCED, SQL_RESUBMIT_APPROVAL_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ValidateP { from: ApprovalStatus, to: ApprovalStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetP { approval_id: Uuid, company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default)] status: Option<ApprovalStatus>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CreateP { company_id: Uuid, approval_type: String, #[serde(default)] requested_by_agent_id: Option<Uuid>, #[serde(default)] requested_by_user_id: Option<String>, #[serde(default)] requested_by_plugin_id: Option<String>, payload: Value }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResolveP { approval_id: Uuid, company_id: Uuid, target_status: ApprovalStatus, decided_by_user_id: String, #[serde(default)] decision_note: Option<String> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct RevisionP { approval_id: Uuid, company_id: Uuid, decided_by_user_id: String, #[serde(default)] decision_note: Option<String> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResubmitP { approval_id: Uuid, company_id: Uuid, #[serde(default)] payload: Option<Value> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CancelP { approval_id: Uuid, company_id: Uuid }

enum Db { Get(GetP), List(ListP), Create(CreateP), Resolve(ResolveP), Revision(RevisionP), Resubmit(ResubmitP), Cancel(CancelP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn to_approval(r: &Row) -> Result<ApprovalRow, Fail> {
    let s: String = r.get(6);
    Ok(ApprovalRow { id: r.get(0), company_id: r.get(1), approval_type: r.get(2), requested_by_agent_id: r.get(3), requested_by_user_id: r.get(4), requested_by_plugin_id: r.get(5), status: ApprovalStatus::parse(&s).map_err(|_| DBERR)?, payload: r.get(7), decision_note: r.get(8), decided_by_user_id: r.get(9), decided_at: r.get(10), created_at: r.get(11), updated_at: r.get(12) })
}
fn approval_json(r: ApprovalRow) -> Value { json!({"id": r.id, "company_id": r.company_id, "approval_type": r.approval_type, "requested_by_agent_id": r.requested_by_agent_id, "requested_by_user_id": r.requested_by_user_id, "requested_by_plugin_id": r.requested_by_plugin_id, "status": r.status.as_str(), "payload": r.payload, "decision_note": r.decision_note, "decided_by_user_id": r.decided_by_user_id, "decided_at": r.decided_at, "created_at": r.created_at, "updated_at": r.updated_at}) }
fn opt_approval(o: Option<ApprovalRow>) -> Value { o.map_or(Value::Null, approval_json) }
fn updated_json(o: Option<ApprovalRow>) -> Value { match o { Some(r) => json!({"updated": true, "approval": approval_json(r)}), None => json!({"updated": false}) } }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Get(p) => Step::Done(json!({"approval": opt_approval(tx.query_opt(SQL_GET_APPROVAL_BY_ID, &[&p.approval_id, &p.company_id]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?)})),
        Db::List(p) => {
            let status = p.status.map(|s| s.as_str());
            let rows = tx.query(SQL_LIST_APPROVALS_BY_COMPANY, &[&p.company_id, &status, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let approvals = rows.iter().map(|r| to_approval(r).map(approval_json)).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"approvals": approvals})) // read-only: tx dropped, never committed
        }
        Db::Create(p) => {
            let row = tx.query_opt(SQL_CREATE_APPROVAL, &[&p.company_id, &p.approval_type, &p.requested_by_agent_id, &p.requested_by_user_id, &p.requested_by_plugin_id, &p.payload]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?;
            Step::Commit(tx, match row { Some(a) => json!({"created": true, "approval": approval_json(a)}), None => json!({"created": false}) })
        }
        Db::Resolve(p) => {
            let updated = tx.query_opt(SQL_RESOLVE_APPROVAL_FENCED, &[&p.approval_id, &p.company_id, &p.target_status.as_str(), &p.decided_by_user_id, &p.decision_note]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?;
            let existing = if updated.is_none() { tx.query_opt(SQL_GET_APPROVAL_BY_ID, &[&p.approval_id, &p.company_id]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()? } else { None };
            Step::Commit(tx, match classify_resolution_outcome(updated, existing, p.target_status) {
                ResolutionOutcome::Applied(a) => json!({"outcome": "applied", "approval": approval_json(a)}),
                ResolutionOutcome::AlreadyInTargetState(a) => json!({"outcome": "already_in_target_state", "approval": approval_json(a)}),
                ResolutionOutcome::NotFoundOrConflict => json!({"outcome": "not_found_or_conflict"}),
            })
        }
        Db::Revision(p) => {
            let row = tx.query_opt(SQL_REQUEST_REVISION_FENCED, &[&p.approval_id, &p.company_id, &p.decided_by_user_id, &p.decision_note]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?;
            Step::Commit(tx, updated_json(row))
        }
        Db::Resubmit(p) => {
            let row = tx.query_opt(SQL_RESUBMIT_APPROVAL_FENCED, &[&p.approval_id, &p.company_id, &p.payload]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?;
            Step::Commit(tx, updated_json(row))
        }
        Db::Cancel(p) => {
            let row = tx.query_opt(SQL_CANCEL_APPROVAL_FENCED, &[&p.approval_id, &p.company_id]).await.map_err(pre)?.map(|r| to_approval(&r)).transpose()?;
            Step::Commit(tx, updated_json(row))
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Empty actors and non-terminal resolve targets are
/// rejected before any PG I/O (resolve_approval_fenced's own guards).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "approval.validate_transition" => {
            let p = need!(ValidateP);
            ok(id, match validate_approval_transition(p.from, p.to) {
                Ok(()) => json!({"valid": true}),
                Err(ApprovalDbError::InvalidTransition { from, to }) => json!({"valid": false, "reason": "invalid_transition", "from": from.as_str(), "to": to.as_str()}),
                Err(_) => Value::Null,
            })
        }
        "approval.get" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Get(p)) }
        "approval.list" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "approval.create" => { let p = need!(CreateP); exec_db(id, env, OP_TIMEOUT, Db::Create(p)) }
        "approval.resolve_fenced" => {
            let p = need!(ResolveP);
            if p.decided_by_user_id.trim().is_empty() || !matches!(p.target_status, ApprovalStatus::Approved | ApprovalStatus::Rejected) { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Resolve(p))
        }
        "approval.request_revision_fenced" => {
            let p = need!(RevisionP);
            if p.decided_by_user_id.trim().is_empty() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Revision(p))
        }
        "approval.resubmit_fenced" => { let p = need!(ResubmitP); exec_db(id, env, OP_TIMEOUT, Db::Resubmit(p)) }
        "approval.cancel_fenced" => { let p = need!(CancelP); exec_db(id, env, OP_TIMEOUT, Db::Cancel(p)) }
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
    fn validate_transition_matrix() {
        let v = |p: Value| call("approval.validate_transition", p, &env(""));
        assert_eq!(v(json!({"from":"pending","to":"approved"}))["result"], json!({"valid": true}));
        assert_eq!(v(json!({"from":"pending","to":"revision_requested"}))["result"], json!({"valid": true}));
        assert_eq!(v(json!({"from":"revision_requested","to":"pending"}))["result"], json!({"valid": true}));
        assert_eq!(v(json!({"from":"pending","to":"pending"}))["result"], json!({"valid":false,"reason":"invalid_transition","from":"pending","to":"pending"}));
        for from in ["approved", "rejected", "cancelled"] {
            assert_eq!(v(json!({"from":from,"to":"pending"}))["result"], json!({"valid":false,"reason":"invalid_transition","from":from,"to":"pending"}), "{from}"); }
        for bad in [json!(null), json!([]), json!({}), json!({"from":"pending"}), json!({"from":"bogus","to":"approved"}), json!({"from":"pending","to":"approved","x":1})] {
            assert_eq!(code(&v(bad.clone())), -32602, "{bad}"); }
    }

    #[test]
    fn db_method_param_gates_and_pre_io_rejection() {
        let (u, e) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL
        for (m, p) in [
            ("approval.get", json!({})),
            ("approval.get", json!([])),
            ("approval.get", json!({"approval_id":1,"company_id":u})),
            ("approval.get", json!({"approval_id":u,"company_id":u,"x":0})),
            ("approval.list", json!({"company_id":u})),
            ("approval.list", json!({"company_id":u,"status":"bogus","limit":1})),
            ("approval.list", json!({"company_id":u,"limit":1,"x":0})),
            ("approval.create", json!({"company_id":u,"approval_type":"t"})),
            ("approval.create", json!({"company_id":u,"approval_type":"t","payload":{},"y":1})),
            ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"cancelled","decided_by_user_id":"u1"})),
            ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"bogus","decided_by_user_id":"u1"})),
            ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"approved","decided_by_user_id":"u1","z":1})),
            ("approval.resubmit_fenced", json!({"approval_id":u})),
            ("approval.resubmit_fenced", json!({"approval_id":u,"company_id":u,"payload":{},"w":1})),
            ("approval.cancel_fenced", json!({"approval_id":u,"company_id":u,"q":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // Empty/whitespace actors are rejected before any PG I/O: -32602, not -32002.
        for (m, p) in [
            ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"approved","decided_by_user_id":""})),
            ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"rejected","decided_by_user_id":" \t "})),
            ("approval.request_revision_fenced", json!({"approval_id":u,"company_id":u,"decided_by_user_id":""})),
            ("approval.request_revision_fenced", json!({"approval_id":u,"company_id":u,"decided_by_user_id":"  "})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m} pre-io"); }
        assert_eq!(code(&dispatch_with(json!(1), "approval.get", None, &e)), -32602);
        assert_eq!(code(&call("approval.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("approval.get", json!({"approval_id":u,"company_id":u})),
                ("approval.list", json!({"company_id":u,"limit":10})),
                ("approval.create", json!({"company_id":u,"approval_type":"t","payload":{}})),
                ("approval.resolve_fenced", json!({"approval_id":u,"company_id":u,"target_status":"approved","decided_by_user_id":"u1"})),
                ("approval.request_revision_fenced", json!({"approval_id":u,"company_id":u,"decided_by_user_id":"u1"})),
                ("approval.resubmit_fenced", json!({"approval_id":u,"company_id":u})),
                ("approval.cancel_fenced", json!({"approval_id":u,"company_id":u})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn health_lists_approval_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["approval.validate_transition", "approval.get", "approval.list", "approval.create", "approval.resolve_fenced", "approval.request_revision_fenced", "approval.resubmit_fenced", "approval.cancel_fenced"] {
            assert!(caps.contains(&m), "missing {m}"); }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"approval.validate_transition","params":{"from":"pending","to":"approved"}}"#, &env(""));
        assert_eq!(r["result"]["valid"], true);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"approval.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

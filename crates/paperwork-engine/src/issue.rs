#![forbid(unsafe_code)]
//! issue.* JSON-RPC methods: company-scoped issue get/list and work-product
//! reads, plus fenced checkout/status-transition/checkout-release writes. All
//! PG I/O reuses heartbeat.rs's hardened direct-PG path (exec_db): loopback-
//! only DSN apply-or-reject, DNS permit cap, deadline-gated commit (-32001..
//! -32005), driver abort. Param gates are fail-closed: non-object params or
//! schema mismatch => -32602; checkout requires a non-empty expected-status
//! set and a non-blank agent name key (when present) before any PG I/O.
//! Fenced ops re-implement engine-issue's lock-then-update sequence over the
//! shared tokio-postgres transaction: SELECT ... FOR UPDATE, then the fenced
//! UPDATE from the domain crate's SQL constants (sync-postgres row decode is
//! re-implemented locally because the transaction flavors differ).
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_issue::{clamp_list_limit, Issue, IssuePriority, IssueStatus, IssueWorkProduct, SQL_CHECKOUT_ISSUE_FENCED, SQL_GET_ISSUE_BY_ID, SQL_LIST_ISSUE_WORK_PRODUCTS, SQL_LIST_ISSUES_BY_COMPANY, SQL_LOCK_ISSUE_FOR_UPDATE, SQL_RELEASE_ISSUE_CHECKOUT_FENCED, SQL_TRANSITION_ISSUE_STATUS_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::FromSql, Client, Row, Transaction};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetP { company_id: Uuid, issue_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CheckoutP { company_id: Uuid, issue_id: Uuid, agent_id: Uuid, run_id: Uuid, #[serde(default)] agent_name_key: Option<String>, expected_statuses: Vec<IssueStatus> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct TransitionP { company_id: Uuid, issue_id: Uuid, expected_status: IssueStatus, new_status: IssueStatus }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ReleaseP { company_id: Uuid, issue_id: Uuid, run_id: Uuid }

enum Db { Get(GetP), List(ListP), Products(GetP), Checkout(CheckoutP), Transition(TransitionP), Release(ReleaseP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn to_issue(r: &Row) -> Result<Issue, Fail> { Ok(Issue {
    id: col(r, 0)?, company_id: col(r, 1)?, project_id: col(r, 2)?, mission_id: col(r, 3)?, parent_id: col(r, 4)?, title: col(r, 5)?, description: col(r, 6)?,
    status: IssueStatus::parse(&col::<String>(r, 7)?).map_err(|_| DBERR)?, priority: IssuePriority::parse(&col::<String>(r, 8)?).map_err(|_| DBERR)?,
    assignee_agent_id: col(r, 9)?, assignee_user_id: col(r, 10)?, checkout_run_id: col(r, 11)?, execution_run_id: col(r, 12)?, execution_agent_name_key: col(r, 13)?, execution_locked_at: col(r, 14)?,
    created_by_agent_id: col(r, 15)?, created_by_user_id: col(r, 16)?, issue_number: col(r, 17)?, identifier: col(r, 18)?, origin_kind: col(r, 19)?, origin_id: col(r, 20)?, origin_run_id: col(r, 21)?,
    request_depth: col(r, 22)?, billing_code: col(r, 23)?, started_at: col(r, 24)?, completed_at: col(r, 25)?, cancelled_at: col(r, 26)?, hidden_at: col(r, 27)?, created_at: col(r, 28)?, updated_at: col(r, 29)? }) }
fn to_work_product(r: &Row) -> Result<IssueWorkProduct, Fail> { Ok(IssueWorkProduct {
    id: col(r, 0)?, company_id: col(r, 1)?, project_id: col(r, 2)?, issue_id: col(r, 3)?, execution_workspace_id: col(r, 4)?, runtime_service_id: col(r, 5)?, work_product_type: col(r, 6)?,
    provider: col(r, 7)?, external_id: col(r, 8)?, title: col(r, 9)?, url: col(r, 10)?, status: col(r, 11)?, review_state: col(r, 12)?, is_primary: col(r, 13)?, health_status: col(r, 14)?,
    summary: col(r, 15)?, metadata: col(r, 16)?, created_by_run_id: col(r, 17)?, source_execution_generation: col(r, 18)?, created_at: col(r, 19)?, updated_at: col(r, 20)? }) }
fn issue_json(i: &Issue) -> Value { json!({
    "id": i.id, "company_id": i.company_id, "project_id": i.project_id, "mission_id": i.mission_id, "parent_id": i.parent_id, "title": i.title, "description": i.description,
    "status": i.status.as_str(), "priority": i.priority.as_str(), "assignee_agent_id": i.assignee_agent_id, "assignee_user_id": i.assignee_user_id, "checkout_run_id": i.checkout_run_id,
    "execution_run_id": i.execution_run_id, "execution_agent_name_key": i.execution_agent_name_key, "execution_locked_at": i.execution_locked_at, "created_by_agent_id": i.created_by_agent_id,
    "created_by_user_id": i.created_by_user_id, "issue_number": i.issue_number, "identifier": i.identifier, "origin_kind": i.origin_kind, "origin_id": i.origin_id, "origin_run_id": i.origin_run_id,
    "request_depth": i.request_depth, "billing_code": i.billing_code, "started_at": i.started_at, "completed_at": i.completed_at, "cancelled_at": i.cancelled_at, "hidden_at": i.hidden_at,
    "created_at": i.created_at, "updated_at": i.updated_at }) }
fn work_product_json(w: &IssueWorkProduct) -> Value { json!({
    "id": w.id, "company_id": w.company_id, "project_id": w.project_id, "issue_id": w.issue_id, "execution_workspace_id": w.execution_workspace_id, "runtime_service_id": w.runtime_service_id,
    "work_product_type": w.work_product_type, "provider": w.provider, "external_id": w.external_id, "title": w.title, "url": w.url, "status": w.status, "review_state": w.review_state,
    "is_primary": w.is_primary, "health_status": w.health_status, "summary": w.summary, "metadata": w.metadata, "created_by_run_id": w.created_by_run_id,
    "source_execution_generation": w.source_execution_generation, "created_at": w.created_at, "updated_at": w.updated_at }) }

enum Lock { Found(Box<Issue>), NotFound, Mismatch }
/// Mirror of engine-issue's lock_issue_for_update: lock by id, then enforce
/// the company boundary inside the same transaction.
async fn lock_issue(tx: &Transaction<'_>, company_id: Uuid, issue_id: Uuid) -> Result<Lock, Fail> {
    let row = tx.query_opt(SQL_LOCK_ISSUE_FOR_UPDATE, &[&issue_id]).await.map_err(pre)?;
    Ok(match row.map(|r| to_issue(&r)).transpose()? {
        None => Lock::NotFound,
        Some(i) if i.company_id != company_id => Lock::Mismatch,
        Some(i) => Lock::Found(Box::new(i)),
    })
}
fn write_json(o: Option<Issue>) -> Value { match o { Some(i) => json!({"applied": true, "issue": issue_json(&i)}), None => json!({"applied": false, "reason": "fenced"}) } }
fn gated(r: &'static str) -> Value { json!({"applied": false, "reason": r}) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Get(p) => {
            let issue = tx.query_opt(SQL_GET_ISSUE_BY_ID, &[&p.issue_id]).await.map_err(pre)?.map(|r| to_issue(&r)).transpose()?
                .filter(|i| i.company_id == p.company_id); // company boundary: another company's row reads as absent
            Step::Done(json!({"issue": issue.map(|i| issue_json(&i))})) // read-only: tx dropped, never committed
        }
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_ISSUES_BY_COMPANY, &[&p.company_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let issues = rows.iter().map(|r| to_issue(r).map(|i| issue_json(&i))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"issues": issues})) // read-only: tx dropped, never committed
        }
        Db::Products(p) => {
            let rows = tx.query(SQL_LIST_ISSUE_WORK_PRODUCTS, &[&p.company_id, &p.issue_id]).await.map_err(pre)?;
            let products = rows.iter().map(|r| to_work_product(r).map(|w| work_product_json(&w))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"work_products": products})) // read-only: tx dropped, never committed
        }
        Db::Checkout(p) => match lock_issue(&tx, p.company_id, p.issue_id).await? {
            Lock::NotFound => Step::Commit(tx, gated("not_found")),
            Lock::Mismatch => Step::Commit(tx, gated("company_mismatch")),
            Lock::Found(locked) if !p.expected_statuses.contains(&locked.status)
                || locked.assignee_agent_id.is_some_and(|a| a != p.agent_id)
                || locked.checkout_run_id.is_some_and(|r| r != p.run_id)
                || locked.execution_run_id.is_some_and(|r| r != p.run_id) => Step::Commit(tx, gated("fenced")),
            Lock::Found(_) => {
                let exp: Vec<&str> = p.expected_statuses.iter().map(|s| s.as_str()).collect();
                let row = tx.query_opt(SQL_CHECKOUT_ISSUE_FENCED, &[&p.company_id, &p.issue_id, &p.agent_id, &p.run_id, &p.agent_name_key, &exp]).await.map_err(pre)?.map(|r| to_issue(&r)).transpose()?;
                Step::Commit(tx, write_json(row))
            }
        },
        Db::Transition(p) => match lock_issue(&tx, p.company_id, p.issue_id).await? {
            Lock::NotFound => Step::Commit(tx, gated("not_found")),
            Lock::Mismatch => Step::Commit(tx, gated("company_mismatch")),
            Lock::Found(locked) if locked.status != p.expected_status => Step::Commit(tx, gated("fenced")),
            Lock::Found(_) => {
                let row = tx.query_opt(SQL_TRANSITION_ISSUE_STATUS_FENCED, &[&p.company_id, &p.issue_id, &p.expected_status.as_str(), &p.new_status.as_str()]).await.map_err(pre)?.map(|r| to_issue(&r)).transpose()?;
                Step::Commit(tx, write_json(row))
            }
        },
        Db::Release(p) => {
            let row = tx.query_opt(SQL_RELEASE_ISSUE_CHECKOUT_FENCED, &[&p.company_id, &p.issue_id, &p.run_id]).await.map_err(pre)?.map(|r| to_issue(&r)).transpose()?;
            Step::Commit(tx, write_json(row))
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Unknown statuses fail serde; checkout also rejects
/// an empty expected-status set and a blank agent name key pre-I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "issue.get" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Get(p)) }
        "issue.list_by_company" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "issue.list_issue_work_products" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Products(p)) }
        "issue.checkout_fenced" => {
            let p = need!(CheckoutP);
            if p.expected_statuses.is_empty() || p.agent_name_key.as_deref().is_some_and(|s| s.trim().is_empty()) { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Checkout(p))
        }
        "issue.transition_status_fenced" => { let p = need!(TransitionP); exec_db(id, env, OP_TIMEOUT, Db::Transition(p)) }
        "issue.release_checkout_fenced" => { let p = need!(ReleaseP); exec_db(id, env, OP_TIMEOUT, Db::Release(p)) }
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
            ("issue.get", json!([])), ("issue.get", json!({})), ("issue.get", json!({"issue_id":u})),
            ("issue.get", json!({"issue_id":u,"company_id":u,"x":0})),
            ("issue.list_by_company", json!({"company_id":u})),
            ("issue.list_by_company", json!({"company_id":u,"limit":"5"})),
            ("issue.list_by_company", json!({"company_id":u,"limit":10,"y":1})),
            ("issue.list_issue_work_products", json!({"issue_id":u})),
            ("issue.list_issue_work_products", json!({"issue_id":u,"company_id":u,"z":2})),
            ("issue.checkout_fenced", json!({})),
            ("issue.checkout_fenced", json!({"company_id":u,"issue_id":u,"agent_id":u,"run_id":u,"expected_statuses":[]})),
            ("issue.checkout_fenced", json!({"company_id":u,"issue_id":u,"agent_id":u,"run_id":u,"expected_statuses":["bogus"]})),
            ("issue.checkout_fenced", json!({"company_id":u,"issue_id":u,"agent_id":u,"run_id":u,"agent_name_key":"  ","expected_statuses":["todo"]})),
            ("issue.checkout_fenced", json!({"company_id":u,"issue_id":u,"agent_id":u,"run_id":u,"expected_statuses":["todo"],"w":1})),
            ("issue.transition_status_fenced", json!({"company_id":u,"issue_id":u,"expected_status":"todo"})),
            ("issue.transition_status_fenced", json!({"company_id":u,"issue_id":u,"expected_status":"todo","new_status":"bogus"})),
            ("issue.transition_status_fenced", json!({"company_id":u,"issue_id":u,"expected_status":"todo","new_status":"done","v":1})),
            ("issue.release_checkout_fenced", json!({"company_id":u,"issue_id":u})),
            ("issue.release_checkout_fenced", json!({"company_id":u,"issue_id":u,"run_id":u,"q":0})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // -32602 with an empty DATABASE_URL proves rejection happened before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "issue.get", None, &e)), -32602);
        assert_eq!(code(&call("issue.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("issue.get", json!({"company_id":u,"issue_id":u})),
                ("issue.list_by_company", json!({"company_id":u,"limit":10})),
                ("issue.list_issue_work_products", json!({"company_id":u,"issue_id":u})),
                ("issue.checkout_fenced", json!({"company_id":u,"issue_id":u,"agent_id":u,"run_id":u,"expected_statuses":["todo"]})),
                ("issue.transition_status_fenced", json!({"company_id":u,"issue_id":u,"expected_status":"todo","new_status":"in_progress"})),
                ("issue.release_checkout_fenced", json!({"company_id":u,"issue_id":u,"run_id":u})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn every_status_variant_deserializes() {
        let u = Uuid::nil();
        for s in ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] {
            let p = json!({"company_id":u,"issue_id":u,"expected_status":s,"new_status":s});
            assert_eq!(code(&call("issue.transition_status_fenced", p, &env(""))), -32002, "{s}");
        }
    }

    #[test]
    fn health_lists_issue_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["issue.get", "issue.list_by_company", "issue.list_issue_work_products", "issue.checkout_fenced", "issue.transition_status_fenced", "issue.release_checkout_fenced"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"issue.get","params":{"issue_id":"00000000-0000-0000-0000-000000000000","company_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"issue.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

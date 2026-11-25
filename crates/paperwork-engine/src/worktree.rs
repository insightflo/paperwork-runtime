#![forbid(unsafe_code)]
//! worktree.* JSON-RPC methods: company-scoped rule CRUD backed by the
//! paperwork-engine-worktree crate's SQL constants, row type, input types,
//! and closed enums. All PG I/O reuses heartbeat.rs's hardened direct-PG path
//! (exec_db): loopback-only DSN apply-or-reject, DNS permit cap,
//! deadline-gated commit (-32001..-32005), driver abort. Param gates are
//! fail-closed: non-object params or schema mismatch => -32602 and domain
//! rejections (blank required text, invalid version, non-object JSON fields)
//! fire before any PG I/O.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_worktree::{CreateWorktreeRuleInput, RuleAction, RuleSeverity, UpdateWorktreeRuleInput, WorktreeRuleRow, SQL_CREATE_WORKTREE_RULE, SQL_DELETE_WORKTREE_RULE, SQL_GET_WORKTREE_RULE_BY_ID, SQL_LIST_WORKTREE_RULES, SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED, SQL_UPDATE_WORKTREE_RULE_FENCED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row, Transaction};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);
const _: fn(Value, Value) -> Value = ok;

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default)] enabled_only: Option<bool> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetP { company_id: Uuid, rule_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CreateP { company_id: Uuid, name: String, severity: RuleSeverity, action: RuleAction, predicate: Value, decision_map: Value, #[serde(default)] message: String, #[serde(default)] enabled: Option<bool>, created_by: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct UpdateP { company_id: Uuid, rule_id: Uuid, expected_version: i32, #[serde(default)] name: Option<String>, #[serde(default)] severity: Option<RuleSeverity>, #[serde(default)] action: Option<RuleAction>, #[serde(default)] predicate: Option<Value>, #[serde(default)] decision_map: Option<Value>, #[serde(default)] message: Option<String> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ToggleP { company_id: Uuid, rule_id: Uuid, expected_version: i32 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct DeleteP { company_id: Uuid, rule_id: Uuid }

struct UpdateOp { company_id: Uuid, rule_id: Uuid, expected_version: i32, input: UpdateWorktreeRuleInput }
enum Db { List(ListP), Get(GetP), Create(CreateWorktreeRuleInput), Update(UpdateOp), Toggle(ToggleP), Delete(DeleteP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn rule_from_row(r: &Row) -> Result<WorktreeRuleRow, Fail> {
    macro_rules! col { ($i:expr) => { r.try_get($i).map_err(pre)? } }
    let (raw_severity, raw_action): (String, String) = (col!(3), col!(4));
    Ok(WorktreeRuleRow {
        id: col!(0), company_id: col!(1), name: col!(2),
        severity: RuleSeverity::parse(&raw_severity).map_err(|_| DBERR)?, action: RuleAction::parse(&raw_action).map_err(|_| DBERR)?,
        predicate: col!(5), decision_map: col!(6), message: col!(7), enabled: col!(8), version: col!(9),
        created_by: col!(10), created_at: col!(11), updated_at: col!(12),
    })
}
fn rule_json(r: &Row) -> Result<Value, Fail> {
    let row = rule_from_row(r)?;
    Ok(json!({"id": row.id, "company_id": row.company_id, "name": row.name, "severity": row.severity.as_str(), "action": row.action.as_str(), "predicate": row.predicate, "decision_map": row.decision_map, "message": row.message, "enabled": row.enabled, "version": row.version, "created_by": row.created_by, "created_at": row.created_at, "updated_at": row.updated_at}))
}

async fn fenced_miss_json(tx: &Transaction<'_>, rule_id: Uuid, company_id: Uuid) -> Result<Value, Fail> {
    let row = tx.query_opt(SQL_GET_WORKTREE_RULE_BY_ID, &[&rule_id, &company_id]).await.map_err(pre)?;
    Ok(match row {
        Some(r) => json!({"updated":false,"reason":"version_conflict","current_version":rule_from_row(&r)?.version}),
        None => json!({"updated":false,"reason":"not_found"}),
    })
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_WORKTREE_RULES, &[&p.company_id, &p.enabled_only]).await.map_err(pre)?;
            let rules = rows.iter().map(rule_json).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"rules": rules})) // read-only: tx dropped, never committed
        }
        Db::Get(p) => {
            let row = tx.query_opt(SQL_GET_WORKTREE_RULE_BY_ID, &[&p.rule_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(match row { // read-only: tx dropped, never committed
                Some(r) => json!({"found":true,"rule":rule_json(&r)?}), None => json!({"found":false}) })
        }
        Db::Create(input) => {
            let (severity, action) = (input.severity.as_str(), input.action.as_str());
            let row = tx.query_one(SQL_CREATE_WORKTREE_RULE, &[&input.company_id, &input.name, &severity, &action, &input.predicate, &input.decision_map, &input.message, &input.enabled, &input.created_by]).await.map_err(pre)?;
            Step::Commit(tx, json!({"created":true,"rule":rule_json(&row)?}))
        }
        Db::Update(op) => {
            let (severity, action) = (op.input.severity.map(|v| v.as_str()), op.input.action.map(|v| v.as_str()));
            let updated = tx.query_opt(SQL_UPDATE_WORKTREE_RULE_FENCED, &[&op.rule_id, &op.company_id, &op.expected_version, &op.input.name, &severity, &action, &op.input.predicate, &op.input.decision_map, &op.input.message]).await.map_err(pre)?;
            let v = match updated {
                Some(r) => json!({"updated":true,"rule":rule_json(&r)?}),
                None => fenced_miss_json(&tx, op.rule_id, op.company_id).await?,
            };
            Step::Commit(tx, v)
        }
        Db::Toggle(p) => {
            let updated = tx.query_opt(SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED, &[&p.rule_id, &p.company_id, &p.expected_version]).await.map_err(pre)?;
            let v = match updated {
                Some(r) => json!({"updated":true,"rule":rule_json(&r)?}),
                None => fenced_miss_json(&tx, p.rule_id, p.company_id).await?,
            };
            Step::Commit(tx, v)
        }
        Db::Delete(p) => {
            let row = tx.query_opt(SQL_DELETE_WORKTREE_RULE, &[&p.rule_id, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, json!({"deleted":row.is_some()}))
        }
    })
}

fn object_or_empty(v: &mut Value) -> bool {
    if v.is_null() { *v = json!({}); }
    v.is_object()
}
fn optional_object(v: &Option<Value>) -> bool { v.as_ref().is_none_or(Value::is_object) }
fn create_input(mut p: CreateP) -> Result<CreateWorktreeRuleInput, ()> {
    if !object_or_empty(&mut p.predicate) || !object_or_empty(&mut p.decision_map) { return Err(()) }
    let input = CreateWorktreeRuleInput { company_id: p.company_id, name: p.name, severity: p.severity, action: p.action, predicate: p.predicate, decision_map: p.decision_map, message: p.message, enabled: p.enabled.unwrap_or(true), created_by: p.created_by };
    input.validate().map_err(|_| ())?;
    Ok(input)
}
fn update_op(p: UpdateP) -> Result<UpdateOp, ()> {
    if p.expected_version < 1 || !optional_object(&p.predicate) || !optional_object(&p.decision_map) { return Err(()) }
    let input = UpdateWorktreeRuleInput { name: p.name, severity: p.severity, action: p.action, predicate: p.predicate, decision_map: p.decision_map, message: p.message };
    input.validate().map_err(|_| ())?;
    Ok(UpdateOp { company_id: p.company_id, rule_id: p.rule_id, expected_version: p.expected_version, input })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Domain fields are re-validated before any PG I/O
/// (unset DATABASE_URL still yields -32602 for invalid input).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "worktree.list" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "worktree.get_by_id" => { let p = need!(GetP); exec_db(id, env, OP_TIMEOUT, Db::Get(p)) }
        "worktree.create" => { let p = need!(CreateP); let input = match create_input(p) { Ok(v) => v, Err(()) => return err(id, -32602, "invalid_params") }; exec_db(id, env, OP_TIMEOUT, Db::Create(input)) }
        "worktree.update" => { let p = need!(UpdateP); let op = match update_op(p) { Ok(v) => v, Err(()) => return err(id, -32602, "invalid_params") }; exec_db(id, env, OP_TIMEOUT, Db::Update(op)) }
        "worktree.toggle_enabled" => { let p = need!(ToggleP); if p.expected_version < 1 { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Toggle(p)) }
        "worktree.delete" => { let p = need!(DeleteP); exec_db(id, env, OP_TIMEOUT, Db::Delete(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn create(u: Uuid) -> Value { json!({"company_id":u,"name":"rule","severity":"MUST","action":"tool_call","predicate":{},"decision_map":{},"created_by":"tester"}) }
    fn update(u: Uuid) -> Value { json!({"company_id":u,"rule_id":u,"expected_version":1,"name":"renamed","severity":"SHOULD","action":"file_write","predicate":{},"decision_map":{},"message":"m"}) }
    fn toggle(u: Uuid) -> Value { json!({"company_id":u,"rule_id":u,"expected_version":1}) }
    fn valid() -> [(&'static str, Value); 6] { let u = Uuid::nil(); [
        ("worktree.list", json!({"company_id":u,"enabled_only":true})),
        ("worktree.get_by_id", json!({"company_id":u,"rule_id":u})),
        ("worktree.create", create(u)), ("worktree.update", update(u)),
        ("worktree.toggle_enabled", toggle(u)), ("worktree.delete", json!({"company_id":u,"rule_id":u})), ] }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let e = env("");
        for (m, p) in valid() {
            for bad in [json!(null), json!([]), json!("x")] { assert_eq!(code(&call(m, bad, &e)), -32602, "{m} non-object"); }
            let mut extra = p.clone(); extra["x"] = json!(1);
            assert_eq!(code(&call(m, extra, &e)), -32602, "{m} extra-key");
            let mut missing = p.clone(); missing.as_object_mut().unwrap().remove("company_id");
            assert_eq!(code(&call(m, missing, &e)), -32602, "{m} missing-field");
        }
        assert_eq!(code(&dispatch_with(json!(1), "worktree.list", None, &e)), -32602); // missing params
        let u = Uuid::nil();
        for (m, field, bad) in [("worktree.create", "severity", "must"), ("worktree.create", "action", "shell_exec"), ("worktree.update", "severity", "sometimes"), ("worktree.update", "action", "block")] {
            let mut p = if m == "worktree.create" { create(u) } else { update(u) }; p[field] = json!(bad);
            assert_eq!(code(&call(m, p, &e)), -32602, "{m} bad-{field}"); }
        let mut bad_type = create(u); bad_type["enabled"] = json!("yes");
        assert_eq!(code(&call("worktree.create", bad_type, &e)), -32602);
    }

    #[test]
    fn pre_io_rejection_before_any_pg_io() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves rejection precedes DSN checks
        for (field, value) in [("name", "  "), ("created_by", "\t")] {
            let mut bad = create(u); bad[field] = json!(value);
            assert_eq!(code(&call("worktree.create", bad, &none)), -32602, "{field}"); }
        for field in ["predicate", "decision_map"] {
            let mut bad = create(u); bad[field] = json!([]);
            assert_eq!(code(&call("worktree.create", bad, &none)), -32602, "{field}");
            let mut bad_update = update(u); bad_update[field] = json!([]);
            assert_eq!(code(&call("worktree.update", bad_update, &none)), -32602, "update {field}"); }
        for version in [0, -1] {
            let mut bad_update = update(u); bad_update["expected_version"] = json!(version);
            assert_eq!(code(&call("worktree.update", bad_update, &none)), -32602, "update {version}");
            let mut bad_toggle = toggle(u); bad_toggle["expected_version"] = json!(version);
            assert_eq!(code(&call("worktree.toggle_enabled", bad_toggle, &none)), -32602, "toggle {version}"); }
        let mut blank_update = update(u); blank_update["name"] = json!(" \n ");
        assert_eq!(code(&call("worktree.update", blank_update, &none)), -32602);
        let mut null_objects = create(u); null_objects["predicate"] = json!(null); null_objects["decision_map"] = json!(null);
        assert_eq!(code(&call("worktree.create", null_objects, &none)), -32002);
    }

    #[test]
    fn db_unconfigured_for_all_db_methods() {
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in valid() { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn unknown_method_and_health_capabilities() {
        assert_eq!(code(&call("worktree.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("worktree.", json!({}), &env(""))), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &env(""))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["worktree.list", "worktree.get_by_id", "worktree.create", "worktree.update", "worktree.toggle_enabled", "worktree.delete"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

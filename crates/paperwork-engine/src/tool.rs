//! tool.* JSON-RPC methods: company-scoped tool-definition, company-skill,
//! and execution-receipt reads plus one idempotent receipt claim over the
//! engine-tool crate's SQL constants. All PG I/O reuses heartbeat.rs's
//! hardened direct-PG path (exec_db): loopback-only DSN apply-or-reject,
//! DNS permit cap, deadline-gated commit (-32001..-32005), driver abort.
//! Reads complete via Step::Done (tx dropped, never committed); the claim
//! write goes through Step::Commit under the deadline gate. Param gates are
//! fail-closed: non-object params or schema mismatch => -32602;
//! claim_execution_receipt_idempotent also requires non-blank run_id/tool
//! and a valid idempotency_key before any PG I/O. Unknown tool.* method =>
//! -32601. Row decode and enum parse failures map to DBERR.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_tool::{clamp_list_limit, validate_idempotency_key, CompanySkillCompatibility, CompanySkillSourceType, CompanySkillTrustLevel, ToolReceiptStatus, SQL_CLAIM_TOOL_EXECUTION_RECEIPT, SQL_GET_TOOL_DEFINITION, SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY, SQL_LIST_COMPANY_SKILLS, SQL_LIST_TOOL_DEFINITIONS, SQL_LIST_TOOL_EXECUTION_RECEIPTS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::FromSql, Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct DefsP { company_id: Uuid, #[serde(default)] enabled: Option<bool>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct DefP { company_id: Uuid, tool_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct SkillsP { company_id: Uuid, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ReceiptsP { company_id: Uuid, #[serde(default)] run_id: Option<String>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ClaimP { company_id: Uuid, run_id: String, tool: String, idempotency_key: String, parameters: Value }

enum Db { Defs(DefsP), Def(DefP), Skills(SkillsP), Receipts(ReceiptsP), Claim(ClaimP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn def_json(r: &Row) -> Result<Value, Fail> { Ok(json!({
    "id": col::<Uuid>(r, 0)?, "company_id": col::<Uuid>(r, 1)?, "name": col::<String>(r, 2)?, "description": col::<String>(r, 3)?,
    "input_schema": col::<Value>(r, 4)?, "adapter_type": col::<String>(r, 5)?, "adapter_config": col::<Value>(r, 6)?,
    "enabled": col::<bool>(r, 7)?, "created_at": col::<DateTime<Utc>>(r, 8)?, "updated_at": col::<DateTime<Utc>>(r, 9)? })) }
fn skill_json(r: &Row) -> Result<Value, Fail> { Ok(json!({
    "id": col::<Uuid>(r, 0)?, "company_id": col::<Uuid>(r, 1)?, "key": col::<String>(r, 2)?, "slug": col::<String>(r, 3)?,
    "name": col::<String>(r, 4)?, "description": col::<Option<String>>(r, 5)?, "markdown": col::<String>(r, 6)?,
    "source_type": CompanySkillSourceType::parse(&col::<String>(r, 7)?).map_err(|_| DBERR)?.as_str(),
    "source_locator": col::<Option<String>>(r, 8)?, "source_ref": col::<Option<String>>(r, 9)?,
    "trust_level": CompanySkillTrustLevel::parse(&col::<String>(r, 10)?).map_err(|_| DBERR)?.as_str(),
    "compatibility": CompanySkillCompatibility::parse(&col::<String>(r, 11)?).map_err(|_| DBERR)?.as_str(),
    "file_inventory": col::<Value>(r, 12)?, "metadata": col::<Option<Value>>(r, 13)?,
    "created_at": col::<DateTime<Utc>>(r, 14)?, "updated_at": col::<DateTime<Utc>>(r, 15)? })) }
fn receipt_json(r: &Row) -> Result<Value, Fail> { Ok(json!({
    "id": col::<Uuid>(r, 0)?, "company_id": col::<Uuid>(r, 1)?, "run_id": col::<String>(r, 2)?, "tool": col::<String>(r, 3)?,
    "idempotency_key": col::<String>(r, 4)?, "status": ToolReceiptStatus::parse(&col::<String>(r, 5)?).map_err(|_| DBERR)?.as_str(),
    "request_parameters": col::<Value>(r, 6)?, "result_status": col::<Option<i32>>(r, 7)?, "result_body": col::<Option<Value>>(r, 8)?,
    "claimed_at": col::<DateTime<Utc>>(r, 9)?, "completed_at": col::<Option<DateTime<Utc>>>(r, 10)?,
    "workflow_run_id": col::<Option<Uuid>>(r, 11)?, "step_id": col::<Option<String>>(r, 12)? })) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Defs(p) => {
            let rows = tx.query(SQL_LIST_TOOL_DEFINITIONS, &[&p.company_id, &p.enabled, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"definitions": rows.iter().map(def_json).collect::<Result<Vec<_>, _>>()?})) // read-only: tx dropped, never committed
        }
        Db::Def(p) => {
            let row = tx.query_opt(SQL_GET_TOOL_DEFINITION, &[&p.tool_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(json!({"definition": row.map(|r| def_json(&r)).transpose()?})) // read-only: tx dropped, never committed
        }
        Db::Skills(p) => {
            let rows = tx.query(SQL_LIST_COMPANY_SKILLS, &[&p.company_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"skills": rows.iter().map(skill_json).collect::<Result<Vec<_>, _>>()?})) // read-only: tx dropped, never committed
        }
        Db::Receipts(p) => {
            let rows = tx.query(SQL_LIST_TOOL_EXECUTION_RECEIPTS, &[&p.company_id, &p.run_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"receipts": rows.iter().map(receipt_json).collect::<Result<Vec<_>, _>>()?})) // read-only: tx dropped, never committed
        }
        Db::Claim(p) => {
            let key = p.idempotency_key.trim();
            let (inserted, row) = match tx.query_opt(SQL_CLAIM_TOOL_EXECUTION_RECEIPT, &[&p.company_id, &p.run_id, &p.tool, &key, &p.parameters]).await.map_err(pre)? {
                Some(r) => (true, r),
                None => (false, tx.query_opt(SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY, &[&p.company_id, &p.run_id, &p.tool, &key]).await.map_err(pre)?.ok_or(DBERR)?),
            };
            let outcome = match (inserted, ToolReceiptStatus::parse(&col::<String>(&row, 5)?).map_err(|_| DBERR)?) {
                (true, _) => "claimed", (false, ToolReceiptStatus::Completed) => "replay", (false, ToolReceiptStatus::Executing) => "in_progress" };
            Step::Commit(tx, json!({"outcome": outcome, "receipt": receipt_json(&row)?}))
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). claim_execution_receipt_idempotent also requires
/// non-blank run_id/tool and a valid idempotency_key before any PG I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "tool.list_definitions" => { let p = need!(DefsP); exec_db(id, env, OP_TIMEOUT, Db::Defs(p)) }
        "tool.get_definition" => { let p = need!(DefP); exec_db(id, env, OP_TIMEOUT, Db::Def(p)) }
        "tool.list_skills" => { let p = need!(SkillsP); exec_db(id, env, OP_TIMEOUT, Db::Skills(p)) }
        "tool.list_execution_receipts" => { let p = need!(ReceiptsP); exec_db(id, env, OP_TIMEOUT, Db::Receipts(p)) }
        "tool.claim_execution_receipt_idempotent" => {
            let p = need!(ClaimP);
            if p.run_id.trim().is_empty() || p.tool.trim().is_empty() || validate_idempotency_key(&p.idempotency_key).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Claim(p))
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
            ("tool.list_definitions", json!([])), ("tool.list_definitions", json!({})),
            ("tool.list_definitions", json!({"company_id":u,"limit":10,"x":0})),
            ("tool.list_definitions", json!({"company_id":u,"limit":"x"})),
            ("tool.list_definitions", json!({"company_id":u,"enabled":"yes","limit":10})),
            ("tool.get_definition", json!({"company_id":u})),
            ("tool.get_definition", json!({"company_id":u,"tool_id":u,"y":1})),
            ("tool.get_definition", json!({"company_id":u,"tool_id":"z"})),
            ("tool.list_skills", json!({"company_id":u})),
            ("tool.list_skills", json!({"company_id":u,"limit":10,"w":1})),
            ("tool.list_execution_receipts", json!({"company_id":u})),
            ("tool.list_execution_receipts", json!({"company_id":u,"limit":10,"run_id":7})),
            ("tool.claim_execution_receipt_idempotent", json!({})),
            ("tool.claim_execution_receipt_idempotent", json!({"company_id":u,"run_id":"r","tool":"t","idempotency_key":"k"})),
            ("tool.claim_execution_receipt_idempotent", json!({"company_id":u,"run_id":"r","tool":"t","idempotency_key":"k","parameters":{},"v":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // -32602 with an empty DATABASE_URL proves rejection happened before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "tool.list_definitions", None, &e)), -32602);
        assert_eq!(code(&call("tool.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn claim_validation_fires_before_pg_io() {
        let (u, e) = (Uuid::nil(), env(""));
        let base = |key: &str| json!({"company_id":u,"run_id":"r1","tool":"ns.tool","idempotency_key":key,"parameters":{}});
        for p in [base(""), base("   "), base(&"k".repeat(201)),
            json!({"company_id":u,"run_id":"","tool":"ns.tool","idempotency_key":"k","parameters":{}}),
            json!({"company_id":u,"run_id":"  ","tool":"ns.tool","idempotency_key":"k","parameters":{}}),
            json!({"company_id":u,"run_id":"r1","tool":"","idempotency_key":"k","parameters":{}}),
            json!({"company_id":u,"run_id":"r1","tool":"  ","idempotency_key":"k","parameters":{}})] {
            assert_eq!(code(&call("tool.claim_execution_receipt_idempotent", p, &e)), -32602); } // -32602 not -32002: rejected before PG I/O
        assert_eq!(code(&call("tool.claim_execution_receipt_idempotent", base(&"k".repeat(200)), &e)), -32002); // reached DB gate
    }

    #[test]
    fn db_unconfigured_gate_for_all_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("tool.list_definitions", json!({"company_id":u,"limit":10})),
                ("tool.list_definitions", json!({"company_id":u,"enabled":false,"limit":200})),
                ("tool.get_definition", json!({"company_id":u,"tool_id":u})),
                ("tool.list_skills", json!({"company_id":u,"limit":1})),
                ("tool.list_execution_receipts", json!({"company_id":u,"limit":50})),
                ("tool.list_execution_receipts", json!({"company_id":u,"run_id":"r1","limit":10})),
                ("tool.claim_execution_receipt_idempotent", json!({"company_id":u,"run_id":"r1","tool":"ns.tool","idempotency_key":"k","parameters":{"x":1}})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn health_lists_tool_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(caps.len(), 16);
        for m in ["tool.list_definitions", "tool.get_definition", "tool.list_skills", "tool.list_execution_receipts", "tool.claim_execution_receipt_idempotent"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"tool.get_definition","params":{"company_id":"00000000-0000-0000-0000-000000000000","tool_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"tool.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

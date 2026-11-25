#![forbid(unsafe_code)]
//! skill.* JSON-RPC methods: company-scoped skill listing, id/key lookup,
//! upsert, and delete. All PG I/O reuses heartbeat.rs's hardened direct-PG
//! path (exec_db): loopback-only DSN apply-or-reject, DNS permit cap,
//! deadline-gated commit (-32001..-32005), driver abort. Param gates are
//! fail-closed: non-object params or schema mismatch => -32602 and domain
//! rejections (empty required text, malformed inventory/metadata) fire before
//! any PG I/O.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_skill::{SkillCompatibility, SkillRow, SkillSourceType, SkillTrustLevel, SQL_DELETE_SKILL, SQL_GET_SKILL_BY_ID, SQL_GET_SKILL_BY_KEY, SQL_LIST_COMPANY_SKILLS, SQL_UPSERT_SKILL};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ByIdP { company_id: Uuid, skill_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ByKeyP { company_id: Uuid, key: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct UpsertP { company_id: Uuid, key: String, slug: String, name: String, #[serde(default)] description: Option<String>, markdown: String, source_type: SkillSourceType, #[serde(default)] source_locator: Option<String>, #[serde(default)] source_ref: Option<String>, trust_level: SkillTrustLevel, compatibility: SkillCompatibility, file_inventory: Value, #[serde(default)] metadata: Option<Value> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct DeleteP { company_id: Uuid, skill_id: Uuid }

enum Db { List(ListP), ById(ByIdP), ByKey(ByKeyP), Upsert(Box<UpsertP>), Delete(DeleteP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn skill_json(r: &Row) -> Result<Value, Fail> {
    Ok(serde_json::to_value(SkillRow {
        id: r.get(0), company_id: r.get(1), key: r.get(2), slug: r.get(3), name: r.get(4), description: r.get(5), markdown: r.get(6),
        source_type: SkillSourceType::parse(&r.get::<_, String>(7)).map_err(|_| DBERR)?,
        source_locator: r.get(8), source_ref: r.get(9),
        trust_level: SkillTrustLevel::parse(&r.get::<_, String>(10)).map_err(|_| DBERR)?,
        compatibility: SkillCompatibility::parse(&r.get::<_, String>(11)).map_err(|_| DBERR)?,
        file_inventory: r.get::<_, Value>(12), metadata: r.get::<_, Option<Value>>(13), created_at: r.get(14), updated_at: r.get(15),
    }).unwrap_or(Value::Null))
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_COMPANY_SKILLS, &[&p.company_id]).await.map_err(pre)?;
            let skills = rows.iter().map(skill_json).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"skills": skills})) // read-only: tx dropped, never committed
        }
        Db::ById(p) => {
            let row = tx.query_opt(SQL_GET_SKILL_BY_ID, &[&p.skill_id, &p.company_id]).await.map_err(pre)?;
            Step::Done(match row {
                Some(r) => json!({"found":true,"skill":skill_json(&r)?}), None => json!({"found":false}) })
        }
        Db::ByKey(p) => {
            let row = tx.query_opt(SQL_GET_SKILL_BY_KEY, &[&p.company_id, &p.key]).await.map_err(pre)?;
            Step::Done(match row {
                Some(r) => json!({"found":true,"skill":skill_json(&r)?}), None => json!({"found":false}) })
        }
        Db::Upsert(p) => {
            let row = tx.query_one(SQL_UPSERT_SKILL, &[&p.company_id, &p.key, &p.slug, &p.name, &p.description, &p.markdown, &p.source_type.as_str(), &p.source_locator, &p.source_ref, &p.trust_level.as_str(), &p.compatibility.as_str(), &p.file_inventory, &p.metadata]).await.map_err(pre)?;
            Step::Commit(tx, json!({"upserted":true,"skill":skill_json(&row)?}))
        }
        Db::Delete(p) => {
            let row = tx.query_opt(SQL_DELETE_SKILL, &[&p.skill_id, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"deleted":true,"skill":skill_json(&r)?}), None => json!({"deleted":false}) })
        }
    })
}

fn non_empty(s: &str) -> bool { !s.trim().is_empty() }
fn valid_metadata(v: &Option<Value>) -> bool { v.as_ref().is_none_or(|v| v.is_null() || v.is_object()) }
fn valid_upsert(p: &UpsertP) -> bool { non_empty(&p.key) && non_empty(&p.slug) && non_empty(&p.name) && non_empty(&p.markdown) && p.file_inventory.is_array() && valid_metadata(&p.metadata) }

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Required text and JSON-shape domain rules are
/// re-validated before any PG I/O (unset DATABASE_URL still yields -32602).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "skill.list" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "skill.get_by_id" => { let p = need!(ByIdP); exec_db(id, env, OP_TIMEOUT, Db::ById(p)) }
        "skill.get_by_key" => { let p = need!(ByKeyP); if !non_empty(&p.key) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::ByKey(p)) }
        "skill.upsert" => { let p = need!(UpsertP); if !valid_upsert(&p) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Upsert(Box::new(p))) }
        "skill.delete" => { let p = need!(DeleteP); exec_db(id, env, OP_TIMEOUT, Db::Delete(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn upsert(u: Uuid) -> Value { json!({"company_id":u,"key":"k1","slug":"slug","name":"Name","markdown":"# body","source_type":"local_path","trust_level":"markdown_only","compatibility":"compatible","file_inventory":[],"metadata":{"skillKey":"k1"}}) }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let (e, u) = (env(""), Uuid::nil());
        for p in [json!(null), json!([]), json!("x")] {
            assert_eq!(code(&call("skill.list", p, &e)), -32602); }
        assert_eq!(code(&dispatch_with(json!(1), "skill.list", None, &e)), -32602); // missing params
        for (m, p) in [
            ("skill.list", json!({"company_id":u,"x":0})),
            ("skill.list", json!({"company_id":"x"})),
            ("skill.get_by_id", json!({"company_id":u,"skill_id":"x"})),
            ("skill.get_by_key", json!({"company_id":u})),
            ("skill.delete", json!({"company_id":u,"skill_id":u,"z":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        for (field, bad) in [("source_type", "local"), ("trust_level", "team"), ("compatibility", "valid")] {
            let mut p = upsert(u); p[field] = json!(bad);
            assert_eq!(code(&call("skill.upsert", p, &e)), -32602, "{field}"); }
        for field in ["key", "slug", "name", "markdown"] {
            let mut p = upsert(u); p[field] = json!("  ");
            assert_eq!(code(&call("skill.upsert", p, &e)), -32602, "{field}"); }
        for bad in [json!({}), json!("x"), json!(5)] {
            let mut p = upsert(u); p["file_inventory"] = bad;
            assert_eq!(code(&call("skill.upsert", p, &e)), -32602); }
        for bad in [json!([]), json!("x"), json!(5)] {
            let mut p = upsert(u); p["metadata"] = bad;
            assert_eq!(code(&call("skill.upsert", p, &e)), -32602); }
        assert_eq!(code(&call("skill.get_by_key", json!({"company_id":u,"key":" \t"}), &e)), -32602);
        let mut ok_opt = upsert(u); ok_opt["description"] = json!(null); ok_opt["source_locator"] = json!(null); ok_opt["source_ref"] = json!(null); ok_opt["metadata"] = json!(null);
        assert_eq!(code(&call("skill.upsert", ok_opt, &e)), -32002); // optional fields: null/missing ok
    }

    #[test]
    fn pre_io_rejection_before_any_pg_io() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves rejection precedes DSN checks
        assert_eq!(code(&call("skill.get_by_key", json!({"company_id":u,"key":"   "}), &none)), -32602);
        for field in ["key", "slug", "name", "markdown"] {
            let mut bad = upsert(u); bad[field] = json!("");
            assert_eq!(code(&call("skill.upsert", bad, &none)), -32602, "{field}"); }
        let mut bad_inventory = upsert(u); bad_inventory["file_inventory"] = json!({});
        assert_eq!(code(&call("skill.upsert", bad_inventory, &none)), -32602);
        let mut bad_metadata = upsert(u); bad_metadata["metadata"] = json!([]);
        assert_eq!(code(&call("skill.upsert", bad_metadata, &none)), -32602);
    }

    #[test]
    fn db_unconfigured_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("skill.list", json!({"company_id":u})),
                ("skill.get_by_id", json!({"company_id":u,"skill_id":u})),
                ("skill.get_by_key", json!({"company_id":u,"key":"k1"})),
                ("skill.upsert", upsert(u)),
                ("skill.delete", json!({"company_id":u,"skill_id":u})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn unknown_method() {
        assert_eq!(code(&call("skill.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("skill.", json!({}), &env(""))), -32601);
    }

    #[test]
    fn health_capabilities_include_skill_methods() {
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &env(""))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["skill.list", "skill.get_by_id", "skill.get_by_key", "skill.upsert", "skill.delete"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

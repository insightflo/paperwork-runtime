#![forbid(unsafe_code)]
//! wiki.* JSON-RPC methods: company-scoped failure recording, relevant-entry
//! search, entry listing, and fenced terminal transitions backed by the
//! paperwork-engine-wiki crate's SQL constants, row type, and closed enums.
//! All PG I/O reuses heartbeat.rs's hardened direct-PG path (exec_db):
//! loopback-only DSN apply-or-reject, DNS permit cap, deadline-gated commit
//! (-32001..-32005), driver abort. Param gates are fail-closed: non-object
//! params or schema mismatch => -32602 and domain rejections (blank required
//! text, invalid limit) fire before any PG I/O.
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_wiki::{clamp_list_limit, WikiAudience, WikiEntryRow, WikiStatus, SQL_CLOSE_ENTRY_FENCED, SQL_LIST_WIKI_ENTRIES, SQL_MARK_RESOLVED_FENCED, SQL_RECORD_FAILURE, SQL_SEARCH_RELEVANT, WIKI_INJECTION_FRESH_DAYS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);
const _: fn(Value, Value) -> Value = ok;

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct RecordP { company_id: Uuid, agent_id: Uuid, #[serde(default)] mission_id: Option<Uuid>, pattern: String, cause: String, solution: String, error_code: String, #[serde(default)] step_id: Option<String>, #[serde(default)] audience: Option<WikiAudience> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct SearchP { company_id: Uuid, agent_id: Uuid, now: DateTime<Utc>, #[serde(default)] step_id: Option<String>, #[serde(default = "default_search_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default = "default_list_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResolveP { entry_id: Uuid, company_id: Uuid }

fn default_search_limit() -> i64 { 5 }
fn default_list_limit() -> i64 { 500 }

enum Db { Record(RecordP), Search(SearchP), List(ListP), Resolve(ResolveP), Close(ResolveP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn entry_json(r: &Row) -> Result<Value, Fail> {
    let status = WikiStatus::parse(&r.get::<_, String>(10)).map_err(|_| DBERR)?;
    let audience = WikiAudience::parse(&r.get::<_, String>(11)).map_err(|_| DBERR)?;
    serde_json::to_value(WikiEntryRow { id: r.get(0), company_id: r.get(1), agent_id: r.get(2), mission_id: r.get(3), pattern: r.get(4), cause: r.get(5), solution: r.get(6), error_code: r.get(7), step_id: r.get(8), frequency: r.get(9), status, audience, last_seen_at: r.get(12), resolved_at: r.get(13), created_at: r.get(14), updated_at: r.get(15) }).map_err(|_| DBERR)
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Record(p) => {
            let audience = p.audience.unwrap_or(WikiAudience::Ops).as_str();
            let row = tx.query_opt(SQL_RECORD_FAILURE, &[&p.company_id, &p.agent_id, &p.mission_id, &p.pattern, &p.cause, &p.solution, &p.error_code, &p.step_id, &audience]).await.map_err(pre)?;
            Step::Commit(tx, match row { // no row: agent company-fence rejected the insert, tx wrote nothing
                Some(r) => json!({"recorded":true,"entry":entry_json(&r)?}), None => json!({"recorded":false}) })
        }
        Db::Search(p) => {
            let fresh_since = p.now - chrono::Duration::seconds(WIKI_INJECTION_FRESH_DAYS * 24 * 60 * 60);
            let limit = clamp_list_limit(p.limit);
            let rows = tx.query(SQL_SEARCH_RELEVANT, &[&p.company_id, &p.agent_id, &fresh_since, &p.step_id, &limit]).await.map_err(pre)?;
            let entries = rows.iter().map(entry_json).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"entries": entries})) // read-only: tx dropped, never committed
        }
        Db::List(p) => {
            let limit = clamp_list_limit(p.limit);
            let rows = tx.query(SQL_LIST_WIKI_ENTRIES, &[&p.company_id, &limit]).await.map_err(pre)?;
            let entries = rows.iter().map(entry_json).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"entries": entries})) // read-only: tx dropped, never committed
        }
        Db::Resolve(p) => {
            let row = tx.query_opt(SQL_MARK_RESOLVED_FENCED, &[&p.entry_id, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"resolved":true,"entry":entry_json(&r)?}), None => json!({"resolved":false}) })
        }
        Db::Close(p) => {
            let row = tx.query_opt(SQL_CLOSE_ENTRY_FENCED, &[&p.entry_id, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"closed":true,"entry":entry_json(&r)?}), None => json!({"closed":false}) })
        }
    })
}

fn blank(s: &str) -> bool { s.trim().is_empty() }

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). Required wiki text and limits are re-validated
/// before any PG I/O (unset DATABASE_URL still yields -32602).
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "wiki.record_failure" => { let p = need!(RecordP); if blank(&p.pattern) || blank(&p.cause) || blank(&p.solution) || blank(&p.error_code) { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Record(p)) }
        "wiki.search_relevant" => { let p = need!(SearchP); if p.limit < 1 { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::Search(p)) }
        "wiki.list" => { let p = need!(ListP); if p.limit < 1 { return err(id, -32602, "invalid_params") } exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "wiki.mark_resolved" => { let p = need!(ResolveP); exec_db(id, env, OP_TIMEOUT, Db::Resolve(p)) }
        "wiki.close" => { let p = need!(ResolveP); exec_db(id, env, OP_TIMEOUT, Db::Close(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn record(u: Uuid) -> Value { json!({"company_id":u,"agent_id":u,"pattern":"p","cause":"c","solution":"s","error_code":"E"}) }
    fn search(u: Uuid) -> Value { json!({"company_id":u,"agent_id":u,"now":"2026-06-15T12:00:00Z"}) }
    fn list(u: Uuid) -> Value { json!({"company_id":u}) }
    fn resolve(u: Uuid) -> Value { json!({"entry_id":u,"company_id":u}) }

    #[test]
    fn param_gates_strict_and_bad_enums() {
        let (e, u) = (env(""), Uuid::nil());
        for p in [json!(null), json!([]), json!("x")] {
            assert_eq!(code(&call("wiki.record_failure", p, &e)), -32602); }
        assert_eq!(code(&dispatch_with(json!(1), "wiki.list", None, &e)), -32602); // missing params
        let mut unknown = record(u); unknown["x"] = json!(0);
        let mut bad_audience = record(u); bad_audience["audience"] = json!("public");
        for (m, p) in [
            ("wiki.record_failure", json!({"company_id":u})),
            ("wiki.record_failure", unknown),
            ("wiki.record_failure", bad_audience),
            ("wiki.search_relevant", json!({"company_id":u,"agent_id":u,"now":"not-a-date"})),
            ("wiki.search_relevant", json!({"company_id":u,"agent_id":u,"now":"2026-06-15T12:00:00Z","x":0})),
            ("wiki.list", json!({"company_id":"x"})),
            ("wiki.mark_resolved", json!({"entry_id":"x","company_id":u})),
            ("wiki.close", json!({"entry_id":u,"company_id":u,"z":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        let mut ok_opt = record(u); ok_opt["mission_id"] = json!(null); ok_opt["step_id"] = json!("step"); ok_opt["audience"] = json!("agent");
        assert_eq!(code(&call("wiki.record_failure", ok_opt, &e)), -32002);
        let mut bad_opt = record(u); bad_opt["mission_id"] = json!(5);
        assert_eq!(code(&call("wiki.record_failure", bad_opt, &e)), -32602);
        for field in ["pattern", "cause", "solution", "error_code"] {
            let mut bad = record(u); bad[field] = json!("  ");
            assert_eq!(code(&call("wiki.record_failure", bad, &e)), -32602, "{field}"); }
        for (m, mut p) in [("wiki.search_relevant", search(u)), ("wiki.list", list(u))] {
            for n in [0, -1] { p["limit"] = json!(n); assert_eq!(code(&call(m, p.clone(), &e)), -32602, "{m} {n}"); } }
    }

    #[test]
    fn pre_io_rejection_before_any_pg_io() {
        let (u, none) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL: -32602 proves rejection precedes DSN checks
        for field in ["pattern", "cause", "solution", "error_code"] {
            let mut bad = record(u); bad[field] = json!(" \t ");
            assert_eq!(code(&call("wiki.record_failure", bad, &none)), -32602, "{field}"); }
        for (m, mut p) in [("wiki.search_relevant", search(u)), ("wiki.list", list(u))] {
            p["limit"] = json!(0);
            assert_eq!(code(&call(m, p, &none)), -32602, "{m}"); }
    }

    #[test]
    fn db_unconfigured_for_all_db_methods() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("wiki.record_failure", record(u)),
                ("wiki.search_relevant", search(u)),
                ("wiki.list", list(u)),
                ("wiki.mark_resolved", resolve(u)),
                ("wiki.close", resolve(u)),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn unknown_method_and_health_capabilities() {
        assert_eq!(ok(json!(7), json!({"entries":[]})), json!({"jsonrpc":"2.0","id":7,"result":{"entries":[]}}));
        assert_eq!(code(&call("wiki.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("wiki.", json!({}), &env(""))), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &env(""))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["wiki.record_failure", "wiki.search_relevant", "wiki.list", "wiki.mark_resolved", "wiki.close"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

#![forbid(unsafe_code)]
//! company.* JSON-RPC methods: company CRUD, fenced pause/resume, and atomic
//! issue-counter allocation over the shared direct-PG path (exec_db):
//! loopback-only DSN apply-or-reject, DNS permit cap, deadline-gated commit
//! (-32001..-32005), driver abort. Param gates are fail-closed before any PG
//! I/O: non-object/positional params, unknown fields, wrong types, blank
//! required text, and negative cents => -32602. Reads return Step::Done (tx
//! dropped, never committed); writes commit under the deadline gate.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_company::{clamp_list_limit, CompanyDefaultLanguage, CompanyKind, CompanyRow, CompanyStatus, SQL_CREATE_COMPANY, SQL_GET_COMPANY_BY_ID, SQL_GET_COMPANY_BY_ISSUE_PREFIX, SQL_LIST_COMPANIES, SQL_NEXT_ISSUE_COUNTER, SQL_PAUSE_COMPANY_FENCED, SQL_RESUME_COMPANY_FENCED, SQL_UPDATE_COMPANY};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::FromSql, Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);
const CREATE_KEYS: [&str; 12] = ["name","description","issue_prefix","budget_monthly_cents","spent_monthly_cents","require_board_approval_for_new_agents","timezone","work_product_root","default_language","brand_color","company_kind","allows_code_modify"];
fn default_limit() -> i64 { 50 }

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { #[serde(default = "default_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByIdP { company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByPrefixP { issue_prefix: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct CreateP { name: String, description: Option<String>, issue_prefix: String, budget_monthly_cents: i32, spent_monthly_cents: i32, require_board_approval_for_new_agents: bool, timezone: Option<String>, work_product_root: Option<String>, default_language: CompanyDefaultLanguage, brand_color: Option<String>, company_kind: CompanyKind, allows_code_modify: bool }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct UpdateP { company_id: Uuid, name: Option<String>, description: Option<String>, status: Option<CompanyStatus>, timezone: Option<String>, work_product_root: Option<String>, default_language: Option<CompanyDefaultLanguage>, brand_color: Option<String>, budget_monthly_cents: Option<i32>, spent_monthly_cents: Option<i32>, require_board_approval_for_new_agents: Option<bool>, allows_code_modify: Option<bool> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct PauseP { company_id: Uuid, pause_reason: Option<String> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ResumeP { company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct NextCounterP { company_id: Uuid }

enum Db { List(ListP), GetById(GetByIdP), GetByPrefix(GetByPrefixP), Create(CreateP), Update(UpdateP), Pause(PauseP), Resume(ResumeP), NextCounter(NextCounterP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn to_company(r: &Row) -> Result<CompanyRow, Fail> {
    let (status, language, kind): (String, String, String) = (col(r, 3)?, col(r, 13)?, col(r, 15)?);
    Ok(CompanyRow {
        id: col(r, 0)?, name: col(r, 1)?, description: col(r, 2)?,
        status: CompanyStatus::parse(&status).map_err(|_| DBERR)?, pause_reason: col(r, 4)?, paused_at: col(r, 5)?,
        issue_prefix: col(r, 6)?, issue_counter: col(r, 7)?, budget_monthly_cents: col(r, 8)?, spent_monthly_cents: col(r, 9)?,
        require_board_approval_for_new_agents: col(r, 10)?, timezone: col(r, 11)?, work_product_root: col(r, 12)?,
        default_language: CompanyDefaultLanguage::parse(&language).map_err(|_| DBERR)?, brand_color: col(r, 14)?,
        company_kind: CompanyKind::parse(&kind).map_err(|_| DBERR)?, allows_code_modify: col(r, 16)?, created_at: col(r, 17)?, updated_at: col(r, 18)?,
    })
}
fn company_json(c: &CompanyRow) -> Value {
    json!({"id":c.id,"name":c.name,"description":c.description,"status":c.status.as_str(),"pause_reason":c.pause_reason,"paused_at":c.paused_at.as_ref().map(|t|t.to_rfc3339()),"issue_prefix":c.issue_prefix,"issue_counter":c.issue_counter,"budget_monthly_cents":c.budget_monthly_cents,"spent_monthly_cents":c.spent_monthly_cents,"require_board_approval_for_new_agents":c.require_board_approval_for_new_agents,"timezone":c.timezone,"work_product_root":c.work_product_root,"default_language":c.default_language.as_str(),"brand_color":c.brand_color,"company_kind":c.company_kind.as_str(),"allows_code_modify":c.allows_code_modify,"created_at":c.created_at.to_rfc3339(),"updated_at":c.updated_at.to_rfc3339()})
}
fn one_company(row: Option<Row>) -> Result<Option<Value>, Fail> { Ok(row.map(|r| to_company(&r)).transpose()?.map(|c| company_json(&c))) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_COMPANIES, &[&clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let companies = rows.iter().map(|r| to_company(r).map(|c| company_json(&c))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"companies":companies})) // read-only: tx dropped, never committed
        }
        Db::GetById(p) => {
            let company = one_company(tx.query_opt(SQL_GET_COMPANY_BY_ID, &[&p.company_id]).await.map_err(pre)?)?;
            Step::Done(json!({"company":company})) // read-only: tx dropped, never committed
        }
        Db::GetByPrefix(p) => {
            let company = one_company(tx.query_opt(SQL_GET_COMPANY_BY_ISSUE_PREFIX, &[&p.issue_prefix]).await.map_err(pre)?)?;
            Step::Done(json!({"company":company})) // read-only: tx dropped, never committed
        }
        Db::Create(p) => {
            let (language, kind) = (p.default_language.as_str(), p.company_kind.as_str());
            let row = tx.query_one(SQL_CREATE_COMPANY, &[&p.name,&p.description,&p.issue_prefix,&p.budget_monthly_cents,&p.spent_monthly_cents,&p.require_board_approval_for_new_agents,&p.timezone,&p.work_product_root,&language,&p.brand_color,&kind,&p.allows_code_modify]).await.map_err(pre)?;
            Step::Commit(tx, json!({"company":company_json(&to_company(&row)?)}))
        }
        Db::Update(p) => {
            let (status, language) = (p.status.map(|v| v.as_str()), p.default_language.map(|v| v.as_str()));
            let row = tx.query_opt(SQL_UPDATE_COMPANY, &[&p.company_id,&p.name,&status,&p.description,&p.timezone,&p.work_product_root,&language,&p.brand_color,&p.budget_monthly_cents,&p.spent_monthly_cents,&p.require_board_approval_for_new_agents,&p.allows_code_modify]).await.map_err(pre)?;
            Step::Commit(tx, json!({"company":one_company(row)?}))
        }
        Db::Pause(p) => {
            let company = one_company(tx.query_opt(SQL_PAUSE_COMPANY_FENCED, &[&p.company_id,&p.pause_reason]).await.map_err(pre)?)?;
            Step::Commit(tx, json!({"paused":company.is_some(),"company":company}))
        }
        Db::Resume(p) => {
            let company = one_company(tx.query_opt(SQL_RESUME_COMPANY_FENCED, &[&p.company_id]).await.map_err(pre)?)?;
            Step::Commit(tx, json!({"resumed":company.is_some(),"company":company}))
        }
        Db::NextCounter(p) => {
            let row = tx.query_opt(SQL_NEXT_ISSUE_COUNTER, &[&p.company_id]).await.map_err(pre)?;
            let company = match row { Some(r) => Some((col::<String>(&r, 0)?, col::<i32>(&r, 1)?)), None => None };
            Step::Commit(tx, json!({"company":company.map(|(issue_prefix,issue_counter)| json!({"issue_prefix":issue_prefix,"issue_counter":issue_counter}))}))
        }
    })
}

fn blank(s: &str) -> bool { s.trim().is_empty() }
/// Strict fail-closed gates run before any PG I/O: params must be a JSON
/// object matching the method schema exactly (-32602); semantic rejections
/// are likewise evaluated before DSN parsing or any database connection.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "company.list" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "company.get_by_id" => { let p = need!(GetByIdP); exec_db(id, env, OP_TIMEOUT, Db::GetById(p)) }
        "company.get_by_issue_prefix" => {
            let p = need!(GetByPrefixP);
            if blank(&p.issue_prefix) { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::GetByPrefix(p))
        }
        "company.create" => {
            if !params.and_then(Value::as_object).is_some_and(|o| CREATE_KEYS.iter().all(|k| o.contains_key(*k))) { return err(id, -32602, "invalid_params") }
            let p = need!(CreateP);
            if blank(&p.name) || blank(&p.issue_prefix) || p.budget_monthly_cents < 0 || p.spent_monthly_cents < 0 { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Create(p))
        }
        "company.update" => {
            let p = need!(UpdateP);
            if p.name.as_deref().is_some_and(blank) || p.budget_monthly_cents.is_some_and(|v| v < 0) || p.spent_monthly_cents.is_some_and(|v| v < 0) { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Update(p))
        }
        "company.pause" => { let p = need!(PauseP); exec_db(id, env, OP_TIMEOUT, Db::Pause(p)) }
        "company.resume" => { let p = need!(ResumeP); exec_db(id, env, OP_TIMEOUT, Db::Resume(p)) }
        "company.next_issue_counter" => { let p = need!(NextCounterP); exec_db(id, env, OP_TIMEOUT, Db::NextCounter(p)) }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: &Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }
    fn create_p() -> Value { json!({"name":"Acme","description":null,"issue_prefix":"ACM","budget_monthly_cents":10,"spent_monthly_cents":0,"require_board_approval_for_new_agents":true,"timezone":null,"work_product_root":null,"default_language":"en","brand_color":null,"company_kind":"business","allows_code_modify":false}) }
    fn update_p(u: Uuid) -> Value { json!({"company_id":u,"name":"Acme2","description":null,"status":"active","timezone":null,"work_product_root":null,"default_language":"ko","brand_color":null,"budget_monthly_cents":20,"spent_monthly_cents":1,"require_board_approval_for_new_agents":false,"allows_code_modify":true}) }
    fn valid() -> [(&'static str, Value, &'static str); 8] { let u = Uuid::nil(); [
        ("company.list",json!({"limit":10}),"limit"), ("company.get_by_id",json!({"company_id":u}),"company_id"), ("company.get_by_issue_prefix",json!({"issue_prefix":"ACM"}),"issue_prefix"),
        ("company.create",create_p(),"name"), ("company.update",update_p(u),"company_id"), ("company.pause",json!({"company_id":u,"pause_reason":null}),"company_id"),
        ("company.resume",json!({"company_id":u}),"company_id"), ("company.next_issue_counter",json!({"company_id":u}),"company_id") ] }

    #[test]
    fn param_gates_all_methods_before_any_pg_io() {
        let e = env(""); // empty DATABASE_URL: every -32602 here is proof of pre-I/O rejection
        for (m, p, key) in valid() {
            for bad in [json!(null), json!([])] { assert_eq!(code(&call(m, &bad, &e)), -32602, "{m} positional/null"); }
            assert_eq!(code(&dispatch_with(json!(1), m, None, &e)), -32602, "{m} missing params");
            let mut extra = p.clone(); extra["x"] = json!(1);
            assert_eq!(code(&call(m, &extra, &e)), -32602, "{m} unknown field");
            let mut wrong = p.clone(); wrong[key] = json!(true);
            assert_eq!(code(&call(m, &wrong, &e)), -32602, "{m} wrong type");
            if m != "company.list" {
                let mut missing = p.clone(); missing.as_object_mut().unwrap().remove(key);
                assert_eq!(code(&call(m, &missing, &e)), -32602, "{m} missing field");
            }
        }
        for nullable in ["description","timezone","work_product_root","brand_color"] {
            let mut missing = create_p(); missing.as_object_mut().unwrap().remove(nullable);
            assert_eq!(code(&call("company.create", &missing, &e)), -32602, "create missing {nullable}");
        }
        let u = Uuid::nil();
        for (base, field, bad) in [(create_p(), "company_kind", "Business"), (create_p(), "default_language", "EN"), (update_p(u), "status", "Active")] {
            let mut p = base; p[field] = json!(bad);
            assert_eq!(code(&call(if field == "status" { "company.update" } else { "company.create" }, &p, &e)), -32602, "{field}");
        }
    }

    #[test]
    fn pre_io_semantic_gates() {
        let (u, e) = (Uuid::nil(), ProbeEnv::from_pairs(&[])); // no DATABASE_URL at all
        for s in ["", "  ", "\t\n"] {
            assert_eq!(code(&call("company.get_by_issue_prefix", &json!({"issue_prefix":s}), &e)), -32602);
            let mut c = create_p(); c["name"] = json!(s);
            assert_eq!(code(&call("company.create", &c, &e)), -32602, "create name {s:?}");
            let mut c = create_p(); c["issue_prefix"] = json!(s);
            assert_eq!(code(&call("company.create", &c, &e)), -32602, "create prefix {s:?}");
            let mut up = update_p(u); up["name"] = json!(s);
            assert_eq!(code(&call("company.update", &up, &e)), -32602, "update name {s:?}");
        }
        for field in ["budget_monthly_cents", "spent_monthly_cents"] {
            let mut c = create_p(); c[field] = json!(-1);
            assert_eq!(code(&call("company.create", &c, &e)), -32602, "create {field}");
            let mut up = update_p(u); up[field] = json!(-1);
            assert_eq!(code(&call("company.update", &up, &e)), -32602, "update {field}");
        }
    }

    #[test]
    fn db_unconfigured_for_valid_params() {
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p, _) in valid() { assert_eq!(code(&call(m, &p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn sql_constants_are_fenced_atomic_and_limited() {
        assert!(SQL_LIST_COMPANIES.contains("LIMIT $1"));
        assert!(SQL_PAUSE_COMPANY_FENCED.contains("AND status = 'active'"));
        assert!(SQL_RESUME_COMPANY_FENCED.contains("AND status = 'paused'"));
        assert!(SQL_NEXT_ISSUE_COUNTER.contains("issue_counter = issue_counter + 1"));
    }

    #[test]
    fn company_json_exact_key_set_and_rfc3339() {
        let now = chrono::Utc::now();
        let c = CompanyRow { id: Uuid::nil(), name: "Acme".into(), description: None, status: CompanyStatus::Active, pause_reason: None, paused_at: None, issue_prefix: "ACM".into(), issue_counter: 1, budget_monthly_cents: 10, spent_monthly_cents: 0, require_board_approval_for_new_agents: true, timezone: None, work_product_root: None, default_language: CompanyDefaultLanguage::En, brand_color: None, company_kind: CompanyKind::Business, allows_code_modify: false, created_at: now, updated_at: now };
        let v = company_json(&c);
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect(); keys.sort_unstable();
        let mut expected = vec!["id","name","description","status","pause_reason","paused_at","issue_prefix","issue_counter","budget_monthly_cents","spent_monthly_cents","require_board_approval_for_new_agents","timezone","work_product_root","default_language","brand_color","company_kind","allows_code_modify","created_at","updated_at"]; expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(v["created_at"], json!(now.to_rfc3339()));
    }

    #[test]
    fn health_lists_company_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for (m, _, _) in valid() { assert!(caps.contains(&m), "missing {m}"); }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"company.list","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"company.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }

    #[test]
    #[ignore] // live PG: set PAPERWORK_ENGINE_TEST_DATABASE_URL
    fn live_pg_create_fence_resume_and_counter() {
        let url = std::env::var("PAPERWORK_ENGINE_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let fixture = |sql: String| rt.block_on(async {
            let (c, cn) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
            let j = tokio::spawn(cn); c.batch_execute(&sql).await.unwrap(); j.abort(); let _ = j.await;
        });
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let mut p = create_p(); p["issue_prefix"] = json!(format!("L{n:X}").chars().take(12).collect::<String>());
        let e = env(&url);
        let created = call("company.create", &p, &e);
        let cid = created["result"]["company"]["id"].as_str().unwrap().to_string();
        let got = call("company.get_by_issue_prefix", &json!({"issue_prefix":p["issue_prefix"]}), &e);
        assert_eq!(got["result"]["company"]["id"], json!(cid));
        let pause = json!({"company_id":cid,"pause_reason":"test"});
        assert_eq!(call("company.pause", &pause, &e)["result"]["paused"], true);
        assert_eq!(call("company.pause", &pause, &e)["result"], json!({"paused":false,"company":null}));
        assert_eq!(call("company.resume", &json!({"company_id":cid}), &e)["result"]["resumed"], true);
        let first = call("company.next_issue_counter", &json!({"company_id":cid}), &e)["result"]["company"]["issue_counter"].as_i64().unwrap();
        let second = call("company.next_issue_counter", &json!({"company_id":cid}), &e)["result"]["company"]["issue_counter"].as_i64().unwrap();
        assert_eq!(second, first + 1);
        fixture(format!("DELETE FROM companies WHERE id = '{cid}'"));
    }
}

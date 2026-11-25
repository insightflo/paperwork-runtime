#![forbid(unsafe_code)]
//! secret.* JSON-RPC methods: metadata-only secret registry reads plus one
//! fenced latest-version bump over the shared direct-PG path (exec_db):
//! loopback-only DSN apply-or-reject, DNS permit cap, deadline-gated commit
//! (-32001..-32005), driver abort. Param gates are fail-closed and run
//! before any PG I/O: non-object/positional params, unknown fields, and
//! wrong-typed params => -32602; an empty name and invalid version-bump
//! arithmetic are also rejected pre-I/O via engine-secret's
//! validate_version_bump. The domain crate's row decoders are sync-postgres
//! flavored and do not cross to tokio-postgres, so the same SQL text is
//! re-executed on the shared tokio transaction and rows are decoded
//! column-by-column in the documented SELECT order into the domain row
//! structs, which serialize to the metadata-only key set. Reads return
//! Step::Done (tx dropped, never committed); the single write commits under
//! the deadline gate.
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_secret::{clamp_list_limit, validate_version_bump, SecretMetadataRow, SecretVersionMetadataRow, SQL_BUMP_SECRET_LATEST_VERSION_FENCED, SQL_GET_SECRET_METADATA_BY_ID, SQL_GET_SECRET_METADATA_BY_NAME, SQL_LIST_SECRET_METADATA, SQL_LIST_SECRET_VERSION_METADATA};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::FromSql, Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);
fn default_limit() -> i64 { 50 }

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListP { company_id: Uuid, #[serde(default = "default_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByIdP { company_id: Uuid, secret_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GetByNameP { company_id: Uuid, name: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListVersionsP { company_id: Uuid, secret_id: Uuid, #[serde(default = "default_limit")] limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct BumpP { company_id: Uuid, secret_id: Uuid, expected_latest_version: i32, new_version: i32 }

enum Db { List(ListP), GetById(GetByIdP), GetByName(GetByNameP), ListVersions(ListVersionsP), Bump(BumpP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn to_secret(r: &Row) -> Result<SecretMetadataRow, Fail> { Ok(SecretMetadataRow {
    id: col(r, 0)?, company_id: col(r, 1)?, name: col(r, 2)?, provider: col(r, 3)?, external_ref: col(r, 4)?,
    latest_version: col(r, 5)?, description: col(r, 6)?, created_by_agent_id: col(r, 7)?,
    created_by_user_id: col(r, 8)?, created_at: col(r, 9)?, updated_at: col(r, 10)? }) }
fn to_version(r: &Row) -> Result<SecretVersionMetadataRow, Fail> { Ok(SecretVersionMetadataRow {
    id: col(r, 0)?, secret_id: col(r, 1)?, version: col(r, 2)?, created_by_agent_id: col(r, 3)?,
    created_by_user_id: col(r, 4)?, created_at: col(r, 5)?, revoked_at: col(r, 6)? }) }

fn as_json<T: serde::Serialize>(v: &T) -> Result<Value, Fail> { serde_json::to_value(v).map_err(|_| DBERR) }
fn applied_json(o: Option<SecretMetadataRow>) -> Result<Value, Fail> { match o {
    Some(s) => Ok(json!({"applied": true, "secret": as_json(&s)?})),
    None => Ok(json!({"applied": false, "reason": "fenced"})) } }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::List(p) => {
            let rows = tx.query(SQL_LIST_SECRET_METADATA, &[&p.company_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let secrets = rows.iter().map(|r| to_secret(r).and_then(|s| as_json(&s))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"secrets": secrets})) // read-only: tx dropped, never committed
        }
        Db::GetById(p) => {
            let row = tx.query_opt(SQL_GET_SECRET_METADATA_BY_ID, &[&p.secret_id, &p.company_id]).await.map_err(pre)?.map(|r| to_secret(&r)).transpose()?;
            Step::Done(json!({"secret": row.map(|s| as_json(&s)).transpose()?})) // read-only: tx dropped, never committed
        }
        Db::GetByName(p) => {
            let row = tx.query_opt(SQL_GET_SECRET_METADATA_BY_NAME, &[&p.company_id, &p.name]).await.map_err(pre)?.map(|r| to_secret(&r)).transpose()?;
            Step::Done(json!({"secret": row.map(|s| as_json(&s)).transpose()?})) // read-only: tx dropped, never committed
        }
        Db::ListVersions(p) => {
            let rows = tx.query(SQL_LIST_SECRET_VERSION_METADATA, &[&p.company_id, &p.secret_id, &clamp_list_limit(p.limit)]).await.map_err(pre)?;
            let versions = rows.iter().map(|r| to_version(r).and_then(|v| as_json(&v))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"versions": versions})) // read-only: tx dropped, never committed
        }
        Db::Bump(p) => {
            let row = tx.query_opt(SQL_BUMP_SECRET_LATEST_VERSION_FENCED, &[&p.secret_id, &p.company_id, &p.expected_latest_version, &p.new_version]).await.map_err(pre)?.map(|r| to_secret(&r)).transpose()?;
            Step::Commit(tx, applied_json(row)?)
        }
    })
}

/// Strict fail-closed gates run before any PG I/O: params must be a JSON
/// object matching the method schema exactly (-32602); get_by_name rejects an
/// empty name and bump_latest_version_fenced re-validates the version
/// arithmetic pre-I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "secret.list" => { let p = need!(ListP); exec_db(id, env, OP_TIMEOUT, Db::List(p)) }
        "secret.get_by_id" => { let p = need!(GetByIdP); exec_db(id, env, OP_TIMEOUT, Db::GetById(p)) }
        "secret.get_by_name" => {
            let p = need!(GetByNameP);
            if p.name.trim().is_empty() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::GetByName(p))
        }
        "secret.list_versions" => { let p = need!(ListVersionsP); exec_db(id, env, OP_TIMEOUT, Db::ListVersions(p)) }
        "secret.bump_latest_version_fenced" => {
            let p = need!(BumpP);
            if validate_version_bump(p.expected_latest_version, p.new_version).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Bump(p))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: &Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }

    #[test]
    fn param_gates_and_unknown_method() {
        let (u, e) = (Uuid::nil(), env(""));
        let bp = |extra: &[(&str, Value)]| {
            let mut o = serde_json::Map::from_iter([("company_id".into(), json!(u)), ("secret_id".into(), json!(u)), ("expected_latest_version".into(), json!(1)), ("new_version".into(), json!(2))]);
            for (k, v) in extra { o.insert((*k).into(), v.clone()); }
            Value::Object(o)
        };
        for (m, p) in [
            ("secret.list", json!(null)), ("secret.list", json!([])), ("secret.list", json!({})),
            ("secret.list", json!({"company_id":u,"x":0})), ("secret.list", json!({"company_id":1})),
            ("secret.list", json!({"company_id":u,"limit":"50"})), ("secret.list", json!({"company_id":u,"limit":true})),
            ("secret.get_by_id", json!([])), ("secret.get_by_id", json!({"company_id":u})),
            ("secret.get_by_id", json!({"company_id":u,"secret_id":u,"y":1})), ("secret.get_by_id", json!({"company_id":u,"secret_id":"nope"})),
            ("secret.get_by_name", json!({})), ("secret.get_by_name", json!({"company_id":u})),
            ("secret.get_by_name", json!({"company_id":u,"name":1})), ("secret.get_by_name", json!({"company_id":u,"name":"n","z":2})),
            ("secret.list_versions", json!([])), ("secret.list_versions", json!({"company_id":u,"secret_id":u,"w":3})),
            ("secret.list_versions", json!({"company_id":u,"secret_id":u,"limit":0.5})), ("secret.list_versions", json!({"company_id":u})),
            ("secret.bump_latest_version_fenced", json!({})), ("secret.bump_latest_version_fenced", bp(&[("q", json!(0))])),
            ("secret.bump_latest_version_fenced", bp(&[("expected_latest_version", json!("1"))])),
        ] { assert_eq!(code(&call(m, &p, &e)), -32602, "{m} {p}"); }
        // -32602 with an empty DATABASE_URL proves rejection before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "secret.list", None, &e)), -32602);
        assert_eq!(code(&call("secret.nope", &json!({}), &e)), -32601);
    }

    #[test]
    fn pre_io_semantic_gates() {
        let (u, e) = (Uuid::nil(), env("")); // no PG I/O can succeed
        for name in ["", "   ", "\t \n"] {
            assert_eq!(code(&call("secret.get_by_name", &json!({"company_id":u,"name":name}), &e)), -32602, "{name:?}");
        }
        for (exp, new) in [(0, 1), (-2, -1), (2, 2), (2, 4), (i32::MAX, i32::MAX)] {
            let p = json!({"company_id":u,"secret_id":u,"expected_latest_version":exp,"new_version":new});
            assert_eq!(code(&call("secret.bump_latest_version_fenced", &p, &e)), -32602, "{exp}->{new}");
        }
    }

    #[test]
    fn db_unconfigured_for_valid_params() {
        let u = Uuid::nil();
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("secret.list", json!({"company_id":u})), ("secret.list", json!({"company_id":u,"limit":10})),
                ("secret.get_by_id", json!({"company_id":u,"secret_id":u})),
                ("secret.get_by_name", json!({"company_id":u,"name":"api-key"})),
                ("secret.list_versions", json!({"company_id":u,"secret_id":u})),
                ("secret.bump_latest_version_fenced", json!({"company_id":u,"secret_id":u,"expected_latest_version":1,"new_version":2})),
            ] { assert_eq!(code(&call(m, &p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn sql_constants_are_fenced_and_metadata_only() {
        for sql in [SQL_LIST_SECRET_METADATA, SQL_GET_SECRET_METADATA_BY_ID, SQL_GET_SECRET_METADATA_BY_NAME, SQL_LIST_SECRET_VERSION_METADATA, SQL_BUMP_SECRET_LATEST_VERSION_FENCED] {
            // SECURITY INVARIANT: metadata-only surface, proven on the constants.
            assert!(!sql.contains("material"), "{sql}");
            assert!(!sql.contains("value_sha256"), "{sql}");
        }
        for sql in [SQL_LIST_SECRET_METADATA, SQL_GET_SECRET_METADATA_BY_ID, SQL_GET_SECRET_METADATA_BY_NAME, SQL_BUMP_SECRET_LATEST_VERSION_FENCED] {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
        assert!(SQL_LIST_SECRET_VERSION_METADATA.contains("EXISTS (SELECT 1 FROM company_secrets s WHERE s.id = sv.secret_id AND s.company_id = $1)"));
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("AND latest_version = $3"));
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("SET latest_version = $4"));
    }

    const SECRET_KEYS: [&str; 11] = ["id", "company_id", "name", "provider", "external_ref", "latest_version", "description", "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"];
    const VERSION_KEYS: [&str; 7] = ["id", "secret_id", "version", "created_by_agent_id", "created_by_user_id", "created_at", "revoked_at"];
    fn assert_shape(row: &impl serde::Serialize, expected: &[&str]) {
        let v = serde_json::to_value(row).unwrap();
        let s = v.to_string();
        assert!(!s.contains("material"), "{s}");
        assert!(!s.contains("value_sha256"), "{s}");
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut e = expected.to_vec();
        keys.sort_unstable(); e.sort_unstable();
        assert_eq!(keys, e);
    }

    #[test]
    fn rows_serialize_to_metadata_only_key_sets() {
        let now = chrono::Utc::now();
        let s = SecretMetadataRow { id: Uuid::nil(), company_id: Uuid::nil(), name: "api-key".into(), provider: "local_encrypted".into(), external_ref: None, latest_version: 2, description: None, created_by_agent_id: None, created_by_user_id: None, created_at: now, updated_at: now };
        let v = SecretVersionMetadataRow { id: Uuid::nil(), secret_id: Uuid::nil(), version: 2, created_by_agent_id: None, created_by_user_id: Some("u1".into()), created_at: now, revoked_at: None };
        assert_shape(&s, &SECRET_KEYS);
        assert_shape(&v, &VERSION_KEYS);
    }

    #[test]
    fn health_lists_secret_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["secret.list", "secret.get_by_id", "secret.get_by_name", "secret.list_versions", "secret.bump_latest_version_fenced"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"secret.list","params":{"company_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"secret.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }

    #[test]
    #[ignore] // live PG: set PAPERWORK_ENGINE_TEST_DATABASE_URL
    fn live_pg_metadata_only_and_fencing() {
        let url = std::env::var("PAPERWORK_ENGINE_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (a, b, s1) = (Uuid::from_u128(31), Uuid::from_u128(32), Uuid::from_u128(33));
        let fixture = |sql: String| rt.block_on(async {
            let (c, cn) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
            let j = tokio::spawn(cn);
            c.batch_execute(&sql).await.unwrap();
            j.abort(); let _ = j.await;
        });
        fixture(format!("DELETE FROM company_secrets WHERE company_id in ('{a}','{b}'); DELETE FROM companies WHERE id in ('{a}','{b}'); INSERT INTO companies (id,name,issue_prefix) VALUES ('{a}','t','TA'),('{b}','t','TB'); INSERT INTO company_secrets (id,company_id,name,provider,latest_version) VALUES ('{s1}','{a}','k1','local_encrypted',2)"));
        let e = env(&url);
        let out = call("secret.list", &json!({"company_id":a}), &e);
        let secrets = out["result"]["secrets"].as_array().unwrap();
        assert_eq!(secrets.len(), 1);
        let s = secrets[0].to_string(); // SECURITY INVARIANT: metadata-only
        assert!(!s.contains("material") && !s.contains("value_sha256"), "{s}");
        assert_eq!(secrets[0]["latest_version"], 2);
        assert!(call("secret.get_by_id", &json!({"company_id":b,"secret_id":s1}), &e)["result"]["secret"].is_null()); // cross-company fence
        assert_eq!(call("secret.list_versions", &json!({"company_id":a,"secret_id":s1}), &e)["result"]["versions"].as_array().unwrap().len(), 0);
        let bump = json!({"company_id":a,"secret_id":s1,"expected_latest_version":2,"new_version":3});
        assert_eq!(call("secret.bump_latest_version_fenced", &bump, &e)["result"]["applied"], true);
        assert_eq!(call("secret.bump_latest_version_fenced", &bump, &e)["result"], json!({"applied":false,"reason":"fenced"})); // replay fenced
        fixture(format!("DELETE FROM company_secrets WHERE company_id in ('{a}','{b}'); DELETE FROM companies WHERE id in ('{a}','{b}')"));
    }
}

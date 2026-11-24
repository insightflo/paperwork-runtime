#![forbid(unsafe_code)]
//! schedule.* JSON-RPC methods: advance-window validation, due-schedule
//! listing (read-only, never commits), fenced advancement, and enable toggles.
//! DB methods ride the shared direct-PG helper in `heartbeat` (loopback-only
//! DSN, DNS permit cap, deadline-gated commit, driver abort). Param gates are
//! fail-closed: non-object params or schema mismatch => -32602 before any I/O.
use crate::heartbeat::{err, exec_db, ok, pre, DbOp, Fail, Op, Step};
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_schedule::{clamp_due_limit, validate_advance_window, SQL_ADVANCE_SCHEDULE_FENCED, SQL_LIST_DUE_SCHEDULES, SQL_SET_SCHEDULE_ENABLED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{Client, Row};
use uuid::Uuid;

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct WindowP { last_run_at: DateTime<Utc>, next_run_at: DateTime<Utc> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ListDueP { company_id: Uuid, due_before: DateTime<Utc>, limit: i64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct AdvanceP { schedule_id: Uuid, company_id: Uuid, last_run_at: DateTime<Utc>, next_run_at: DateTime<Utc>, #[serde(default)] expected_next_run_at: Option<DateTime<Utc>> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct EnabledP { schedule_id: Uuid, company_id: Uuid, enabled: bool }
enum Db { ListDue(ListDueP), AdvanceFenced(AdvanceP), SetEnabled(EnabledP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> Op<'x> { Box::pin(run_op(c, self)) } }

fn due_json(r: &Row) -> Value { json!({"id": r.get::<_, Uuid>(0), "company_id": r.get::<_, Uuid>(1), "agent_id": r.get::<_, Uuid>(2), "cron_expression": r.get::<_, String>(3), "timezone": r.get::<_, String>(4), "mission_id": r.get::<_, Option<Uuid>>(5), "enabled": r.get::<_, bool>(6), "last_run_at": r.get::<_, Option<DateTime<Utc>>>(7), "next_run_at": r.get::<_, Option<DateTime<Utc>>>(8)}) }

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::ListDue(p) => {
            let rows = tx.query(SQL_LIST_DUE_SCHEDULES, &[&p.company_id, &p.due_before, &clamp_due_limit(p.limit)]).await.map_err(pre)?;
            Step::Done(json!({"schedules": rows.iter().map(due_json).collect::<Vec<_>>()})) // read-only: tx dropped, never committed
        }
        Db::AdvanceFenced(p) => {
            let row = tx.query_opt(SQL_ADVANCE_SCHEDULE_FENCED, &[&p.schedule_id, &p.last_run_at, &p.next_run_at, &p.company_id, &p.expected_next_run_at]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"applied":true,"id":r.get::<_, Uuid>(0),"company_id":r.get::<_, Uuid>(1),"agent_id":r.get::<_, Uuid>(2),"last_run_at":r.get::<_, Option<DateTime<Utc>>>(3),"next_run_at":r.get::<_, Option<DateTime<Utc>>>(4),"updated_at":r.get::<_, DateTime<Utc>>(5)}),
                None => json!({"applied": false}) })
        }
        Db::SetEnabled(p) => {
            let row = tx.query_opt(SQL_SET_SCHEDULE_ENABLED, &[&p.schedule_id, &p.enabled, &p.company_id]).await.map_err(pre)?;
            Step::Commit(tx, match row {
                Some(r) => json!({"updated":true,"id":r.get::<_, Uuid>(0),"enabled":r.get::<_, bool>(1),"updated_at":r.get::<_, DateTime<Utc>>(2)}),
                None => json!({"updated": false}) })
        }
    })
}

pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    dispatch_with_timeout(id, method, params, env, Duration::from_secs(6))
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). advance_fenced re-validates the window pre-I/O.
fn dispatch_with_timeout(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv, op_timeout: Duration) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "schedule.validate_advance_window" => {
            let p = need!(WindowP);
            ok(id, match validate_advance_window(p.last_run_at, p.next_run_at) {
                Ok(()) => json!({"valid": true}),
                Err(_) => json!({"valid": false, "reason": "invalid_advance_window"}),
            })
        }
        "schedule.list_due" => { let p = need!(ListDueP); exec_db(id, Db::ListDue(p), env, op_timeout) }
        "schedule.advance_fenced" => {
            let p = need!(AdvanceP);
            if validate_advance_window(p.last_run_at, p.next_run_at).is_err() { return err(id, -32602, "invalid_params") }
            exec_db(id, Db::AdvanceFenced(p), env, op_timeout)
        }
        "schedule.set_enabled" => { let p = need!(EnabledP); exec_db(id, Db::SetEnabled(p), env, op_timeout) }
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
    fn validate_advance_window_matrix() {
        let (e, last) = (&env(""), "2026-01-01T00:00:00Z");
        let v = |p: Value| call("schedule.validate_advance_window", p, e);
        assert_eq!(v(json!({"last_run_at":last,"next_run_at":"2026-01-01T00:00:01Z"}))["result"], json!({"valid":true}));
        for next in [last, "2025-12-31T23:59:59Z"] {
            assert_eq!(v(json!({"last_run_at":last,"next_run_at":next}))["result"], json!({"valid":false,"reason":"invalid_advance_window"}), "{next}"); }
        for bad in [json!(null), json!([]), json!("x"), json!({}), json!({"last_run_at":last}), json!({"last_run_at":1,"next_run_at":2}), json!({"last_run_at":last,"next_run_at":"2026-01-01T00:00:01Z","z":0})] {
            assert_eq!(code(&v(bad.clone())), -32602, "{bad}"); }
        assert_eq!(code(&dispatch_with(json!(1), "schedule.validate_advance_window", None, e)), -32602); // missing params
    }

    #[test]
    fn param_gates_are_fail_closed() {
        let (e, u, t) = (&env(""), Uuid::nil(), "2026-01-01T00:00:00Z");
        let good = [
            ("schedule.list_due", json!({"company_id":u,"due_before":t,"limit":10})),
            ("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t,"next_run_at":"2026-01-01T00:00:01Z"})),
            ("schedule.set_enabled", json!({"schedule_id":u,"company_id":u,"enabled":true})),
        ];
        for (m, p) in &good { // valid shape reaches the DB gate -> -32002 with no DATABASE_URL
            assert_eq!(code(&call(m, p.clone(), e)), -32002, "{m}"); }
        for bad in [
            ("schedule.list_due", json!({"company_id":u,"due_before":t})),
            ("schedule.list_due", json!({"company_id":u,"due_before":t,"limit":10,"x":1})),
            ("schedule.list_due", json!({"company_id":"not-a-uuid","due_before":t,"limit":10})),
            ("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t})),
            ("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t,"next_run_at":"2026-01-01T00:00:01Z","expected_next_run_at":5})),
            ("schedule.set_enabled", json!({"schedule_id":u,"company_id":u,"enabled":"yes"})),
            ("schedule.set_enabled", json!({"schedule_id":u,"enabled":true})),
        ] { assert_eq!(code(&call(bad.0, bad.1, e)), -32602, "{}", bad.0); }
        // invalid window rejected before ANY PG I/O: -32602 even with no DSN
        for next in [t, "2025-12-31T23:59:59Z"] {
            assert_eq!(code(&call("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t,"next_run_at":next}), e)), -32602, "{next}"); }
        assert_eq!(code(&call("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t,"next_run_at":t}), &env("postgres://u@127.0.0.1:1/db?sslmode=disable"))), -32602); // still -32602 with a parseable DSN
    }

    #[test]
    fn db_unconfigured_pre_dial() {
        let (u, t) = (Uuid::nil(), "2026-01-01T00:00:00Z");
        let calls = [
            ("schedule.list_due", json!({"company_id":u,"due_before":t,"limit":10})),
            ("schedule.advance_fenced", json!({"schedule_id":u,"company_id":u,"last_run_at":t,"next_run_at":"2026-01-01T00:00:01Z"})),
            ("schedule.set_enabled", json!({"schedule_id":u,"company_id":u,"enabled":false})),
        ];
        for dsn in ["", "host=127.0.0.1 port=1 user=u", "host=127.0.0.1 sslmode=disable", "host=/tmp user=u sslmode=disable", "host=192.0.2.1 port=1 user=u sslmode=disable"] {
            for (m, p) in &calls {
                let e = if dsn.is_empty() { ProbeEnv::from_pairs(&[]) } else { env(dsn) };
                let r = call(m, p.clone(), &e);
                assert_eq!((code(&r), r["error"]["data"].clone()), (-32002, json!({"outcome":"not_committed","retryable":false})), "{m} {dsn}"); } }
    }

    #[test]
    fn unknown_schedule_method_and_health_capabilities() {
        assert_eq!(code(&call("schedule.nope", json!({}), &env(""))), -32601);
        assert_eq!(code(&call("schedule.", json!({}), &env(""))), -32601);
        let caps = crate::handle_with(br#"{"jsonrpc":"2.0","id":9,"method":"engine.health"}"#, &ProbeEnv::from_pairs(&[]))["result"]["capabilities"].as_array().unwrap().clone();
        for m in ["schedule.validate_advance_window", "schedule.list_due", "schedule.advance_fenced", "schedule.set_enabled"] {
            assert!(caps.contains(&json!(m)), "{m}"); }
    }
}

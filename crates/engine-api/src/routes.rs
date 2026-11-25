#![forbid(unsafe_code)]
//! Read-only REST-to-RPC route mapping with fail-closed UUID and method validation.

use crate::{RpcDispatcher, RpcRequest};
use serde_json::{json, Value};
use std::sync::Arc;

const DEFAULT_LIST_LIMIT: i64 = 50;

#[derive(Debug)]
pub enum RestOutcome {
    NotMatched,
    MethodNotAllowed,
    Response { status: u16, body: Vec<u8> },
}

fn json_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec())
}
fn response(status: u16, value: Value) -> RestOutcome {
    RestOutcome::Response { status, body: json_bytes(value) }
}
fn bad_request() -> RestOutcome {
    response(400, json!({"error": "bad_request"}))
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36 && bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

fn route(path: &str) -> Option<(&'static str, Option<&str>, bool)> {
    let path = path.split('?').next().unwrap_or(path);
    if path == "/api/companies" { return Some(("company.list", None, false)); }
    let rest = path.strip_prefix("/api/companies/")?;
    let mut parts = rest.split('/');
    let company_id = parts.next()?;
    let resource = parts.next();
    if parts.next().is_some() || company_id.is_empty() { return None; }
    let (method, default_limit) = match resource {
        None => ("company.get_by_id", false),
        Some("missions") => ("mission.list", false),
        Some("workflows") => ("workflow.list", false),
        Some("issues") => ("issue.list", false),
        Some("agents") => ("agent.list", false),
        Some("approvals") => ("approval.list", true),
        Some("decisions") => ("decision.list", true),
        Some("secrets") => ("secret.list", true),
        Some("skills") => ("skill.list", false),
        Some("wiki") => ("wiki.list", true),
        Some("worktrees") => ("worktree.list", false),
        _ => return None,
    };
    Some((method, Some(company_id), default_limit))
}

fn rpc_status(code: i64) -> u16 {
    match code { -32602 => 400, -32601 => 501, _ => 502 }
}

/// Resolves a read-only REST request through the dispatcher. The JSON-RPC result is
/// forwarded as the REST body; malformed dispatcher envelopes fail closed as bad gateway.
pub async fn handle_rest(method: &str, path: &str, dispatcher: &Arc<dyn RpcDispatcher>) -> RestOutcome {
    let Some((rpc_method, company_id, default_limit)) = route(path) else { return RestOutcome::NotMatched };
    if method != "GET" { return RestOutcome::MethodNotAllowed; }
    if company_id.is_some_and(|id| !valid_uuid(id)) { return bad_request(); }
    let mut params = company_id.map_or_else(|| json!({}), |id| json!({"company_id": id}));
    if default_limit {
        if let Some(fields) = params.as_object_mut() {
            fields.insert("limit".to_owned(), json!(DEFAULT_LIST_LIMIT));
        }
    }
    let request = RpcRequest {
        id: json!(format!("rest:{rpc_method}")),
        method: rpc_method.to_owned(),
        params: Some(params),
    };
    let rpc = dispatcher.dispatch(request).await;
    match (rpc.get("result"), rpc.get("error")) {
        (Some(result), None) => response(200, result.clone()),
        (None, Some(error)) => {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
            response(rpc_status(code), json!({"error": "rpc_error", "rpc_code": code}))
        }
        _ => response(502, json!({"error": "rpc_error", "rpc_code": -32603})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::ClosureDispatcher;
    use std::sync::Mutex;

    fn dispatcher(f: impl Fn(RpcRequest) -> Value + Send + Sync + 'static) -> Arc<dyn RpcDispatcher> {
        Arc::new(ClosureDispatcher::new(f))
    }
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }
    fn status(outcome: RestOutcome) -> u16 {
        match outcome { RestOutcome::Response { status, .. } => status, _ => panic!("expected response") }
    }
    type RecordedCalls = Arc<Mutex<Vec<(String, Value)>>>;
    fn recording_dispatcher() -> (Arc<dyn RpcDispatcher>, RecordedCalls) {
        let calls: RecordedCalls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        let dispatcher = dispatcher(move |request| {
            seen.lock().unwrap().push((request.method, request.params.unwrap_or(Value::Null)));
            json!({"result":{}})
        });
        (dispatcher, calls)
    }

    #[test]
    fn uuid_gate_happens_before_dispatch_on_company_scoped_routes() {
        let (dispatcher, calls) = recording_dispatcher();
        for suffix in ["", "/missions", "/approvals", "/decisions", "/secrets", "/skills", "/wiki", "/worktrees"] {
            let path = format!("/api/companies/not-a-uuid{suffix}");
            assert_eq!(status(block_on(handle_rest("GET", &path, &dispatcher))), 400, "{path}");
        }
        assert_eq!(calls.lock().unwrap().len(), 0);
    }

    #[test]
    fn query_strings_are_stripped_and_wrong_methods_are_rejected() {
        let dispatcher = dispatcher(|request| json!({"jsonrpc":"2.0","id":request.id,"result":{"method":request.method}}));
        assert!(matches!(block_on(handle_rest("POST", "/api/companies", &dispatcher)), RestOutcome::MethodNotAllowed));
        let outcome = block_on(handle_rest("GET", "/api/companies?ignored=yes", &dispatcher));
        match outcome {
            RestOutcome::Response { status, body } => {
                assert_eq!(status, 200);
                assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["method"], json!("company.list"));
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn all_seven_new_routes_map_exact_rpc_methods_and_params() {
        let (dispatcher, calls) = recording_dispatcher();
        let id = "11111111-1111-1111-1111-111111111111";
        let scoped = json!({"company_id": id});
        let mut limited = json!({"company_id": id});
        limited["limit"] = json!(DEFAULT_LIST_LIMIT);
        let cases = [
            (format!("/api/companies/{id}?x=1"), "company.get_by_id", scoped.clone()),
            (format!("/api/companies/{id}/approvals?x=1"), "approval.list", limited.clone()),
            (format!("/api/companies/{id}/decisions?x=1"), "decision.list", limited.clone()),
            (format!("/api/companies/{id}/secrets?x=1"), "secret.list", limited.clone()),
            (format!("/api/companies/{id}/skills?x=1"), "skill.list", scoped.clone()),
            (format!("/api/companies/{id}/wiki?x=1"), "wiki.list", limited),
            (format!("/api/companies/{id}/worktrees?x=1"), "worktree.list", scoped),
        ];
        for (path, _, _) in &cases {
            assert_eq!(status(block_on(handle_rest("GET", path, &dispatcher))), 200, "{path}");
        }
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), cases.len());
        for ((_, method, params), (called_method, called_params)) in cases.iter().zip(calls.iter()) {
            assert_eq!((called_method.as_str(), called_params), (*method, params), "{method}");
        }
    }

    #[test]
    fn non_get_methods_are_rejected_before_dispatch_on_new_routes() {
        let (dispatcher, calls) = recording_dispatcher();
        let id = "11111111-1111-1111-1111-111111111111";
        for suffix in ["", "/approvals", "/decisions", "/secrets", "/skills", "/wiki", "/worktrees"] {
            let path = format!("/api/companies/{id}{suffix}");
            assert!(matches!(block_on(handle_rest("POST", &path, &dispatcher)), RestOutcome::MethodNotAllowed), "{path}");
        }
        assert_eq!(calls.lock().unwrap().len(), 0);
    }
}

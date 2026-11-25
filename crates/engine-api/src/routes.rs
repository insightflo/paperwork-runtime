#![forbid(unsafe_code)]
//! Read-only REST-to-RPC route mapping with fail-closed UUID and method validation.

use crate::{RpcDispatcher, RpcRequest};
use serde_json::{json, Value};
use std::sync::Arc;

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

fn route(path: &str) -> Option<(&'static str, Option<&str>)> {
    let path = path.split('?').next().unwrap_or(path);
    if path == "/api/companies" { return Some(("company.list", None)); }
    let rest = path.strip_prefix("/api/companies/")?;
    let mut parts = rest.split('/');
    let company_id = parts.next()?;
    let resource = parts.next()?;
    if parts.next().is_some() || company_id.is_empty() { return None; }
    let method = match resource {
        "missions" => "mission.list",
        "workflows" => "workflow.list",
        "issues" => "issue.list",
        "agents" => "agent.list",
        _ => return None,
    };
    Some((method, Some(company_id)))
}

fn rpc_status(code: i64) -> u16 {
    match code { -32602 => 400, -32601 => 501, _ => 502 }
}

/// Resolves a read-only REST request through the dispatcher. The JSON-RPC result is
/// forwarded as the REST body; malformed dispatcher envelopes fail closed as bad gateway.
pub async fn handle_rest(method: &str, path: &str, dispatcher: &Arc<dyn RpcDispatcher>) -> RestOutcome {
    let Some((rpc_method, company_id)) = route(path) else { return RestOutcome::NotMatched };
    if method != "GET" { return RestOutcome::MethodNotAllowed; }
    if company_id.is_some_and(|id| !valid_uuid(id)) { return bad_request(); }
    let params = company_id.map_or_else(|| json!({}), |id| json!({"company_id": id}));
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

    fn dispatcher(f: impl Fn(RpcRequest) -> Value + Send + Sync + 'static) -> Arc<dyn RpcDispatcher> {
        Arc::new(ClosureDispatcher::new(f))
    }
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }
    fn status(outcome: RestOutcome) -> u16 {
        match outcome { RestOutcome::Response { status, .. } => status, _ => panic!("expected response") }
    }

    #[test]
    fn uuid_gate_happens_before_dispatch() {
        let calls = Arc::new(std::sync::Mutex::new(0usize));
        let seen = Arc::clone(&calls);
        let dispatcher = dispatcher(move |_| {
            *seen.lock().unwrap() += 1;
            json!({"jsonrpc":"2.0","id":1,"result":{}})
        });
        let outcome = block_on(handle_rest("GET", "/api/companies/not-a-uuid/issues", &dispatcher));
        assert_eq!((status(outcome), *calls.lock().unwrap()), (400, 0));
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
}

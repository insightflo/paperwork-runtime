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

struct RouteMatch<'a> {
    method: &'static str,
    company_id: Option<&'a str>,
    item: Option<(&'static str, &'a str)>,
    default_limit: bool,
}

fn item_route(resource: Option<&str>) -> Option<(&'static str, &'static str)> {
    match resource {
        Some("approvals") => Some(("approval.get", "approval_id")),
        Some("decisions") => Some(("decision.get_by_id", "decision_id")),
        Some("secrets") => Some(("secret.get_by_id", "secret_id")),
        Some("skills") => Some(("skill.get_by_id", "skill_id")),
        Some("worktrees") => Some(("worktree.get_by_id", "rule_id")),
        _ => None,
    }
}

fn route(path: &str) -> Option<RouteMatch<'_>> {
    let path = path.split('?').next().unwrap_or(path);
    if path == "/api/companies" {
        return Some(RouteMatch { method: "company.list", company_id: None, item: None, default_limit: false });
    }
    let rest = path.strip_prefix("/api/companies/")?;
    let mut parts = rest.split('/');
    let company_id = parts.next()?;
    let resource = parts.next();
    let item_id = parts.next();
    if parts.next().is_some() || company_id.is_empty() { return None; }
    if let Some(item_id) = item_id {
        if item_id.is_empty() { return None; }
        let (method, key) = item_route(resource)?;
        return Some(RouteMatch { method, company_id: Some(company_id), item: Some((key, item_id)), default_limit: false });
    }
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
    Some(RouteMatch { method, company_id: Some(company_id), item: None, default_limit })
}

fn rpc_status(code: i64) -> u16 {
    match code { -32602 => 400, -32601 => 501, _ => 502 }
}

/// Resolves a read-only REST request through the dispatcher. The JSON-RPC result is
/// forwarded as the REST body; malformed dispatcher envelopes fail closed as bad gateway.
pub async fn handle_rest(method: &str, path: &str, dispatcher: &Arc<dyn RpcDispatcher>) -> RestOutcome {
    let Some(route) = route(path) else { return RestOutcome::NotMatched };
    if method != "GET" { return RestOutcome::MethodNotAllowed; }
    if route.company_id.is_some_and(|id| !valid_uuid(id)) || route.item.is_some_and(|(_, id)| !valid_uuid(id)) {
        return bad_request();
    }
    let mut params = route.company_id.map_or_else(|| json!({}), |id| json!({"company_id": id}));
    if let Some(fields) = params.as_object_mut() {
        if route.default_limit { fields.insert("limit".to_owned(), json!(DEFAULT_LIST_LIMIT)); }
        if let Some((key, item_id)) = route.item { fields.insert(key.to_owned(), json!(item_id)); }
    }
    let request = RpcRequest {
        id: json!(format!("rest:{}", route.method)),
        method: route.method.to_owned(),
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
        let id = "11111111-1111-1111-1111-111111111111";
        for suffix in ["", "/missions", "/approvals", "/decisions", "/secrets", "/skills", "/wiki", "/worktrees"] {
            let path = format!("/api/companies/not-a-uuid{suffix}");
            assert_eq!(status(block_on(handle_rest("GET", &path, &dispatcher))), 400, "{path}");
        }
        for resource in ["approvals", "decisions", "secrets", "skills", "worktrees"] {
            for path in [
                format!("/api/companies/not-a-uuid/{resource}/{id}"),
                format!("/api/companies/{id}/{resource}/not-a-uuid"),
            ] {
                assert_eq!(status(block_on(handle_rest("GET", &path, &dispatcher))), 400, "{path}");
            }
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
    fn collection_routes_map_exact_rpc_methods_and_params() {
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
    fn single_item_routes_map_exact_rpc_methods_and_param_keys() {
        let (dispatcher, calls) = recording_dispatcher();
        let cid = "11111111-1111-1111-1111-111111111111";
        let item = "22222222-2222-2222-2222-222222222222";
        let cases = [
            (format!("/api/companies/{cid}/approvals/{item}?x=1"), "approval.get", json!({"company_id": cid, "approval_id": item})),
            (format!("/api/companies/{cid}/decisions/{item}?x=1"), "decision.get_by_id", json!({"company_id": cid, "decision_id": item})),
            (format!("/api/companies/{cid}/secrets/{item}?x=1"), "secret.get_by_id", json!({"company_id": cid, "secret_id": item})),
            (format!("/api/companies/{cid}/skills/{item}?x=1"), "skill.get_by_id", json!({"company_id": cid, "skill_id": item})),
            (format!("/api/companies/{cid}/worktrees/{item}?x=1"), "worktree.get_by_id", json!({"company_id": cid, "rule_id": item})),
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
    fn non_get_methods_are_rejected_before_dispatch_on_routes() {
        let (dispatcher, calls) = recording_dispatcher();
        let cid = "11111111-1111-1111-1111-111111111111";
        let item = "22222222-2222-2222-2222-222222222222";
        let mut paths = ["", "/approvals", "/decisions", "/secrets", "/skills", "/wiki", "/worktrees"]
            .into_iter().map(|suffix| format!("/api/companies/{cid}{suffix}")).collect::<Vec<_>>();
        for resource in ["approvals", "decisions", "secrets", "skills", "worktrees"] {
            paths.push(format!("/api/companies/{cid}/{resource}/{item}"));
        }
        for path in paths {
            for method in ["POST", "DELETE"] {
                assert!(matches!(block_on(handle_rest(method, &path, &dispatcher)), RestOutcome::MethodNotAllowed), "{method} {path}");
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 0);
    }

    #[test]
    fn extra_trailing_segments_are_not_matched_before_dispatch() {
        let (dispatcher, calls) = recording_dispatcher();
        let cid = "11111111-1111-1111-1111-111111111111";
        let item = "22222222-2222-2222-2222-222222222222";
        for resource in ["approvals", "decisions", "secrets", "skills", "worktrees"] {
            let path = format!("/api/companies/{cid}/{resource}/{item}/extra");
            assert!(matches!(block_on(handle_rest("GET", &path, &dispatcher)), RestOutcome::NotMatched), "{path}");
        }
        assert_eq!(calls.lock().unwrap().len(), 0);
    }
}

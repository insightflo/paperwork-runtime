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
    company_scope_params: bool,
}

fn item_route(resource: Option<&str>) -> Option<(&'static str, &'static str)> {
    match resource {
        Some("agents") => Some(("agent.get", "agent_id")),
        Some("approvals") => Some(("approval.get", "approval_id")),
        Some("issues") => Some(("issue.get", "issue_id")),
        Some("missions") => Some(("mission.get", "mission_id")),
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
        return Some(RouteMatch { method: "company.list", company_id: None, item: None, default_limit: false, company_scope_params: false });
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
        return Some(RouteMatch { method, company_id: Some(company_id), item: Some((key, item_id)), default_limit: false, company_scope_params: false });
    }
    let (method, default_limit, company_scope_params) = match resource {
        None => ("company.get_by_id", false, false),
        Some("activity") => ("activity.list_events", true, false),
        Some("agents") => ("agent.list", false, false),
        Some("approvals") => ("approval.list", true, false),
        Some("budgets") => ("budget.list_active_policies", false, true),
        Some("costs") => ("cost.list_events", false, false),
        Some("decisions") => ("decision.list", true, false),
        Some("issues") => ("issue.list", false, false),
        Some("knowledge-bases") => ("knowledge.list_bases", false, false),
        Some("missions") => ("mission.list", false, false),
        Some("secrets") => ("secret.list", true, false),
        Some("skills") => ("skill.list", false, false),
        Some("tools") => ("tool.list_definitions", true, false),
        Some("wiki") => ("wiki.list", true, false),
        Some("workflows") => ("workflow.list", false, false),
        Some("worktrees") => ("worktree.list", false, false),
        _ => return None,
    };
    Some(RouteMatch { method, company_id: Some(company_id), item: None, default_limit, company_scope_params })
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
        if route.company_scope_params {
            if let Some(company_id) = route.company_id {
                fields.insert("scope_type".to_owned(), json!("company"));
                fields.insert("scope_id".to_owned(), json!(company_id));
            }
        }
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
#[path = "routes_tests.rs"]
mod routes_tests;

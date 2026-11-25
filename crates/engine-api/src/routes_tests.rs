#![forbid(unsafe_code)]

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
fn assert_routes_ok(dispatcher: &Arc<dyn RpcDispatcher>, cases: &[(String, &'static str, Value)]) {
    for (path, _, _) in cases {
        assert_eq!(status(block_on(handle_rest("GET", path, dispatcher))), 200, "{path}");
    }
}
fn assert_exact_calls(cases: &[(String, &'static str, Value)], calls: RecordedCalls) {
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), cases.len());
    for ((_, method, params), (called_method, called_params)) in cases.iter().zip(calls.iter()) {
        assert_eq!(called_method.as_str(), *method, "{method}");
        assert_eq!(called_params, params, "{method}");
    }
}

#[test]
fn uuid_gate_happens_before_dispatch_on_company_scoped_routes() {
    let (dispatcher, calls) = recording_dispatcher();
    let id = "11111111-1111-1111-1111-111111111111";
    for suffix in [
        "", "/missions", "/workflows", "/issues", "/agents", "/approvals", "/decisions", "/secrets", "/skills", "/wiki", "/worktrees",
        "/activity", "/costs", "/knowledge-bases", "/tools", "/budgets",
    ] {
        let path = format!("/api/companies/not-a-uuid{suffix}");
        assert_eq!(status(block_on(handle_rest("GET", &path, &dispatcher))), 400, "{path}");
    }
    for resource in ["agents", "approvals", "decisions", "issues", "missions", "secrets", "skills", "worktrees"] {
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
    let budget = json!({"company_id": id, "scope_type": "company", "scope_id": id});
    let cases = [
        (format!("/api/companies/{id}?x=1"), "company.get_by_id", scoped.clone()),
        (format!("/api/companies/{id}/activity?x=1"), "activity.list_events", limited.clone()),
        (format!("/api/companies/{id}/approvals?x=1"), "approval.list", limited.clone()),
        (format!("/api/companies/{id}/budgets?x=1"), "budget.list_active_policies", budget),
        (format!("/api/companies/{id}/costs?x=1"), "cost.list_events", scoped.clone()),
        (format!("/api/companies/{id}/decisions?x=1"), "decision.list", limited.clone()),
        (format!("/api/companies/{id}/knowledge-bases?x=1"), "knowledge.list_bases", scoped.clone()),
        (format!("/api/companies/{id}/secrets?x=1"), "secret.list", limited.clone()),
        (format!("/api/companies/{id}/skills?x=1"), "skill.list", scoped.clone()),
        (format!("/api/companies/{id}/tools?x=1"), "tool.list_definitions", limited.clone()),
        (format!("/api/companies/{id}/wiki?x=1"), "wiki.list", limited),
        (format!("/api/companies/{id}/worktrees?x=1"), "worktree.list", scoped),
    ];
    assert_routes_ok(&dispatcher, &cases);
    assert_exact_calls(&cases, calls);
}

#[test]
fn single_item_routes_map_exact_rpc_methods_and_param_keys() {
    let (dispatcher, calls) = recording_dispatcher();
    let cid = "11111111-1111-1111-1111-111111111111";
    let item = "22222222-2222-2222-2222-222222222222";
    let cases = [
        (format!("/api/companies/{cid}/agents/{item}?x=1"), "agent.get", json!({"company_id": cid, "agent_id": item})),
        (format!("/api/companies/{cid}/approvals/{item}?x=1"), "approval.get", json!({"company_id": cid, "approval_id": item})),
        (format!("/api/companies/{cid}/decisions/{item}?x=1"), "decision.get_by_id", json!({"company_id": cid, "decision_id": item})),
        (format!("/api/companies/{cid}/issues/{item}?x=1"), "issue.get", json!({"company_id": cid, "issue_id": item})),
        (format!("/api/companies/{cid}/missions/{item}?x=1"), "mission.get", json!({"company_id": cid, "mission_id": item})),
        (format!("/api/companies/{cid}/secrets/{item}?x=1"), "secret.get_by_id", json!({"company_id": cid, "secret_id": item})),
        (format!("/api/companies/{cid}/skills/{item}?x=1"), "skill.get_by_id", json!({"company_id": cid, "skill_id": item})),
        (format!("/api/companies/{cid}/worktrees/{item}?x=1"), "worktree.get_by_id", json!({"company_id": cid, "rule_id": item})),
    ];
    assert_routes_ok(&dispatcher, &cases);
    assert_exact_calls(&cases, calls);
}

#[test]
fn non_get_methods_are_rejected_before_dispatch_on_routes() {
    let (dispatcher, calls) = recording_dispatcher();
    let cid = "11111111-1111-1111-1111-111111111111";
    let item = "22222222-2222-2222-2222-222222222222";
    let mut paths = [
        "", "/activity", "/approvals", "/budgets", "/costs", "/decisions", "/knowledge-bases", "/secrets", "/skills", "/tools", "/wiki", "/worktrees",
    ].into_iter().map(|suffix| format!("/api/companies/{cid}{suffix}")).collect::<Vec<_>>();
    for resource in ["agents", "approvals", "decisions", "issues", "missions", "secrets", "skills", "worktrees"] {
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
    for resource in ["agents", "approvals", "decisions", "issues", "missions", "secrets", "skills", "worktrees"] {
        let path = format!("/api/companies/{cid}/{resource}/{item}/extra");
        assert!(matches!(block_on(handle_rest("GET", &path, &dispatcher)), RestOutcome::NotMatched), "{path}");
    }
    assert_eq!(calls.lock().unwrap().len(), 0);
}

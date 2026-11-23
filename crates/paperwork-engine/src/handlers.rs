//! JSON-RPC method handlers for provider auth evidence and quota routing.
//! Param gates are fail-closed: anything but the documented object shape is
//! `-32602` before any auth-core or quota-router call runs.
use paperclip_provider_auth_core::{plan_login, probe_all, ProbeEnv, ProviderId};
use paperclip_quota_router::{route, RouteRequest};
use serde::Deserialize;
use serde_json::{json, Value};

fn ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}
fn err(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}
fn invalid(id: Value) -> Value {
    err(id, -32602, "invalid_params")
}
fn to_result<T: serde::Serialize + ?Sized>(id: Value, v: &T) -> Value {
    match serde_json::to_value(v) {
        Ok(v) => ok(id, v),
        Err(_) => err(id, -32603, "internal_error"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanLoginParams {
    provider: String,
}

/// Dispatches one auth/quota method; auth probes read the live process
/// environment snapshot.
pub(crate) fn dispatch(id: Value, method: &str, params: Option<&Value>) -> Value {
    dispatch_with(id, method, params, &ProbeEnv::from_process())
}

/// Same gates as `dispatch`, but auth evidence comes from an injected `env`
/// so tests stay deterministic and host-independent.
fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    match method {
        "provider.auth_probe_all" => match params {
            None => ok(id, json!({"providers": probe_all(env)})),
            Some(p) if p.as_object().is_some_and(|o| o.is_empty()) => {
                ok(id, json!({"providers": probe_all(env)}))
            }
            _ => invalid(id),
        },
        "provider.auth_plan_login" => {
            let Some(p) = params.filter(|p| p.is_object()) else { return invalid(id) };
            let Ok(p) = serde_json::from_value::<PlanLoginParams>(p.clone()) else { return invalid(id) };
            let Some(provider) = ProviderId::parse(&p.provider) else { return invalid(id) };
            to_result(id, &plan_login(provider))
        }
        "quota.route" => {
            // is_object() before deserialize: serde would silently coerce a
            // positional array into RouteRequest fields.
            let Some(p) = params.filter(|p| p.is_object()) else { return invalid(id) };
            let Ok(req) = serde_json::from_value::<RouteRequest>(p.clone()) else { return invalid(id) };
            to_result(id, &route(&req))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> ProbeEnv {
        ProbeEnv::from_pairs(&[("HOME", "/nonexistent-paperwork-engine-home")])
    }
    fn call(method: &str, params: Option<Value>) -> Value {
        dispatch_with(json!(7), method, params.as_ref(), &env())
    }
    fn code(v: &Value) -> i64 {
        v["error"]["code"].as_i64().unwrap_or(0)
    }
    fn route_params() -> Value {
        json!({
            "primary": {"provider": "claude", "model": "opus"},
            "backup_order": [{"provider": "codex", "model": "gpt"}],
            "quotas": [{"provider": "claude", "model": "opus",
                        "observed_at_epoch_ms": 900, "stale_after_ms": 1000,
                        "remaining_pct": 80.0}],
            "now_epoch_ms": 1000, "min_remaining_pct": 50.0
        })
    }

    #[test]
    fn probe_all_param_shapes() {
        for params in [None, Some(json!({}))] {
            let r = call("provider.auth_probe_all", params);
            assert_eq!(r["id"], 7);
            let providers = r["result"]["providers"].as_array().unwrap();
            assert_eq!(providers.len(), 5);
            assert!(providers.iter().all(|p| p["evidence"] == "missing"));
        }
        for bad in [json!(null), json!([]), json!({"extra": 1}), json!("x"), json!(3)] {
            assert_eq!(code(&call("provider.auth_probe_all", Some(bad))), -32602);
        }
    }

    #[test]
    fn plan_login_param_shapes() {
        let r = call("provider.auth_plan_login", Some(json!({"provider": "claude"})));
        assert_eq!(r["result"]["provider"], "claude");
        assert_eq!(r["result"]["command"], "claude");
        assert_eq!(r["result"]["interactive"], true);
        assert_eq!(r["result"]["args"], json!(["login"]));
        for bad in [
            json!({"provider": "nope"}),
            json!({"provider": 1}),
            json!({}),
            json!({"provider": "claude", "x": 1}),
            json!([]),
            json!("claude"),
        ] {
            assert_eq!(code(&call("provider.auth_plan_login", Some(bad.clone()))), -32602, "{bad}");
        }
        assert_eq!(code(&call("provider.auth_plan_login", None)), -32602);
    }

    #[test]
    fn quota_route_param_shapes() {
        let r = call("quota.route", Some(route_params()));
        assert_eq!(r["result"]["selected"]["provider"], "claude");
        assert_eq!(r["result"]["selected"]["model"], "opus");
        assert_eq!(r["result"]["reason"], "eligible");
        assert_eq!(code(&call("quota.route", Some(json!([])))), -32602); // positional array
        assert_eq!(code(&call("quota.route", Some(json!({"primary": {}})))), -32602);
        assert_eq!(code(&call("quota.route", Some(json!("x")))), -32602);
        assert_eq!(code(&call("quota.route", None)), -32602);
    }
}

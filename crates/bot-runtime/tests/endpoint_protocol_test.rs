#[path = "../src/endpoint_protocol.rs"]
mod endpoint_protocol;

use endpoint_protocol::*;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

const UNSAFE_IDS: &[&str] = &[
    "",
    ".",
    "..",
    "a..b",
    "a/b",
    "../task",
    "a b",
    "a\t",
    "a\n",
    "a\u{2003}b",
    "a\\b",
    "%2e%2e",
    "%2f",
    "a?x",
    "a#x",
    "a\0",
];

fn roundtrip<T: DeserializeOwned + Serialize>(wire: Value) {
    let dto: T = serde_json::from_value(wire.clone()).expect("decode server JSON");
    assert_eq!(serde_json::to_value(dto).expect("encode DTO"), wire);
}

#[test]
fn builds_all_four_routes() {
    let urls = EndpointUrls::new("https://paperwork.example").expect("valid base");
    let root = "https://paperwork.example/api/endpoints";
    assert_eq!(urls.pair_url(), format!("{root}/pair"));
    assert_eq!(urls.heartbeat_url("dev-1"), Ok(format!("{root}/dev-1/heartbeat")));
    assert_eq!(urls.poll_tasks_url("dev-1"), Ok(format!("{root}/dev-1/tasks/poll")));
    assert_eq!(
        urls.ack_task_url("dev-1", "task-2"),
        Ok(format!("{root}/dev-1/tasks/task-2/ack"))
    );
}

#[test]
fn normalizes_trailing_slashes_and_preserves_base_path() {
    for base in ["http://localhost:3100/proxy", "http://localhost:3100/proxy///"] {
        let urls = EndpointUrls::new(base).expect("valid HTTP base");
        assert_eq!(urls.pair_url(), "http://localhost:3100/proxy/api/endpoints/pair");
    }
}

#[test]
fn rejects_invalid_server_urls() {
    for base in [
        "",
        " ",
        "example.com",
        "ftp://host",
        "https://",
        "http:///host",
        "https://host/a b",
        "https://host\r\n",
        "https://host?x",
        "https://host#x",
        "https://user@host",
        "https://host\\evil",
        "http://host:bad",
    ] {
        assert!(EndpointUrls::new(base).is_err(), "accepted {base:?}");
    }
}

#[test]
fn supports_ipv6_server_urls() {
    let urls = EndpointUrls::new("http://[::1]:3100/").expect("IPv6 base");
    assert_eq!(urls.pair_url(), "http://[::1]:3100/api/endpoints/pair");
}

#[test]
fn rejects_unsafe_device_ids_on_every_route() {
    let urls = EndpointUrls::new("https://host").expect("base");
    for id in UNSAFE_IDS {
        assert!(urls.heartbeat_url(id).is_err(), "heartbeat accepted {id:?}");
        assert!(urls.poll_tasks_url(id).is_err(), "poll accepted {id:?}");
        assert!(urls.ack_task_url(id, "task").is_err(), "ack accepted {id:?}");
    }
}

#[test]
fn rejects_unsafe_task_ids() {
    let urls = EndpointUrls::new("https://host").expect("base");
    for id in UNSAFE_IDS {
        assert!(urls.ack_task_url("device", id).is_err(), "accepted {id:?}");
    }
}

#[test]
fn pair_request_camel_case_roundtrip() {
    roundtrip::<PairRequest>(json!({
        "code": "ABC234", "os": "macos", "arch": "aarch64", "detectedClis": ["codex",
            {"id": "pi", "binary": "pi", "path": null, "available": false}]
    }));
}

#[test]
fn pair_response_camel_case_roundtrip() {
    roundtrip::<PairResponse>(json!({"deviceId": "dev", "botName": "My bot",
        "companyId": "company", "deviceToken": "secret", "tokenPreview": "sha256:abcd"}));
}

#[test]
fn heartbeat_request_camel_case_roundtrip() {
    roundtrip::<HeartbeatRequest>(json!({"companyId": "company", "detectedClis": [
        {"id": "codex", "binary": "codex", "path": "/usr/bin/codex", "available": true}],
        "pendingOutboxCount": 2, "timestampMs": 1_800_000_000_000_u64}));
}

#[test]
fn poll_request_camel_case_roundtrip() {
    roundtrip::<PollTasksRequest>(json!({"companyId": "company", "limit": 50}));
}

#[test]
fn polled_task_camel_case_roundtrip() {
    roundtrip::<PolledTask>(json!({"taskId": "task", "kind": "shell_exec",
        "targetPath": "/work", "command": "echo", "args": ["hello"]}));
    roundtrip::<PolledTask>(json!({"taskId": "task", "kind": "read_file", "targetPath": "/work/a"}));
}

#[test]
fn ack_request_camel_case_roundtrip() {
    roundtrip::<AckTaskRequest>(json!({"companyId": "company", "ok": true,
        "output": "done", "durationMs": 123}));
    roundtrip::<AckTaskRequest>(json!({"companyId": "company", "ok": false,
        "error": "denied", "durationMs": 0}));
}

#[test]
fn builds_bearer_and_company_headers() {
    assert_eq!(
        build_auth_headers("secret", "company"),
        Ok(vec![
            ("Authorization".into(), "Bearer secret".into()),
            ("X-Company-Id".into(), "company".into()),
        ])
    );
}

#[test]
fn rejects_header_injection_in_both_fields_without_leaking_token() {
    for bad in [
        "secret\rInjected: yes",
        "secret\nInjected: yes",
        "secret\r\nInjected: yes",
    ] {
        let error = build_auth_headers(bad, "company").expect_err("token rejected");
        assert!(!error.contains("secret"));
        assert!(build_auth_headers("secret", bad).is_err());
    }
}

#[test]
fn rejects_empty_or_blank_header_values() {
    for empty in ["", " ", "\t"] {
        assert!(build_auth_headers(empty, "company").is_err());
        assert!(build_auth_headers("secret", empty).is_err());
    }
}

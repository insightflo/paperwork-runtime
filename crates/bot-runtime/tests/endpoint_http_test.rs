//! Loopback integration tests for the endpoint bot HTTP JSON client.
//!
//! A real `std::net::TcpListener` on `127.0.0.1:0` plays the server so the
//! curl-subprocess transport is exercised end to end: exact header delivery,
//! JSON roundtrip, and every fail-closed rejection path.
#[path = "../src/endpoint_http.rs"]
mod endpoint_http;
#[path = "../src/endpoint_protocol.rs"]
#[allow(dead_code)]
mod endpoint_protocol;

use endpoint_http::{HttpTransportConfig, HttpResponse, parse_json_response, post_json};
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

#[derive(Deserialize, Debug, PartialEq, Eq)]
struct SampleReply { ok: bool, value: u32 }

fn http_ok_response(body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
}

/// One-shot loopback HTTP server: serves `response`, returns (base URL, captured raw request).
fn loopback_server(response: String) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let base = format!("http://{}", listener.local_addr().expect("local addr"));
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept connection");
        stream.set_read_timeout(Some(Duration::from_secs(5))).expect("read timeout");
        let mut raw = Vec::new();
        let mut buf = [0u8; 1024];
        while !request_complete(&raw) {
            let n = stream.read(&mut buf).expect("read request bytes");
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..n]);
        }
        stream.write_all(response.as_bytes()).expect("write response");
        String::from_utf8(raw).expect("request is utf-8")
    });
    (base, handle)
}

fn request_complete(raw: &[u8]) -> bool {
    let Some(start) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let head = String::from_utf8_lossy(&raw[..start]);
    let content_length: usize = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    raw.len() >= start + 4 + content_length
}

fn header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then_some(value.trim())
    })
}

fn loopback_config(base: &str) -> HttpTransportConfig {
    HttpTransportConfig {
        server_url: base.to_string(),
        timeout_secs: 5,
        company_id: Some("company-77".to_string()),
        device_token: Some("secret-token-abc".to_string()),
    }
}

fn plain_config(base: &str) -> HttpTransportConfig {
    HttpTransportConfig { server_url: base.to_string(), timeout_secs: 2, company_id: None, device_token: None }
}

#[test]
fn posts_json_over_loopback_and_parses_200() {
    let (base, server) = loopback_server(http_ok_response("{\"ok\":true,\"value\":42}"));
    let config = loopback_config(&base);
    let resp = post_json(&config, &format!("{base}/api/endpoints/dev-1/heartbeat"), "{\"companyId\":\"company-77\"}")
        .expect("post succeeds");
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body, "{\"ok\":true,\"value\":42}");
    let parsed: SampleReply = parse_json_response(&resp).expect("parses into struct");
    assert_eq!(parsed, SampleReply { ok: true, value: 42 });
    let request = server.join().expect("server thread finishes");
    assert!(request.starts_with("POST /api/endpoints/dev-1/heartbeat HTTP/1.1"), "request line: {request}");
    assert_eq!(header_value(&request, "content-type"), Some("application/json"));
    assert!(request.contains("{\"companyId\":\"company-77\"}"), "body missing: {request}");
}

#[test]
fn sends_bearer_token_and_company_header_exactly() {
    let (base, server) = loopback_server(http_ok_response("{}"));
    post_json(&loopback_config(&base), &format!("{base}/poll"), "{\"limit\":5}").expect("post succeeds");
    let request = server.join().expect("server thread finishes");
    assert_eq!(header_value(&request, "authorization"), Some("Bearer secret-token-abc"));
    assert_eq!(header_value(&request, "x-company-id"), Some("company-77"));
}

#[test]
fn parse_json_response_fails_closed_on_401() {
    let resp = HttpResponse { status: 401, body: "{\"error\":\"unauthorized\"}".to_string() };
    let err = parse_json_response::<SampleReply>(&resp).expect_err("401 must fail");
    assert!(err.contains("401"), "missing status: {err}");
    assert!(err.contains("unauthorized"), "missing body context: {err}");
}

#[test]
fn parse_json_response_truncates_long_error_body_on_500() {
    let resp = HttpResponse { status: 500, body: "x".repeat(400) };
    let err = parse_json_response::<SampleReply>(&resp).expect_err("500 must fail");
    assert!(err.contains("500"), "missing status: {err}");
    assert!(err.chars().count() < 300, "error body not truncated: {}", err.chars().count());
}

#[test]
fn parse_json_response_rejects_non_json_200() {
    let resp = HttpResponse { status: 200, body: "<html>not json</html>".to_string() };
    let err = parse_json_response::<SampleReply>(&resp).expect_err("non-JSON 200 must fail");
    assert!(err.contains("invalid JSON"), "parse error expected: {err}");
}

#[test]
fn rejects_remote_http_url_before_any_network_call() {
    let config = plain_config("https://real-server.example");
    let err = post_json(&config, "http://example.com/api/endpoints/pair", "{}")
        .expect_err("remote http must be rejected");
    assert!(err.contains("https"), "validation error expected: {err}");
}

#[test]
fn rejects_crlf_injection_in_header_value() {
    let (base, server) = loopback_server(http_ok_response("{}"));
    let mut config = loopback_config(&base);
    config.company_id = Some("co\r\nX-Evil: injected".to_string());
    let err = post_json(&config, &format!("{base}/x"), "{}").expect_err("CRLF in header value must be rejected");
    assert!(err.contains("control"), "validation error expected: {err}");
    drop(server);
}

#[test]
fn rejects_crlf_injection_in_url() {
    let config = plain_config("https://real-server.example");
    let err = post_json(&config, "https://real-server.example/a\r\nX-Evil: 1", "{}")
        .expect_err("CRLF in URL must be rejected");
    assert!(err.contains("control"), "validation error expected: {err}");
}

#[test]
fn reports_transport_failure_fail_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    let config = plain_config(&format!("http://{addr}"));
    let err = post_json(&config, &format!("http://{addr}/x"), "{}").expect_err("connection refused must fail");
    assert!(err.contains("curl"), "transport error expected: {err}");
}

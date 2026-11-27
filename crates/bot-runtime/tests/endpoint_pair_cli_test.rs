//! Real-binary CLI tests for `endpoint-pair`: loopback mock server, `0600`
//! credential persistence, token redaction, and fail-closed rejections.
#![cfg(unix)]
#[allow(dead_code)]
mod common;

use common::{assert_failed_cleanly, assert_succeeded_cleanly, bot, stdout_json, TempDir};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

/// Raw device token issued by the mock; must never appear in any CLI output or file.
const RAW_TOKEN: &str = "pcp_dev_raw_secret_0123456789abcdef";

fn pair_reply(status: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
}

fn ok_reply() -> String {
    pair_reply("200 OK", &format!("{{\"deviceId\":\"dev-123\",\"botName\":\"bot-x\",\"companyId\":\"company-9\",\"deviceToken\":\"{RAW_TOKEN}\",\"tokenPreview\":\"sha256:abcd1234\"}}"))
}

fn request_complete(raw: &[u8]) -> bool {
    let Some(start) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { return false };
    let head = String::from_utf8_lossy(&raw[..start]);
    let length = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") { value.trim().parse().ok() } else { None }
    }).unwrap_or(0);
    raw.len() >= start + 4 + length
}

/// One-shot loopback server: reads the request, replies `response`, returns the request text.
fn loopback_pair_server(response: String) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let base = format!("http://{}", listener.local_addr().expect("local addr"));
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept connection");
        stream.set_read_timeout(Some(Duration::from_secs(10))).expect("read timeout");
        let mut raw = Vec::new();
        let mut buf = [0u8; 2048];
        while !request_complete(&raw) {
            let n = stream.read(&mut buf).expect("read request");
            if n == 0 { break; }
            raw.extend_from_slice(&buf[..n]);
        }
        stream.write_all(response.as_bytes()).expect("write response");
        String::from_utf8(raw).expect("request utf8")
    });
    (base, handle)
}

fn pair_cli(dir: &TempDir, server: &str, code: &str) -> std::process::Output {
    let cred = dir.join("cred.json");
    bot(dir, &["endpoint-pair", "--server", server, "--code", code, "--cred", cred.to_str().unwrap()], None)
}

#[test]
fn pairs_over_loopback_writes_0600_cred_and_never_leaks_token() {
    let (server_url, server) = loopback_pair_server(ok_reply());
    let dir = TempDir::new("pair-ok");
    let out = pair_cli(&dir, &server_url, "abc-234");
    assert_succeeded_cleanly(&out);
    let summary = stdout_json(&out);
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["deviceId"], "dev-123");
    assert_eq!(summary["botName"], "bot-x");
    assert_eq!(summary["companyId"], "company-9");
    assert_eq!(summary["tokenPreview"], "sha256:abcd1234");
    assert_eq!(summary["credPath"], dir.join("cred.json").to_str().unwrap());
    let request = server.join().expect("server thread finishes");
    assert!(request.starts_with("POST /api/endpoints/pair HTTP/1.1"), "request: {request}");
    assert!(request.contains("\"code\":\"ABC234\""), "normalized code missing: {request}");
    assert!(request.contains("\"detectedClis\""), "detected CLIs missing: {request}");
    use std::os::unix::fs::PermissionsExt;
    let cred_path = dir.join("cred.json");
    let mode = std::fs::metadata(&cred_path).expect("cred written").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "credential file must be 0600");
    let cred_text = std::fs::read_to_string(&cred_path).expect("cred readable");
    let cred: serde_json::Value = serde_json::from_str(&cred_text).expect("cred is JSON");
    let expected: String = Sha256::digest(RAW_TOKEN.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(cred["tokenHash"], expected);
    assert_eq!(cred["deviceId"], "dev-123");
    let leaked = format!("{}{}{cred_text}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(!leaked.contains(RAW_TOKEN), "raw device token leaked");
}

#[test]
fn invalid_pairing_code_fails_closed_before_any_network_call() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let server_url = format!("http://{}", listener.local_addr().expect("local addr"));
    let dir = TempDir::new("pair-bad-code");
    let error = assert_failed_cleanly(&pair_cli(&dir, &server_url, "000000"));
    assert!(error.contains("pairing code"), "error: {error}");
    assert!(listener.accept().is_err(), "no network connection may be attempted");
    assert!(!dir.join("cred.json").exists(), "no credential may be written");
}

#[test]
fn remote_plain_http_server_fails_closed_without_credential() {
    let dir = TempDir::new("pair-remote");
    let error = assert_failed_cleanly(&pair_cli(&dir, "http://example.com", "ABC234"));
    assert!(error.contains("https"), "error: {error}");
    assert!(!dir.join("cred.json").exists(), "no credential may be written");
}

#[test]
fn server_rejection_fails_closed_without_credential() {
    let (server_url, server) =
        loopback_pair_server(pair_reply("403 Forbidden", "{\"error\":\"invalid or expired code\"}"));
    let dir = TempDir::new("pair-rejected");
    let error = assert_failed_cleanly(&pair_cli(&dir, &server_url, "ABC234"));
    assert!(error.contains("403"), "error: {error}");
    assert!(!dir.join("cred.json").exists(), "no credential may be written");
    assert!(server.join().expect("server thread").starts_with("POST /api/endpoints/pair HTTP/1.1"));
}

#[test]
fn missing_required_flags_fail_with_flag_errors() {
    let dir = TempDir::new("pair-flags");
    for args in [
        vec!["endpoint-pair"],
        vec!["endpoint-pair", "--code", "ABC234"],
        vec!["endpoint-pair", "--server", "http://127.0.0.1:1"],
    ] {
        let error = assert_failed_cleanly(&bot(&dir, &args, None));
        assert!(error.contains("missing required flag"), "error: {error}");
    }
}

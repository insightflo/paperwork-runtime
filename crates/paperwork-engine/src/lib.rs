#![forbid(unsafe_code)]
//! paperwork-engine: resident fail-closed JSON-RPC 2.0 server over NDJSON stdio.
//! One request object per line, one response per line, flushed after every
//! write. Oversized request lines are rejected through a bounded read path.
mod handlers;
mod heartbeat;
mod schedule;

use paperclip_provider_auth_core::ProbeEnv;
use paperclip_provider_runtime_core::{validate_name, Blocklist, ProviderId};
use paperclip_redactor_core::{RedactorConfig, StreamingRedactor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

/// Maximum request-line payload bytes, excluding the `\n`/`\r\n` terminator.
pub const MAX_REQUEST_BYTES: usize = 65_536;
/// Maximum `redactor.redact_text` input bytes (32 KiB).
pub const MAX_TEXT_BYTES: usize = 32 * 1024;
const CAPABILITIES: &[&str] = &["engine.health", "redactor.redact_text", "provider.check_blocklist",
    "provider.auth_probe_all", "provider.auth_plan_login", "quota.route", "heartbeat.validate_transition", "heartbeat.claim_wakeup", "heartbeat.transition_run_fenced", "heartbeat.list_stale_runs",
    "schedule.validate_advance_window", "schedule.list_due", "schedule.advance_fenced", "schedule.set_enabled"];

fn ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}
fn err(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}
fn write_line<W: Write>(w: &mut W, v: &Value) -> io::Result<()> {
    let mut b = serde_json::to_vec(v).map_err(io::Error::other)?;
    b.push(b'\n');
    w.write_all(&b)?;
    w.flush()
}

enum Line { Payload, Oversized }

/// Reads one line into `buf` (payload only, terminator stripped); `None` at
/// EOF. Buffers at most `MAX_REQUEST_BYTES + 1` bytes; the tail of an oversized
/// line is consumed without allocation before reporting `Oversized`.
fn next_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>) -> io::Result<Option<Line>> {
    buf.clear();
    let n = io::Read::take(&mut *r, MAX_REQUEST_BYTES as u64 + 1).read_until(b'\n', buf)?;
    if n == 0 { return Ok(None); }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') { buf.pop(); }
        return Ok(Some(Line::Payload));
    }
    if buf.len() <= MAX_REQUEST_BYTES { return Ok(Some(Line::Payload)); } // unterminated EOF tail

    // buf holds MAX + 1 bytes without '\n': oversized, unless the overhang is a
    // '\r' whose '\n' is the very next byte (payload == MAX ending in CRLF).
    if buf.last() == Some(&b'\r') && r.fill_buf()?.first() == Some(&b'\n') {
        buf.pop();
        r.consume(1);
        return Ok(Some(Line::Payload));
    }
    loop {
        let avail = r.fill_buf()?;
        if avail.is_empty() { return Ok(Some(Line::Oversized)); } // unterminated oversized tail at EOF
        if let Some(i) = avail.iter().position(|&b| b == b'\n') {
            r.consume(i + 1);
            return Ok(Some(Line::Oversized));
        }
        let n = avail.len();
        r.consume(n);
    }
}

#[derive(Deserialize)]
struct RedactParams {
    text: String,
}
#[derive(Deserialize)]
struct CheckParams { provider: String, version: String, #[serde(default)] sha256: Option<String>, blocklist: Blocklist }

fn redact_text(id: Value, p: RedactParams) -> Value {
    if p.text.len() > MAX_TEXT_BYTES { return err(id, -32602, "invalid_params"); }
    let mut rd = StreamingRedactor::new(RedactorConfig { max_scan_bytes: Some(MAX_TEXT_BYTES), ..Default::default() });
    let mut redacted = rd.push_chunk(&p.text);
    redacted.push_str(&rd.finish());
    ok(id, json!({"redacted": redacted, "changed": redacted != p.text}))
}

fn check_blocklist(id: Value, p: CheckParams) -> Value {
    let (Some(provider), Ok(())) = (ProviderId::parse(&p.provider), validate_name(&p.version)) else {
        return err(id, -32602, "invalid_params");
    };
    let sha = p.sha256.as_deref().unwrap_or("");
    let by_sha = !sha.is_empty() && p.blocklist.sha256s.iter().any(|e| e.eq_ignore_ascii_case(sha));
    let reason = if p.blocklist.blocks_version(&p.version) { Some("version") } else if by_sha { Some("sha256") } else { None };
    ok(id, json!({"provider": provider.as_str(), "version": p.version, "blocked": reason.is_some(), "reason": reason}))
}

fn health_result() -> Value {
    json!({"ok": true, "engine": "paperwork-engine", "protocol_version": 1, "capabilities": CAPABILITIES})
}

fn dispatch_request(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    match method {
        "engine.health" => match params {
            Some(p) if !(p.is_null() || p.as_object().is_some_and(|o| o.is_empty())) => err(id, -32602, "invalid_params"),
            _ => ok(id, health_result()),
        },
        "provider.auth_probe_all" | "provider.auth_plan_login" | "quota.route" => handlers::dispatch_with(id, method, params, env),
        m if m.starts_with("heartbeat.") => heartbeat::dispatch_with(id, m, params, env),
        m if m.starts_with("schedule.") => schedule::dispatch_with(id, m, params, env),
        "redactor.redact_text" | "provider.check_blocklist" => {
            let Some(p) = params else { return err(id, -32602, "invalid_params") };
            let parsed = if method == "redactor.redact_text" {
                serde_json::from_value::<RedactParams>(p.clone()).map(|p| redact_text(id.clone(), p))
            } else {
                serde_json::from_value::<CheckParams>(p.clone()).map(|p| check_blocklist(id.clone(), p))
            };
            parsed.unwrap_or_else(|_| err(id, -32602, "invalid_params"))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

pub(crate) fn handle_with(payload: &[u8], env: &ProbeEnv) -> Value {
    let parse = || err(Value::Null, -32700, "parse_error");
    let Ok(text) = std::str::from_utf8(payload) else { return parse() };
    let Ok(req) = serde_json::from_str::<Value>(text) else { return parse() };
    let Some(obj) = req.as_object() else { return parse() };
    if obj.get("jsonrpc") != Some(&json!("2.0")) { return parse(); }
    let Some(id) = obj.get("id").filter(|v| v.is_string() || v.is_number()).cloned() else { return parse() };
    let Some(method) = obj.get("method").and_then(Value::as_str) else { return err(id, -32700, "parse_error") };
    dispatch_request(id, method, obj.get("params"), env)
}

/// Serves NDJSON JSON-RPC requests from `reader` to `writer` until EOF.
/// Every response line is flushed immediately; empty lines are ignored.
pub fn serve_stdio<R: BufRead, W: Write>(mut reader: R, mut writer: W) -> io::Result<()> {
    let mut buf = Vec::with_capacity(4096);
    while let Some(line) = next_line(&mut reader, &mut buf)? {
        let resp = match line {
            Line::Oversized => err(Value::Null, -32600, "request_too_large"),
            Line::Payload if buf.is_empty() => continue,
            Line::Payload => handle_with(&buf, &ProbeEnv::from_process()),
        };
        write_line(&mut writer, &resp)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    fn run(input: &[u8], cap: usize) -> Vec<Value> {
        let mut out = Vec::new();
        serve_stdio(BufReader::with_capacity(cap, input), &mut out).unwrap();
        std::str::from_utf8(&out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
    fn call(v: &Value) -> Vec<Value> {
        run(format!("{v}\n").as_bytes(), 8)
    }
    fn code(v: &Value) -> i64 {
        v["error"]["code"].as_i64().unwrap_or(0)
    }
    fn health_req(id: i64) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "engine.health"})
    }
    /// Valid request padded with trailing spaces to exactly `size` payload bytes.
    fn padded(size: usize) -> Vec<u8> {
        let mut v = health_req(1).to_string().into_bytes();
        v.resize(size, b' ');
        v
    }
    fn result(out: Vec<Value>) -> Value {
        out.into_iter().next().unwrap()["result"].clone()
    }

    #[test]
    fn health_and_error_codes() {
        let out = call(&health_req(7));
        let r = &out[0]["result"];
        assert_eq!(r["ok"], true);
        assert_eq!(r["engine"], "paperwork-engine");
        assert_eq!(r["protocol_version"], 1);
        assert_eq!(r["capabilities"].as_array().unwrap().len(), 14);
        assert_eq!(out[0]["id"], 7);
        let out = call(&json!({"jsonrpc": "2.0", "id": "x1", "method": "nope"}));
        assert_eq!((code(&out[0]), out[0]["id"].as_str().unwrap()), (-32601, "x1"));
        let bad = [
            json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text","params":{"text":1}}),
            json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text"}),
            json!({"jsonrpc":"2.0","id":1,"method":"provider.check_blocklist","params":{"provider":"gpt","version":"1","blocklist":{"versions":[],"sha256s":[]}}}),
            json!({"jsonrpc":"2.0","id":1,"method":"provider.check_blocklist","params":{"provider":"claude","version":"a/b","blocklist":{"versions":[],"sha256s":[]}}}),
        ];
        for p in bad {
            assert_eq!(code(&call(&p)[0]), -32602);
        }
        let p = json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text","params":{"text":"y".repeat(MAX_TEXT_BYTES + 1)}});
        assert_eq!(code(&call(&p)[0]), -32602);
    }

    #[test]
    fn redact_text_secret_and_plain() {
        let p = json!({"jsonrpc":"2.0","id":2,"method":"redactor.redact_text","params":{"text":"tok sk-ant-abc123def456 ok"}});
        let r = result(call(&p));
        assert!(r["redacted"].as_str().unwrap().contains("[redacted]"));
        assert!(!r["redacted"].as_str().unwrap().contains("sk-ant-abc123def456"));
        assert_eq!(r["changed"], true);
        let p = json!({"jsonrpc":"2.0","id":3,"method":"redactor.redact_text","params":{"text":"plain"}});
        let r = result(call(&p));
        assert_eq!((r["redacted"].clone(), r["changed"].clone()), (json!("plain"), json!(false)));
    }

    #[test]
    fn check_blocklist_variants() {
        let mk = |params: Value| json!({"jsonrpc":"2.0","id":9,"method":"provider.check_blocklist","params":params});
        let r = result(call(&mk(json!({"provider":"claude","version":"1.0","blocklist":{"versions":["2.*","1.0"],"sha256s":[]}}))));
        assert_eq!((r["blocked"].clone(), r["reason"].clone()), (json!(true), json!("version")));
        let r = result(call(&mk(json!({"provider":"devin","version":"9","sha256":"aabb","blocklist":{"versions":[],"sha256s":["AABB"]}}))));
        assert_eq!((r["blocked"].clone(), r["reason"].clone()), (json!(true), json!("sha256")));
        let r = result(call(&mk(json!({"provider":"pi","version":"3","blocklist":{"versions":["2.*"],"sha256s":[]}}))));
        assert_eq!((r["blocked"].clone(), r["reason"].clone(), r["provider"].clone()), (json!(false), Value::Null, json!("pi")));
    }

    #[test]
    fn parse_errors_and_recovery() {
        let mut input = b"\nnot json\n".to_vec();
        input.extend_from_slice(b"{\"jsonrpc\":\"1.9\",\"id\":1,\"method\":\"engine.health\"}\n");
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"method\":\"engine.health\"}\n");
        input.extend_from_slice(b"\xff\xfe{\n");
        input.extend_from_slice(format!("{}\n", health_req(5)).as_bytes());
        let out = run(&input, 8);
        assert_eq!(out.len(), 5);
        for v in &out[..4] {
            assert_eq!((code(v), v["id"].clone()), (-32700, Value::Null));
        }
        assert_eq!(out[4]["result"]["ok"], true);
    }

    #[test]
    fn boundary_max_accepted_lf_and_crlf() {
        for tail in [b"\n".as_slice(), b"\r\n".as_slice()] {
            let mut input = padded(MAX_REQUEST_BYTES);
            input.extend_from_slice(tail);
            let out = run(&input, 64);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0]["result"]["ok"], true);
        }
    }

    #[test]
    fn boundary_over_max_rejected_then_recovers() {
        for tail in [b"\n".as_slice(), b"\r\n".as_slice()] {
            let mut input = padded(MAX_REQUEST_BYTES + 1);
            input.extend_from_slice(tail);
            input.extend_from_slice(format!("{}\n", health_req(2)).as_bytes());
            let out = run(&input, 64);
            assert_eq!(out.len(), 2);
            assert_eq!((code(&out[0]), out[0]["id"].clone()), (-32600, Value::Null));
            assert_eq!(out[1]["result"]["ok"], true);
        }
    }

    #[test]
    fn unterminated_final_line_processed() {
        let out = run(health_req(4).to_string().as_bytes(), 8);
        assert_eq!(out[0]["result"]["ok"], true);
    }

    struct Spy {
        buf: Vec<u8>,
        marks: Vec<usize>,
    }
    impl Write for Spy {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.buf.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            self.marks.push(self.buf.len());
            Ok(())
        }
    }

    #[test]
    fn flush_after_every_response_line() {
        let mut spy = Spy { buf: Vec::new(), marks: Vec::new() };
        let mut input = vec![b'x'; MAX_REQUEST_BYTES + 10];
        input.extend_from_slice(b"\n");
        input.extend_from_slice(format!("{}\n", health_req(1)).as_bytes());
        serve_stdio(BufReader::with_capacity(32, &input[..]), &mut spy).unwrap();
        assert_eq!(spy.marks.len(), 2);
        for (i, &m) in spy.marks.iter().enumerate() {
            assert_eq!(spy.buf[m - 1], b'\n');
            assert_eq!(spy.buf[..m].iter().filter(|&&b| b == b'\n').count(), i + 1);
        }
        assert_eq!(*spy.marks.last().unwrap(), spy.buf.len());
    }
}

#![forbid(unsafe_code)]
//! paperwork-engine: resident fail-closed JSON-RPC 2.0 server over NDJSON stdio.
//! One request object per line, one response per line, flushed after every
//! write. Oversized request lines are rejected through a bounded read path.
mod activity;
mod agent;
mod approval;
mod budget;
mod company;
mod cost;
mod decision;
mod domain_dispatch;
mod handlers;
mod heartbeat;
mod heartbeat_run;
mod issue;
mod knowledge;
mod mission;
mod schedule;
mod secret;
mod skill;
mod tool;
mod wiki;
mod workflow;
mod worktree;

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
    "provider.auth_probe_all", "provider.auth_plan_login", "quota.route", "heartbeat.validate_transition", "heartbeat.claim_wakeup", "heartbeat.transition_run_fenced", "heartbeat.list_stale_runs", "heartbeat.run_agent",
    "budget.evaluate_threshold", "budget.utc_month_window", "budget.record_cost_event", "budget.sum_scope_spend", "budget.list_active_policies", "budget.upsert_incident_fenced", "budget.resolve_incident_fenced", "secret.list", "secret.get_by_id", "secret.get_by_name", "secret.list_versions", "secret.bump_latest_version_fenced",
    "workflow.validate_run_transition", "workflow.validate_step_transition", "workflow.list_pending_runs", "workflow.transition_run_fenced", "workflow.transition_step_fenced", "workflow.list_step_runs"];
fn ok(id: Value, result: Value) -> Value { json!({"jsonrpc": "2.0", "id": id, "result": result}) }
fn err(id: Value, code: i64, message: &str) -> Value { json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}) }
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
    let capabilities: Vec<&str> = CAPABILITIES.iter().copied()
        .chain(domain_dispatch::DOMAIN_CAPABILITIES.iter().copied())
        .collect();
    json!({"ok": true, "engine": "paperwork-engine", "protocol_version": 1, "capabilities": capabilities})
}

fn dispatch_request(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    match method {
        "engine.health" => match params {
            Some(p) if !(p.is_null() || p.as_object().is_some_and(|o| o.is_empty())) => err(id, -32602, "invalid_params"),
            _ => ok(id, health_result()),
        },
        "provider.auth_probe_all" | "provider.auth_plan_login" | "quota.route" => handlers::dispatch_with(id, method, params, env),
        "heartbeat.run_agent" => heartbeat_run::dispatch_with(id, params),
        m if m.starts_with("budget.") => budget::dispatch_with(id, m, params, env),
        m if m.starts_with("heartbeat.") => heartbeat::dispatch_with(id, m, params, env),
        m if m.starts_with("secret.") => secret::dispatch_with(id, m, params, env),
        m if m.starts_with("workflow.") => workflow::dispatch_with(id, m, params, env),
        "redactor.redact_text" | "provider.check_blocklist" => {
            let Some(p) = params else { return err(id, -32602, "invalid_params") };
            let parsed = if method == "redactor.redact_text" {
                serde_json::from_value::<RedactParams>(p.clone()).map(|p| redact_text(id.clone(), p))
            } else {
                serde_json::from_value::<CheckParams>(p.clone()).map(|p| check_blocklist(id.clone(), p))
            };
            parsed.unwrap_or_else(|_| err(id, -32602, "invalid_params"))
        }
        _ => domain_dispatch::dispatch_with(id, method, params, env),
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

/// Serves NDJSON JSON-RPC requests from `reader` to `writer` until EOF; every response flushed immediately, empty lines ignored.
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
mod tests;

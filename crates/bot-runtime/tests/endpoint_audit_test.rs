//! TDD tests for the append-only endpoint audit log (`endpoint_audit`): secret redaction
//! (bearer / sk- / ghp_ / xoxb- / key=value), JSONL append + `read_recent` ordering and
//! limit, rotation to `path.1` past `max_bytes`, malformed-line tolerance, and `0600` perms.
#![cfg(unix)]

// This target only uses `TempDir` from the shared helpers; silence the rest.
#[allow(dead_code)]
mod common;

// Included by path so this suite exercises the exact `src/endpoint_audit.rs` source with
// zero `lib.rs` / `Cargo.toml` changes (100% additive worker spec).
#[path = "../src/endpoint_audit.rs"]
mod endpoint_audit;

use common::TempDir;
use endpoint_audit::{redact_sensitive, AuditEntry, AuditLogger};
use std::fs;
use std::io::Write;

fn entry(task: &str, summary: &str) -> AuditEntry {
    AuditEntry {
        timestamp_ms: 1_700_000_000_000,
        task_id: task.to_string(),
        action: "run_shell".to_string(),
        target_path: "/tmp/proj".to_string(),
        allowed: true,
        exit_code: Some(0),
        duration_ms: 42,
        summary: summary.to_string(),
    }
}

fn ids(entries: &[AuditEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.task_id.as_str()).collect()
}

fn logger(tag: &str, max_bytes: u64) -> (TempDir, AuditLogger) {
    let tmp = TempDir::new(tag);
    let log = AuditLogger::new(tmp.join("audit.jsonl"), max_bytes);
    (tmp, log)
}

#[test]
fn redacts_bearer_tokens() {
    let out = redact_sensitive("Authorization: Bearer eyJhbGciOi9.secret_123 ok");
    assert!(!out.contains("eyJhbGciOi9"), "leaked bearer: {out}");
    assert!(out.contains("Bearer [REDACTED]"), "got: {out}");
    assert!(out.ends_with("ok"));
}

#[test]
fn redacts_provider_key_prefixes() {
    let out = redact_sensitive("openai sk-abcd1234EFGH gh ghp_9z8y7x6w slack xoxb-111-222-333 done");
    assert!(!out.contains("abcd1234"), "leaked sk key: {out}");
    assert!(!out.contains("9z8y7x6w"), "leaked ghp key: {out}");
    assert!(!out.contains("111-222"), "leaked xoxb key: {out}");
    assert!(out.contains("sk-[REDACTED]"), "got: {out}");
    assert!(out.contains("ghp_[REDACTED]"), "got: {out}");
    assert!(out.contains("xoxb-[REDACTED]"), "got: {out}");
}

#[test]
fn redacts_key_value_secret_assignments() {
    let out = redact_sensitive("run with TOKEN=abc123 and Password=hunter2 plus key=deadbeef done");
    assert!(!out.contains("abc123"), "leaked token: {out}");
    assert!(!out.contains("hunter2"), "leaked password: {out}");
    assert!(!out.contains("deadbeef"), "leaked key value: {out}");
    assert!(out.contains("TOKEN=[REDACTED]"), "got: {out}");
    assert!(out.contains("Password=[REDACTED]"), "got: {out}");
    assert!(out.contains("key=[REDACTED]"), "got: {out}");
}

#[test]
fn append_then_read_recent_returns_entries_in_order() {
    let (_tmp, log) = logger("ea-order", u64::MAX);
    for (task, summary) in [("t1", "first"), ("t2", "second"), ("t3", "third")] {
        log.append(&entry(task, summary)).expect("append");
    }
    let recent = log.read_recent(10).expect("read");
    assert_eq!(ids(&recent), ["t1", "t2", "t3"]);
    // Whole-entry equality keeps every field honest, not just the ids.
    assert_eq!(recent[0], entry("t1", "first"));
}

#[test]
fn read_recent_limit_returns_newest_tail() {
    let (_tmp, log) = logger("ea-limit", u64::MAX);
    for i in 0..5 {
        log.append(&entry(&format!("t{i}"), "work")).expect("append");
    }
    assert_eq!(ids(&log.read_recent(2).expect("read")), ["t3", "t4"]);
    assert!(log.read_recent(0).expect("read zero limit").is_empty());
}

#[test]
fn read_recent_missing_file_returns_empty() {
    let (_tmp, log) = logger("ea-missing", u64::MAX);
    assert!(log.read_recent(5).expect("read missing").is_empty());
}

#[test]
fn append_redacts_summary_before_it_hits_disk() {
    let (tmp, log) = logger("ea-redact", u64::MAX);
    log.append(&entry("t-secret", "called with Bearer super-secret-token-xyz")).expect("append");
    let on_disk = fs::read_to_string(tmp.join("audit.jsonl")).expect("read disk");
    assert!(!on_disk.contains("super-secret-token-xyz"), "secret reached disk: {on_disk}");
    assert_eq!(log.read_recent(1).expect("read")[0].summary, "called with Bearer [REDACTED]");
}

#[test]
fn rotates_active_file_to_dot_one_when_max_bytes_exceeded() {
    let (tmp, log) = logger("ea-rotate", 64);
    log.append(&entry("old", "a fairly long summary line for rotation")).expect("append old");
    log.append(&entry("mid", "another fairly long summary line for rotation")).expect("append mid");
    log.append(&entry("new", "third long summary line for the rotation test")).expect("append new");
    let rotated = fs::read_to_string(tmp.join("audit.jsonl.1")).expect("rotated file");
    assert_eq!(ids(&log.read_recent(10).expect("read fresh")), ["new"]);
    assert!(rotated.contains("\"task_id\":\"mid\""), "path.1 holds last rotated-out: {rotated}");
    assert!(!rotated.contains("\"task_id\":\"old\""), "old rotation overwritten: {rotated}");
}

#[test]
fn malformed_lines_are_skipped_safely() {
    let (tmp, log) = logger("ea-malformed", u64::MAX);
    log.append(&entry("t1", "good one")).expect("append");
    fs::OpenOptions::new()
        .append(true)
        .open(tmp.join("audit.jsonl"))
        .and_then(|mut f| f.write_all(b"{not json\n\n"))
        .expect("write junk");
    log.append(&entry("t2", "good two")).expect("append");
    assert_eq!(ids(&log.read_recent(10).expect("read")), ["t1", "t2"]);
}

#[test]
fn audit_file_is_owner_only_0600() {
    let (tmp, log) = logger("ea-perms", u64::MAX);
    log.append(&entry("t", "x")).expect("append");
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(tmp.join("audit.jsonl")).expect("meta").permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "audit log must be owner-only");
}

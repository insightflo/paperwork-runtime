//! Real-binary contracts for local workspace scanning and redacted audit inspection.
#![cfg(unix)]
#[allow(dead_code)]
mod common;

use common::{assert_failed_cleanly, assert_succeeded_cleanly, bot, stdout_json, TempDir};
use paperwork_bot_runtime::endpoint_audit::{AuditEntry, AuditLogger};
use std::fs;

#[test]
fn scan_returns_sorted_entries_and_ignores_dependency_directories() {
    let dir = TempDir::new("scan-sorted");
    for name in [".git", "node_modules", "nested", "nested/.git", "nested/node_modules"] {
        fs::create_dir_all(dir.join(name)).unwrap();
    }
    for name in ["z.txt", "a.txt", "nested/b.txt", ".git/secret", "node_modules/pkg",
        "nested/.git/secret", "nested/node_modules/pkg"] {
        fs::write(dir.join(name), "abc").unwrap();
    }
    let out = bot(&dir, &["endpoint-scan", "--folder", dir.path().to_str().unwrap()], None);
    assert_succeeded_cleanly(&out);
    let snapshot = stdout_json(&out);
    let entries = snapshot["entries"].as_array().unwrap();
    let paths: Vec<_> = entries.iter().map(|e| e["rel_path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["a.txt", "nested/b.txt", "z.txt"]);
    assert_eq!(snapshot["root"], dir.path().to_str().unwrap());
    assert_eq!(snapshot["truncated"], false);
    assert!(entries.iter().all(|e| e["size_bytes"] == 3 && e["modified_ms"].is_u64()));
}

#[test]
fn scan_rejects_nonexistent_and_file_roots_with_json_error() {
    let dir = TempDir::new("scan-invalid");
    fs::write(dir.join("file"), "x").unwrap();
    for path in ["/nonexistent/path", dir.join("file").to_str().unwrap()] {
        let out = bot(&dir, &["endpoint-scan", "--folder", path], None);
        assert_eq!(out.status.code(), Some(1));
        assert!(!assert_failed_cleanly(&out).is_empty());
    }
}

#[test]
fn scan_honors_file_and_depth_limits() {
    let dir = TempDir::new("scan-limits");
    fs::create_dir(dir.join("nested")).unwrap();
    for name in ["a", "z", "nested/b"] { fs::write(dir.join(name), "x").unwrap(); }
    for (flag, value, count) in [("--max-files", "1", 1), ("--max-depth", "0", 2)] {
        let out = bot(&dir, &["endpoint-scan", "--folder", dir.path().to_str().unwrap(), flag, value], None);
        assert_succeeded_cleanly(&out);
        let snapshot = stdout_json(&out);
        assert_eq!(snapshot["entries"].as_array().unwrap().len(), count);
        assert_eq!(snapshot["truncated"], true);
    }
}

#[test]
fn missing_or_invalid_flags_fail_cleanly() {
    let dir = TempDir::new("scan-audit-flags");
    let path = dir.path().to_str().unwrap();
    for args in [vec!["endpoint-scan"], vec!["endpoint-scan", "--folder"],
        vec!["endpoint-scan", "--folder", path, "--max-files"],
        vec!["endpoint-scan", "--folder", path, "--max-depth", "-1"],
        vec!["endpoint-scan", "--folder", path, "--max-files", "bad"],
        vec!["endpoint-audit"], vec!["endpoint-audit", "--log"],
        vec!["endpoint-audit", "--log", path, "--limit"],
        vec!["endpoint-audit", "--log", path, "--limit", "bad"],
        vec!["endpoint-audit", "--log", path, "--log", path],
        vec!["endpoint-audit", "--log", path, "--unknown", "1"]] {
        let out = bot(&dir, &args, None);
        assert_eq!(out.status.code(), Some(1));
        assert!(!assert_failed_cleanly(&out).is_empty());
    }
}

fn populate(dir: &TempDir, count: u64) -> String {
    let path = dir.join("audit.jsonl");
    let logger = AuditLogger::new(path.clone(), u64::MAX);
    for timestamp_ms in 0..count {
        logger.append(&AuditEntry {
            timestamp_ms, task_id: format!("task-{timestamp_ms}"), action: "read".into(),
            target_path: "file".into(), allowed: true, exit_code: Some(0), duration_ms: 1,
            summary: "Bearer secretbearer sk-secretkey password=secretpass".into(),
        }).unwrap();
    }
    path.to_str().unwrap().to_owned()
}

#[test]
fn audit_missing_log_is_empty_without_creating_it() {
    let dir = TempDir::new("audit-missing");
    let path = dir.join("missing.jsonl");
    let out = bot(&dir, &["endpoint-audit", "--log", path.to_str().unwrap()], None);
    assert_succeeded_cleanly(&out);
    assert_eq!(stdout_json(&out), serde_json::json!([]));
    assert!(!path.exists());
}

#[test]
fn audit_returns_recent_entries_in_order_with_secrets_redacted() {
    let dir = TempDir::new("audit-recent");
    let path = populate(&dir, 3);
    let out = bot(&dir, &["endpoint-audit", "--log", &path, "--limit", "2"], None);
    assert_succeeded_cleanly(&out);
    let entries: Vec<AuditEntry> = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(entries.iter().map(|e| e.timestamp_ms).collect::<Vec<_>>(), [1, 2]);
    assert!(entries.iter().all(|e| e.summary == "Bearer [REDACTED] sk-[REDACTED] password=[REDACTED]"));
}

#[test]
fn audit_defaults_to_twenty_and_supports_zero_limit() {
    let dir = TempDir::new("audit-default");
    let path = populate(&dir, 22);
    let out = bot(&dir, &["endpoint-audit", "--log", &path], None);
    assert_succeeded_cleanly(&out);
    let entries = stdout_json(&out);
    assert_eq!(entries.as_array().unwrap().len(), 20);
    assert_eq!(entries[0]["timestamp_ms"], 2);
    assert_eq!(entries[19]["timestamp_ms"], 21);
    let out = bot(&dir, &["endpoint-audit", "--log", &path, "--limit", "0"], None);
    assert_succeeded_cleanly(&out);
    assert_eq!(stdout_json(&out), serde_json::json!([]));
}

#[test]
fn audit_redacts_summaries_even_if_log_was_written_externally() {
    let dir = TempDir::new("audit-external");
    let path = populate(&dir, 1);
    let raw = fs::read_to_string(&path).unwrap().replace("[REDACTED]", "externalsecret");
    fs::write(&path, raw).unwrap();
    let out = bot(&dir, &["endpoint-audit", "--log", &path], None);
    assert_succeeded_cleanly(&out);
    let entries = stdout_json(&out);
    assert!(!entries.to_string().contains("externalsecret"));
    assert!(entries[0]["summary"].as_str().unwrap().contains("[REDACTED]"));
}

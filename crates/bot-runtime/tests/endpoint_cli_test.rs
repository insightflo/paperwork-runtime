//! Integration tests for the personal-endpoint CLI subcommands (`init`, `detect-clis`,
//! `render-service`) of the compiled `paperwork-bot` binary.
//!
//! Contract: success prints one machine-readable JSON value to a clean stdout (raw OS unit
//! text for `render-service`); failure prints one `{"error": ...}` JSON object on stderr
//! with a non-zero exit code; the binary never panics.

#![cfg(unix)]

mod common;

use common::{assert_failed_cleanly, assert_succeeded_cleanly, bot, stdout_json, TempDir};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn file_mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).expect("config metadata").permissions().mode() & 0o777
}

#[test]
fn detect_clis_prints_json_array_of_known_clis() {
    let out = bot(&TempDir::new("detect"), &["detect-clis"], None);
    assert_succeeded_cleanly(&out);
    let entries = stdout_json(&out).as_array().expect("stdout is a JSON array").clone();
    let ids: Vec<&str> = entries.iter().filter_map(|e| e["id"].as_str()).collect();
    assert_eq!(ids, ["pi", "claude", "codex", "agy", "opencode", "cursor", "gemini"]);
    for entry in &entries {
        assert!(entry["available"].is_boolean(), "bool available: {entry}");
        assert!(entry["path"].is_null() || entry["path"].is_string(), "path null|string: {entry}");
        if entry["available"].as_bool().unwrap_or(false) {
            assert!(entry["path"].is_string(), "available CLI exposes its path: {entry}");
        }
    }
}

#[test]
fn init_writes_0600_config_and_json_summary() {
    let tmp = TempDir::new("init-ok");
    let config = tmp.private_subdir("paperwork").join("endpoint.json");
    let cfg_arg = config.to_string_lossy().into_owned();
    let args = [
        "init", "--server", "https://paperwork.example.si", "--name", "ep-1",
        "--config", cfg_arg.as_str(), "--folder", "/tmp/a", "--folder", "/tmp/b",
    ];
    let out = bot(&tmp, &args, None);
    assert_succeeded_cleanly(&out);

    let summary = stdout_json(&out);
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["endpointName"], "ep-1");
    assert_eq!(summary["serverUrl"], "https://paperwork.example.si");
    assert_eq!(summary["allowedFolders"].as_array().map(Vec::len), Some(2));
    assert_eq!(file_mode(&config), 0o600, "config file must be 0600");
    let raw = fs::read_to_string(&config).expect("read config");
    let cfg: Value = serde_json::from_str(&raw).expect("valid JSON config");
    assert_eq!(cfg["server_url"], "https://paperwork.example.si");
    assert_eq!(cfg["endpoint_name"], "ep-1");
    assert_eq!(cfg["allowed_folders"][1], "/tmp/b");
}

#[test]
fn init_rejects_plain_http_server_without_writing_config() {
    let tmp = TempDir::new("init-bad");
    let config = tmp.join("endpoint.json");
    let cfg_arg = config.to_string_lossy().into_owned();
    let args = [
        "init", "--server", "http://example.com",
        "--name", "ep-1", "--config", cfg_arg.as_str(),
    ];
    let err = assert_failed_cleanly(&bot(&tmp, &args, None));
    assert!(err.contains("https"), "expected https error: {err}");
    assert!(!config.exists(), "rejected init must not write a config");
}

#[test]
fn init_missing_required_flags_fails_cleanly() {
    let tmp = TempDir::new("init-flags");
    let cases: [&[&str]; 3] = [
        &["init"],
        &["init", "--server", "https://paperwork.example.si"],
        &["init", "--name", "ep-1"],
    ];
    for args in cases {
        let err = assert_failed_cleanly(&bot(&tmp, args, None));
        assert!(err.starts_with("missing required flag"), "args {args:?}: {err:?}");
    }
}

#[test]
fn render_service_outputs_raw_unit_per_os() {
    let tmp = TempDir::new("render");
    let flags = [
        "--server", "https://paperwork.example.si", "--name", "ep-1",
        "--binary", "/opt/paperwork/bot", "--config", "/etc/paperwork/endpoint.json",
    ];
    let cases = [
        ("macos", ["<?xml", "si.insightflo.paperwork-bot", "RunAtLoad", "KeepAlive"]),
        ("linux", ["[Unit]", "[Service]", "Restart=on-failure", "WantedBy=default.target"]),
        ("windows", ["Register-ScheduledTask", "New-ScheduledTaskTrigger", "-AtLogOn", "PaperworkBot"]),
    ];
    for (os, needles) in cases {
        let mut args = vec!["render-service", "--os", os];
        args.extend_from_slice(&flags);
        let out = bot(&tmp, &args, None);
        assert_succeeded_cleanly(&out);
        let text = String::from_utf8(out.stdout).expect("stdout utf8");
        for needle in needles {
            assert!(text.contains(needle), "--os {os}: missing {needle:?}");
        }
        assert!(text.contains("/opt/paperwork/bot"), "--os {os}: binary path missing");
        assert!(text.contains("/etc/paperwork/endpoint.json"), "--os {os}: config path missing");
        assert!(
            serde_json::from_str::<Value>(text.trim()).is_err(),
            "--os {os}: stdout must be raw unit text, not JSON"
        );
    }
}

#[test]
fn render_service_rejects_unknown_os_and_plain_http_cleanly() {
    let tmp = TempDir::new("render-bad");
    let mut bad_os = vec!["render-service", "--os", "plan9"];
    bad_os.extend_from_slice(&["--server", "https://paperwork.example.si", "--name", "ep-1"]);
    let err = assert_failed_cleanly(&bot(&tmp, &bad_os, None));
    assert!(err.contains("invalid --os"), "unexpected error: {err}");

    let bad_url = [
        "render-service", "--os", "linux",
        "--server", "http://example.com", "--name", "ep-1",
    ];
    let err = assert_failed_cleanly(&bot(&tmp, &bad_url, None));
    assert!(err.contains("https"), "expected https error: {err}");
}

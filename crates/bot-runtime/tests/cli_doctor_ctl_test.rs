//! Integration tests for the compiled `paperwork-bot` binary's `doctor`, `ctl`, and `eval-policy`
//! subcommands.
//!
//! Contract under test: machine-readable JSON on stdout for success, a single JSON
//! `{"error": ...}` object on stderr with a non-zero exit code for failure, and never a panic.
#![cfg(unix)]

mod common;

use common::{
    assert_failed_cleanly, assert_no_panic, assert_succeeded_cleanly, bot, stdout_json, TempDir,
};
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn dir_mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).expect("metadata").permissions().mode() & 0o777
}

#[test]
fn doctor_reports_valid_json_in_isolated_state_dir() {
    let tmp = TempDir::new("doctor");
    let socket_dir = tmp.join("sock");
    let out = bot(
        &tmp,
        &["doctor", "--socket-dir", &socket_dir.to_string_lossy()],
        None,
    );
    assert_succeeded_cleanly(&out);

    let report = stdout_json(&out);
    assert_eq!(report["daemonVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(report["protocolVersion"], "1.0");
    assert_eq!(report["ok"], false, "no token env => overall not ok");

    let token = &report["checks"]["tokenEnv"];
    assert_eq!(token["ok"], false);
    assert_eq!(token["present"], false);
    assert_eq!(token["envVar"], "PAPERWORK_TERMINAL_TOKEN");
    assert!(token["tokenKind"].is_null());

    let uds = &report["checks"]["controlSocketDir"];
    assert_eq!(uds["ok"], true);
    assert_eq!(uds["mode"], "0700");
    let reported = uds["dir"].as_str().expect("dir string");
    assert!(reported.ends_with("/sock"), "unexpected dir {reported}");
    assert_eq!(
        dir_mode(&socket_dir),
        0o700,
        "doctor must create a 0700 dir"
    );

    assert_eq!(report["checks"]["compatibility"]["skipped"], true);
    assert_eq!(report["checks"]["processSupervisor"]["ok"], true);
}

#[test]
fn doctor_passes_with_terminal_token_env_and_never_prints_it() {
    let tmp = TempDir::new("doctor-token");
    let secret = "pcp_term_doctorSecretValue42";
    let mut cmd = common::bot_command(
        &tmp,
        &["doctor", "--socket-dir", &tmp.join("s").to_string_lossy()],
    );
    cmd.env("PAPERWORK_TERMINAL_TOKEN", secret);
    let out = common::run(cmd, None);
    assert_succeeded_cleanly(&out);

    let report = stdout_json(&out);
    assert_eq!(report["ok"], true);
    assert_eq!(report["checks"]["tokenEnv"]["ok"], true);
    assert_eq!(report["checks"]["tokenEnv"]["present"], true);
    assert_eq!(report["checks"]["tokenEnv"]["tokenKind"], "terminal");

    let raw = String::from_utf8(out.stdout).expect("stdout utf8");
    assert!(
        !raw.contains("doctorSecretValue42"),
        "token leaked to stdout"
    );
    assert!(!raw.contains("pcp_term_"), "token prefix leaked to stdout");
}

#[test]
fn doctor_fails_closed_on_world_readable_socket_dir_without_panicking() {
    let tmp = TempDir::new("doctor-unsafe");
    let unsafe_dir = tmp.join("unsafe");
    fs::create_dir_all(&unsafe_dir).expect("create unsafe dir");
    fs::set_permissions(&unsafe_dir, fs::Permissions::from_mode(0o755)).expect("chmod 0755");

    let out = bot(
        &tmp,
        &["doctor", "--socket-dir", &unsafe_dir.to_string_lossy()],
        None,
    );
    assert_no_panic(&out);
    assert!(
        out.status.success(),
        "doctor must report, not crash: {out:#?}"
    );

    let report = stdout_json(&out);
    assert_eq!(report["ok"], false);
    let uds = &report["checks"]["controlSocketDir"];
    assert_eq!(uds["ok"], false);
    let err = uds["error"].as_str().expect("error string");
    assert!(err.contains("0700"), "expected mode error, got {err:?}");
    // Unrelated checks are still evaluated and reported.
    assert_eq!(report["checks"]["compatibility"]["skipped"], true);
    assert_eq!(report["checks"]["processSupervisor"]["ok"], true);
}

#[test]
fn ctl_status_fails_cleanly_when_no_daemon_socket_exists() {
    let tmp = TempDir::new("ctl-nosock");
    let daemon_dir = tmp.private_subdir("paperwork-bot/term-1");
    let socket = daemon_dir.join("control.sock");

    let by_socket = bot(
        &tmp,
        &[
            "ctl",
            "status",
            "--socket",
            &socket.to_string_lossy(),
            "--timeout-secs",
            "1",
        ],
        None,
    );
    let err = assert_failed_cleanly(&by_socket);
    assert!(
        err.starts_with("control socket io error"),
        "unexpected error: {err}"
    );

    let by_terminal = bot(
        &tmp,
        &[
            "ctl",
            "status",
            "--terminal-id",
            "term-1",
            "--timeout-secs",
            "1",
        ],
        None,
    );
    let err = assert_failed_cleanly(&by_terminal);
    assert!(
        err.starts_with("control socket io error"),
        "unexpected error: {err}"
    );

    assert!(!socket.exists(), "ctl must not create a socket file");
}

#[test]
fn ctl_rejects_invalid_usage_without_panicking() {
    let tmp = TempDir::new("ctl-usage");
    let sock = tmp.join("control.sock").to_string_lossy().into_owned();
    let usage = "usage: paperwork-bot ctl";
    let needs_target = "ctl requires either --socket <path> or --terminal-id <id>";
    let bad_segment = "terminal_id must be a single safe path segment";
    let cases: [(Vec<&str>, &str); 5] = [
        (vec!["ctl"], usage),
        (
            vec!["ctl", "bogus", "--socket", &sock],
            "invalid control socket input",
        ),
        (vec!["ctl", "status"], needs_target),
        (
            vec!["ctl", "status", "--socket", &sock, "--timeout-secs", "abc"],
            "invalid --timeout-secs",
        ),
        (
            vec!["ctl", "status", "--terminal-id", "../evil"],
            bad_segment,
        ),
    ];
    for (args, expected) in cases {
        let out = bot(&tmp, &args, None);
        let err = assert_failed_cleanly(&out);
        assert!(
            err.contains(expected),
            "args {args:?}: expected {expected:?} in {err:?}"
        );
    }
}

#[test]
fn eval_policy_malformed_json_fails_closed_without_panicking() {
    let tmp = TempDir::new("eval-bad");
    let malformed = [
        "{not json",
        "",
        "[]",
        "null",
        "{}",
        r#"{"action":"bot_dispatch"}"#,
    ];
    for input in malformed {
        let out = bot(&tmp, &["eval-policy"], Some(input));
        assert_eq!(out.status.code(), Some(1), "input {input:?}: {out:#?}");
        let err = assert_failed_cleanly(&out);
        assert!(
            err.starts_with("invalid policy request JSON"),
            "input {input:?}: unexpected error {err:?}"
        );
    }
}

#[test]
fn eval_policy_valid_request_returns_deterministic_decision() {
    let tmp = TempDir::new("eval-ok");
    let request = json!({
        "action": "bot_dispatch",
        "actor": {"company_id": "co-1", "user_id": "u-1", "role": "member"},
        "bot": {
            "bot_id": "bot-1",
            "company_id": "co-2",
            "owner_user_id": "u-owner",
            "kind": "team",
            "callable_by": "team",
            "data_scope": "team",
            "status": "active",
            "requires_approval": false
        }
    });
    let input = format!("  {}\n", request);
    let out = bot(&tmp, &["eval-policy"], Some(&input));
    assert_succeeded_cleanly(&out);

    let decision = stdout_json(&out);
    assert_eq!(decision["allowed"], false);
    assert_eq!(decision["effect"], "deny");
    assert_eq!(decision["requires_approval"], false);
    assert_eq!(decision["reason_code"], "company_mismatch");
    assert!(decision["message"].as_str().is_some_and(|m| !m.is_empty()));
}

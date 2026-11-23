#![cfg(unix)]

use paperclip_process_supervisor::SupervisedOutcome;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_paperclip-process-supervisor");
const ECHO_SPEC: &[u8] = br#"{"command":"/bin/echo","args":["ok"],"timeout_ms":5000}"#;

fn run_cli(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn assert_successful_echo(output: Output) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout.split_inclusive(|&b| b == b'\n').count(), 1);
    assert!(output.stdout.ends_with(b"\n"));
    let outcome: SupervisedOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.exit_code, Some(0));
    assert!(String::from_utf8_lossy(&outcome.stdout).contains("ok"));
}

fn assert_error(output: Output, code: i32) -> String {
    assert_eq!(output.status.code(), Some(code));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["ok"], false);
    assert_eq!(error["unreaped_pids"], json!([]));
    error["error"].as_str().unwrap().to_owned()
}

#[test]
fn runs_echo_and_reports_outcome() {
    assert_successful_echo(run_cli(&[], ECHO_SPEC));
}

#[test]
fn accepts_stdin_at_limit() {
    let mut input = ECHO_SPEC.to_vec();
    input.resize(65_536, b' ');
    assert_successful_echo(run_cli(&[], &input));
}

#[test]
fn rejects_oversized_stdin_even_with_valid_json_prefix() {
    let mut input = ECHO_SPEC.to_vec();
    input.resize(65_537, b' ');
    assert_eq!(assert_error(run_cli(&[], &input), 1), "stdin_too_large");
}

#[test]
fn rejects_invalid_json() {
    assert!(assert_error(run_cli(&[], b"{not json"), 1).starts_with("invalid_json:"));
}

#[test]
fn rejects_unknown_argument() {
    assert_eq!(
        assert_error(run_cli(&["--nope"], b""), 2),
        "unknown_argument:--nope"
    );
}

#[test]
fn prints_help() {
    for flag in ["--help", "-h"] {
        let output = run_cli(&[flag], b"");
        assert_eq!(output.status.code(), Some(0));
        assert!(String::from_utf8_lossy(&output.stdout).contains("Usage:"));
        assert!(output.stderr.is_empty());
    }
}

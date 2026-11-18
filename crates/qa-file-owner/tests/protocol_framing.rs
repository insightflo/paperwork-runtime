// crates/qa-file-owner/tests/protocol_framing.rs
//
// Real-process protocol framing tests — CLI args, JSONL envelope validation,
// EOF/EPIPE semantics. No mocks; every test spawns the compiled helper binary.

mod common;
use common::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn positional_cli_arg_is_accepted_and_ignored() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("report.md", BEFORE, 0o600);
    let mut h = spawn_helper(&["/some/path/qa-remediation-file-owner.py"]);
    h.begin_ok(&lock_root, &[&file]);
    assert_eq!(h.close_ok(), 0);
}

#[test]
fn malformed_json_line_is_bad_json_exit2() {
    let mut h = spawn_helper(&[]);
    h.raw_write(b"this is not json\n");
    h.expect_error("bad_json", &Value::Null);
}

#[test]
fn eof_mid_line_is_bad_json_exit2() {
    let mut h = spawn_helper(&[]);
    h.raw_write(b"{\"v\":1,\"id\":\"x\"");
    h.close_stdin();
    let f = h.recv();
    assert_eq!(f["code"], json!("bad_json"));
    assert_eq!(f["message"], json!("eof mid-line"));
    assert_eq!(h.wait_code(), 2);
}

#[test]
fn whitespace_only_eof_exits_cleanly() {
    let mut h = spawn_helper(&[]);
    h.raw_write(b"   \t\x0b");
    h.close_stdin();
    assert_eq!(h.wait_code(), 0);
}

#[test]
fn bad_version_preserves_valid_id_and_nulls_invalid() {
    for (frame, expected_id) in [
        (json!({"v": 2, "id": "r1", "op": "close"}), json!("r1")),
        (json!({"v": 1.0, "id": "r2", "op": "close"}), json!("r2")), // float 1.0 is not int 1
        (json!({"v": true, "id": "r3", "op": "close"}), json!("r3")),
        (json!({"v": 2, "id": 7, "op": "close"}), Value::Null),
        (json!({"op": "close"}), Value::Null),
    ] {
        let mut h = spawn_helper(&[]);
        h.send_frame(&frame);
        h.expect_error("bad_version", &expected_id);
    }
}

#[test]
fn bad_request_id_when_id_missing_empty_or_oversized() {
    for frame in [
        json!({"v": 1, "op": "close"}),
        json!({"v": 1, "id": "", "op": "close"}),
        json!({"v": 1, "id": "x".repeat(300), "op": "close"}),
        json!({"v": 1, "id": 12, "op": "close"}),
    ] {
        let mut h = spawn_helper(&[]);
        h.send_frame(&frame);
        h.expect_error("bad_request_id", &Value::Null);
    }
}

#[test]
fn oversized_frame_is_line_too_long() {
    let mut h = spawn_helper(&[]);
    let big = vec![b'x'; MAX_LINE_BYTES + 1];
    h.raw_write(&big);
    h.raw_write(b"\n");
    h.expect_error("line_too_long", &Value::Null);
}

#[test]
fn second_begin_is_already_begun() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    h.send_frame(&json!({
        "v": 1, "id": "again", "op": "begin", "lockRoot": lock_root, "targets": [&file],
    }));
    h.expect_error("already_begun", &json!("again"));
}

#[test]
fn publish_and_close_before_begin_are_not_begun() {
    let mut h1 = spawn_helper(&[]);
    h1.send_frame(&json!({"v": 1, "id": "p", "op": "publish", "items": []}));
    h1.expect_error("not_begun", &json!("p"));
    let mut h2 = spawn_helper(&[]);
    h2.send_frame(&json!({"v": 1, "id": "c", "op": "close"}));
    h2.expect_error("not_begun", &json!("c"));
}

#[test]
fn unknown_ops_are_rejected() {
    for (frame, id) in [
        (json!({"v": 1, "id": "u", "op": "bogus"}), json!("u")),
        (json!({"v": 1, "id": "u2", "op": 5}), json!("u2")),
        (json!({"v": 1, "id": "u3"}), json!("u3")),
    ] {
        let mut h = spawn_helper(&[]);
        h.send_frame(&frame);
        h.expect_error("unknown_op", &id);
    }
}

#[test]
fn broken_stdout_pipe_exits_zero() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let mut child = Command::new(bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    stdin
        .write_all(
            format!(
                "{}\n",
                json!({"v": 1, "id": "b", "op": "begin",
                       "lockRoot": lock_root, "targets": [&file]})
            )
            .as_bytes(),
        )
        .expect("write begin");
    let mut line = String::new();
    reader.read_line(&mut line).expect("read ready");
    assert!(line.contains("\"ready\""), "expected ready frame, got {line:?}");
    drop(reader); // closing our read end makes the child's next write hit EPIPE
    stdin
        .write_all(b"{\"v\":1,\"id\":\"c\",\"op\":\"close\"}\n")
        .expect("write close");
    drop(stdin);
    let status = child.wait().expect("wait");
    assert_eq!(status.code(), Some(0), "child must exit 0 on EPIPE");
}

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_paperclip-fs-scan");

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let mut p = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        p.push(format!("{prefix}-{pid}-{nanos}"));
        fs::create_dir_all(&p).expect("create temp");
        Self(fs::canonicalize(&p).expect("canonicalize"))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_json(subcmd: &str, payload: &Value) -> Value {
    let mut child = Command::new(BIN)
        .arg(subcmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fs-scan");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn count_cli(file: &Path, stop_after: Option<usize>) -> Value {
    let mut cmd = Command::new(BIN);
    cmd.args(["session-count", "--file", file.to_str().unwrap()]);
    if let Some(limit) = stop_after {
        cmd.args(["--stop-after", &limit.to_string()]);
    }
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn session_count_handles_stop_after_malformed_lines_and_missing_files() {
    let tmp = TempDir::new("fs-scan-session");
    let file = tmp.0.join("session.jsonl");
    let big_body = "x".repeat(4096);
    fs::write(
        &file,
        [
            r#"{"type":"session","id":"s1"}"#.to_string(),
            format!(r#"{{"type":"message","body":"{big_body}"}}"#),
            "not-json{".to_string(),
            r#"{"type":"message"} trailing"#.to_string(),
            format!(r#"{{"body":"{big_body}","type":"message"}}"#),
            r#"{"type":"message"}"#.to_string(),
            r#"{"type":"message"}"#.to_string(),
        ]
        .join("\n"),
    )
    .unwrap();

    assert_eq!(count_cli(&file, None)["count"], 4);
    assert_eq!(count_cli(&file, Some(2))["count"], 3);

    let empty = tmp.0.join("empty.jsonl");
    fs::write(&empty, "").unwrap();
    assert_eq!(count_cli(&empty, None)["count"], 0);

    let missing = tmp.0.join("missing.jsonl");
    assert!(count_cli(&missing, None)["count"].is_null());
}

#[test]
fn machine_checks_and_file_hashes_match_filesystem_contract() {
    let tmp = TempDir::new("fs-scan-checks");
    let dir = tmp.0.join("assets");
    let nested = dir.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(dir.join("a.png"), b"png1").unwrap();
    fs::write(nested.join("b.png"), b"png2").unwrap();
    let outside = tmp.0.join("outside.png");
    fs::write(&outside, b"ext").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("link.png")).unwrap();

    let hash_res = run_json(
        "file-hashes",
        &json!({
            "maxBytes": 4,
            "paths": [
                dir.join("a.png").to_str().unwrap(),
                dir.join("missing.png").to_str().unwrap(),
                nested.to_str().unwrap(),
            ]
        }),
    );
    let files = hash_res["files"].as_array().unwrap();
    let expected_hex = "3f0aadd1667d7b31846d4aa043295e21c03f791d7d4c10ff9a150a71a9d40ea2";
    assert_eq!(files[0]["exists"], true);
    assert_eq!(files[0]["sha256"], expected_hex);
    assert_eq!(files[1]["exists"], false);
    assert!(files[1]["sha256"].is_null());
    assert_eq!(files[2]["exists"], false);

    let checks_res = run_json(
        "machine-checks",
        &json!({
            "checks": [
                { "kind": "file_glob", "displayPath": "assets", "resolvedPath": dir.to_str().unwrap(), "glob": "**/*.png", "minCount": 2 },
                { "kind": "file_glob", "displayPath": "assets", "resolvedPath": dir.to_str().unwrap(), "glob": "*.png", "minCount": 2 },
                { "kind": "file_exists", "displayPath": "a.png", "resolvedPath": dir.join("a.png").to_str().unwrap() },
                { "kind": "min_size_bytes", "displayPath": "a.png", "resolvedPath": dir.join("a.png").to_str().unwrap(), "minBytes": 4 },
                { "kind": "content_sha256", "displayPath": "a.png", "resolvedPath": dir.join("a.png").to_str().unwrap(), "sha256": expected_hex.to_uppercase() },
            ]
        }),
    );
    let results = checks_res["results"].as_array().unwrap();
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[0]["detail"], "matched 2 file(s) >= 2");
    assert_eq!(results[1]["ok"], false);
    assert_eq!(results[1]["detail"], "matched 1 file(s), required >= 2");
    assert_eq!(results[2]["ok"], true);
    assert_eq!(results[3]["ok"], true);
    assert_eq!(results[4]["ok"], true);
    assert_eq!(results[4]["detail"], "sha256 matches");
}

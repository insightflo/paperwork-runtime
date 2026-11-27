//! Shared helpers for `paperwork-bot` CLI integration tests (included via `mod common;`).
//!
//! Every invocation runs the real binary against an isolated temporary runtime directory
//! (`XDG_RUNTIME_DIR`) with all token environment variables removed, so tests never depend on a
//! developer shell, a running daemon, or a reachable server.
#![allow(dead_code)]

use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

pub const BIN: &str = env!("CARGO_BIN_EXE_paperwork-bot");
pub const TOKEN_ENV_KEYS: [&str; 3] = [
    "PAPERWORK_TOKEN",
    "PAPERWORK_TERMINAL_TOKEN",
    "PAPERWORK_BOT_TOKEN",
];

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Temporary `0700` directory that is removed (best effort) on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pwork-cli-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("chmod 0700");
        Self(fs::canonicalize(&path).expect("canonicalize temp dir"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    /// Creates a `0700` subdirectory (e.g. a daemon runtime dir left behind without a socket).
    pub fn private_subdir(&self, rel: &str) -> PathBuf {
        let dir = self.join(rel);
        fs::create_dir_all(&dir).expect("create subdir");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("chmod subdir");
        dir
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Builds a `paperwork-bot` invocation with isolated runtime dir and no inherited tokens.
pub fn bot_command(runtime_dir: &TempDir, args: &[&str]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env("XDG_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for key in TOKEN_ENV_KEYS {
        cmd.env_remove(key);
    }
    cmd
}

/// Runs the command, optionally feeding `stdin`, and returns the collected output.
pub fn run(mut cmd: Command, stdin: Option<&str>) -> Output {
    use std::io::Write;
    let mut child = cmd.spawn().expect("spawn paperwork-bot");
    if let Some(input) = stdin {
        child
            .stdin
            .as_mut()
            .expect("piped stdin")
            .write_all(input.as_bytes())
            .expect("write stdin");
    }
    drop(child.stdin.take());
    child.wait_with_output().expect("wait for paperwork-bot")
}

/// Builds and runs `paperwork-bot <args>` in one step.
pub fn bot(dir: &TempDir, args: &[&str], stdin: Option<&str>) -> Output {
    run(bot_command(dir, args), stdin)
}

/// Success contract: stdout is exactly one JSON value.
pub fn stdout_json(out: &Output) -> Value {
    let text = String::from_utf8(out.stdout.clone()).expect("stdout utf8");
    serde_json::from_str(text.trim())
        .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {text:?}"))
}

/// Failure contract: stderr is exactly one JSON object with a string `error` field.
pub fn stderr_error(out: &Output) -> String {
    let text = String::from_utf8(out.stderr.clone()).expect("stderr utf8");
    let value: Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|e| panic!("stderr is not a JSON error object ({e}): {text:?}"));
    value["error"]
        .as_str()
        .unwrap_or_else(|| panic!("stderr JSON lacks string `error`: {text:?}"))
        .to_string()
}

pub fn assert_no_panic(out: &Output) {
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !combined.contains("panicked"),
        "binary panicked: {combined}"
    );
}

/// Asserts the fail-closed CLI contract and returns the redacted error message.
pub fn assert_failed_cleanly(out: &Output) -> String {
    assert_no_panic(out);
    assert!(
        !out.status.success(),
        "expected non-zero exit, got {:#?}",
        out.status
    );
    assert!(
        out.stdout.is_empty(),
        "failure must not write to stdout: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
    stderr_error(out)
}

/// Asserts the success CLI contract (exit 0, nothing on stderr, no panic).
pub fn assert_succeeded_cleanly(out: &Output) {
    assert_no_panic(out);
    assert!(out.status.success(), "expected exit 0, got {out:#?}");
    assert!(
        out.stderr.is_empty(),
        "success must not write to stderr: {:?}",
        String::from_utf8_lossy(&out.stderr)
    );
}

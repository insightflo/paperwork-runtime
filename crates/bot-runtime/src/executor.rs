//! Confined command execution + streaming secret redaction.
//!
//! Wires:
//! - `paperclip-process-supervisor`: `-pgid` process-group confinement + isolated env scrubbing
//!   (`env_clear`) so `PAPERWORK_TERMINAL_TOKEN` / `PAPERWORK_BOT_TOKEN` can NEVER leak to child processes.
//! - `paperclip-redactor-core`: `StreamingRedactor` with `[redacted-unscanned]` fail-closed
//!   redaction seeded with active tokens.

use crate::client::{ENV_BOT_TOKEN, ENV_TERMINAL_TOKEN};
use crate::token::redact_secrets;
use paperclip_process_supervisor::{
    run_supervised, IsolatedEnvSpec, SupervisedSpawnSpec, SupervisionError,
};
use paperclip_redactor_core::{RedactorConfig, StreamingRedactor};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const SAFE_INHERIT_ENV_KEYS: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
const SCRUBBED_ENV_KEYS: &[&str] = &[ENV_TERMINAL_TOKEN, ENV_BOT_TOKEN, "PAPERWORK_TOKEN"];

#[derive(Debug)]
pub enum ExecutorError {
    Invalid(String),
    Supervision(String),
}

impl fmt::Display for ExecutorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid execution request: {m}"),
            Self::Supervision(m) => write!(f, "process supervision error: {m}"),
        }
    }
}

impl std::error::Error for ExecutorError {}

impl From<SupervisionError> for ExecutorError {
    fn from(e: SupervisionError) -> Self {
        Self::Supervision(redact_secrets(&e.to_string()))
    }
}

#[derive(Debug, Clone)]
pub struct ConfinedExecRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env_overrides: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub grace_ms: u64,
    pub active_secrets: Vec<String>,
    pub max_buffer_bytes: Option<usize>,
    pub max_scan_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfinedExecResult {
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn is_scrubbed_env_key(key: &str) -> bool {
    SCRUBBED_ENV_KEYS
        .iter()
        .any(|k| k.eq_ignore_ascii_case(key))
}

/// Builds an isolated environment allowlist for child processes.
/// Always scrubs `PAPERWORK_TERMINAL_TOKEN`, `PAPERWORK_BOT_TOKEN`, `PAPERWORK_TOKEN`,
/// and any variable whose value matches an active secret.
pub fn build_isolated_env(
    overrides: &BTreeMap<String, String>,
    active_secrets: &[String],
) -> IsolatedEnvSpec {
    let mut vars = BTreeMap::new();
    for &key in SAFE_INHERIT_ENV_KEYS {
        if let Ok(val) = env::var(key) {
            if !val.is_empty() {
                vars.insert(key.to_string(), val);
            }
        }
    }
    vars.entry("PATH".to_string())
        .or_insert_with(|| "/usr/bin:/bin".to_string());

    for (k, v) in overrides {
        if is_scrubbed_env_key(k) {
            continue;
        }
        if active_secrets
            .iter()
            .any(|s| !s.is_empty() && v.contains(s.as_str()))
        {
            continue;
        }
        vars.insert(k.clone(), v.clone());
    }

    // Defensive final scrub.
    vars.retain(|k, _| !is_scrubbed_env_key(k));
    IsolatedEnvSpec { vars }
}

/// Redacts arbitrary stream bytes using `paperclip-redactor-core::StreamingRedactor`
/// seeded with `active_secrets` (plus `[redacted-unscanned]` fail-closed degradation on
/// invalid UTF-8, unclosed PEM blocks, or buffer/scan limits).
pub fn redact_stream_bytes(
    bytes: &[u8],
    active_secrets: &[String],
    max_buffer_bytes: Option<usize>,
    max_scan_bytes: Option<usize>,
) -> String {
    let mut extra_secrets: Vec<String> = active_secrets
        .iter()
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .collect();
    for &env_key in SCRUBBED_ENV_KEYS {
        if let Ok(val) = env::var(env_key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                extra_secrets.push(trimmed.to_string());
            }
        }
    }

    let mut redactor = StreamingRedactor::new(RedactorConfig {
        extra_secrets,
        max_buffer_bytes,
        max_scan_bytes,
    });

    let mut out = String::new();
    for chunk in bytes.chunks(4096) {
        out.push_str(&redactor.push_bytes(chunk));
    }
    out.push_str(&redactor.finish());
    redact_secrets(&out)
}

struct ActiveChildGuard<'a>(Option<&'a AtomicUsize>);

impl<'a> ActiveChildGuard<'a> {
    fn new(counter: Option<&'a AtomicUsize>) -> Self {
        if let Some(c) = counter {
            c.fetch_add(1, Ordering::Relaxed);
        }
        Self(counter)
    }
}

impl Drop for ActiveChildGuard<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.0 {
            c.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Runs a command under `paperclip-process-supervisor` (`-pgid` process-group confinement +
/// isolated env scrubbing) and streams stdout/stderr through `StreamingRedactor`.
pub fn execute_confined(
    req: &ConfinedExecRequest,
    active_children: Option<&AtomicUsize>,
) -> Result<ConfinedExecResult, ExecutorError> {
    if req.command.trim().is_empty() {
        return Err(ExecutorError::Invalid("command must be non-empty".into()));
    }

    let _guard = ActiveChildGuard::new(active_children);
    let spec = SupervisedSpawnSpec {
        command: req.command.clone(),
        args: req.args.clone(),
        cwd: req.cwd.clone(),
        env: build_isolated_env(&req.env_overrides, &req.active_secrets),
        timeout_ms: req.timeout_ms.max(1),
        grace_ms: req.grace_ms,
        drain_deadline_ms: Some(250),
        reap_timeout_ms: Some(1_000),
    };

    let outcome = run_supervised(&spec)?;
    let stdout = redact_stream_bytes(
        &outcome.stdout,
        &req.active_secrets,
        req.max_buffer_bytes,
        req.max_scan_bytes,
    );
    let stderr = redact_stream_bytes(
        &outcome.stderr,
        &req.active_secrets,
        req.max_buffer_bytes,
        req.max_scan_bytes,
    );

    Ok(ConfinedExecResult {
        timed_out: outcome.timed_out,
        exit_code: outcome.exit_code,
        signal: outcome.signal,
        stdout,
        stderr,
    })
}

/// Quick self-test used by `paperwork-bot doctor` to verify process-supervisor confinement works.
pub fn supervisor_self_test() -> Result<(), ExecutorError> {
    let req = ConfinedExecRequest {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), "printf ok".into()],
        cwd: None,
        env_overrides: BTreeMap::new(),
        timeout_ms: 2_000,
        grace_ms: 100,
        active_secrets: Vec::new(),
        max_buffer_bytes: Some(64 * 1024),
        max_scan_bytes: Some(64 * 1024),
    };
    let res = execute_confined(&req, None)?;
    if res.timed_out || res.exit_code != Some(0) || res.stdout != "ok" {
        return Err(ExecutorError::Supervision(format!(
            "supervisor self-test unexpected result: exit={:?} timed_out={} stdout={:?}",
            res.exit_code, res.timed_out, res.stdout
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confined_exec_scrubs_terminal_token_and_redacts_stream_output() {
        let secret = "pcp_term_super_secret_token_999";
        let custom_secret = "custom_live_token_abcdef";
        let mut overrides = BTreeMap::new();
        overrides.insert(ENV_TERMINAL_TOKEN.to_string(), secret.to_string());
        overrides.insert("SAFE_VAR".to_string(), "hello-confined".to_string());

        let active_children = AtomicUsize::new(0);
        let req = ConfinedExecRequest {
            command: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                format!(
                    "printf 'env=%s safe=%s leak=%s\\n' \"$PAPERWORK_TERMINAL_TOKEN\" \"$SAFE_VAR\" '{custom_secret}'"
                ),
            ],
            cwd: None,
            env_overrides: overrides,
            timeout_ms: 3_000,
            grace_ms: 100,
            active_secrets: vec![secret.to_string(), custom_secret.to_string()],
            max_buffer_bytes: Some(64 * 1024),
            max_scan_bytes: Some(64 * 1024),
        };

        let res = execute_confined(&req, Some(&active_children)).unwrap();
        assert_eq!(active_children.load(Ordering::Relaxed), 0);
        assert!(!res.timed_out);
        assert_eq!(res.exit_code, Some(0));
        assert!(res.stdout.contains("env= safe=hello-confined"));
        assert!(!res.stdout.contains(secret));
        assert!(!res.stdout.contains(custom_secret));
        assert!(res.stdout.contains("[redacted]"));
    }

    #[test]
    fn streaming_redactor_fails_closed_on_invalid_utf8_and_buffer_overflow() {
        let invalid = redact_stream_bytes(b"head\xfftail\n", &[], None, None);
        assert!(invalid.contains("[redacted-unscanned]"));

        let overflow = redact_stream_bytes(b"0123456789abcdef", &[], Some(8), None);
        assert!(overflow.contains("[redacted-unscanned]"));
    }

    #[test]
    fn supervisor_self_test_passes() {
        supervisor_self_test().unwrap();
    }
}

#![forbid(unsafe_code)]
//! Agent process runner: validates run specs and executes local agent adapters
//! under the process supervisor, mapping outcomes onto engine run results.
use paperclip_process_supervisor::{
    run_supervised, IsolatedEnvSpec, SupervisedOutcome, SupervisedSpawnSpec, SupervisionError};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

use crate::RunStatus;

const MAX_EXCERPT_BYTES: usize = 4096;
const MAX_TIMEOUT_MS: u64 = 3_600_000;
const MAX_GRACE_MS: u64 = 60_000;

/// Local agent adapter kind; serde values are the wire/config strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentAdapterKind {
    #[serde(rename = "pi_local")]
    PiLocal,
    #[serde(rename = "commandcode_local")]
    CommandCodeLocal,
}

/// Inputs for one supervised agent run; see `validate_run_spec`.
#[derive(Debug, Clone)]
pub struct AgentRunSpec {
    pub adapter: AgentAdapterKind,
    pub executable: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub timeout_ms: u64,
    pub grace_ms: u64,
}

/// Terminal view of one agent run attempt.
#[derive(Debug)]
pub struct AgentRunResult {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub error: Option<String>,
    pub error_code: Option<String>,
    /// When set, the caller MUST take exclusive wait ownership and reap this
    /// child, and MUST NOT signal it or re-dispatch the run until reaped.
    pub unreaped_pid: Option<i32>,
    pub stdout_excerpt: String,
    pub stderr_excerpt: String,
    pub stdout_captured_bytes: usize,
    pub stderr_captured_bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunnerSpecError {
    EmptyExecutable, RelativeExecutable, NulByte(&'static str), EmptyEnvKey,
    EnvKeyContainsEquals(String), CwdNotDirectory, TimeoutOutOfRange, GraceOutOfRange,
}

impl std::fmt::Display for RunnerSpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&match self {
            Self::EmptyExecutable => "executable path is empty".into(),
            Self::RelativeExecutable => "executable path must be absolute".into(),
            Self::NulByte(field) => format!("NUL byte in {field}"),
            Self::EmptyEnvKey => "env key is empty".into(),
            Self::EnvKeyContainsEquals(key) => format!("env key contains '=': {key}"),
            Self::CwdNotDirectory => "cwd is not a directory".into(),
            Self::TimeoutOutOfRange => format!("timeout_ms outside 1..={MAX_TIMEOUT_MS}"),
            Self::GraceOutOfRange => format!("grace_ms exceeds {MAX_GRACE_MS}"),
        })
    }
}
impl std::error::Error for RunnerSpecError {}

/// Rejects specs that cannot be spawned safely: empty/relative/NUL-bearing
/// executable, NUL in args/env, empty or `=`-bearing env keys, a missing cwd,
/// or timeout/grace outside the bounded supervision range.
pub fn validate_run_spec(spec: &AgentRunSpec) -> Result<(), RunnerSpecError> {
    use RunnerSpecError::*;
    if spec.executable.is_empty() { return Err(EmptyExecutable); }
    if spec.executable.contains('\0') { return Err(NulByte("executable")); }
    if !Path::new(&spec.executable).is_absolute() { return Err(RelativeExecutable); }
    if spec.args.iter().any(|arg| arg.contains('\0')) { return Err(NulByte("args")); }
    for (key, value) in &spec.env {
        if key.is_empty() { return Err(EmptyEnvKey); }
        if key.contains('=') { return Err(EnvKeyContainsEquals(key.clone())); }
        if key.contains('\0') || value.contains('\0') { return Err(NulByte("env")); }
    }
    if !spec.cwd.is_dir() { return Err(CwdNotDirectory); }
    if spec.timeout_ms == 0 || spec.timeout_ms > MAX_TIMEOUT_MS { return Err(TimeoutOutOfRange); }
    if spec.grace_ms > MAX_GRACE_MS { return Err(GraceOutOfRange); }
    Ok(())
}

/// Returns the last <= `max_bytes` of `bytes` as UTF-8, cut on a char boundary
/// of the lossy-decoded text so the result never exceeds `max_bytes` bytes.
pub fn utf8_tail_excerpt(bytes: &[u8], max_bytes: usize) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    if lossy.len() <= max_bytes { return lossy.into_owned(); }
    let mut start = lossy.len() - max_bytes;
    while !lossy.is_char_boundary(start) { start += 1; }
    lossy[start..].to_owned()
}

fn status_and_code(o: &SupervisedOutcome) -> (RunStatus, Option<&'static str>, Option<String>) {
    if o.timed_out {
        return (RunStatus::TimedOut, Some("timed_out"), Some("process exceeded timeout".into()));
    }
    if let Some(signal) = o.signal {
        return (RunStatus::Failed, Some("signaled"), Some(format!("terminated by signal {signal}")));
    }
    match o.exit_code {
        Some(0) => (RunStatus::Succeeded, None, None),
        Some(code) => {
            (RunStatus::Failed, Some("non_zero_exit"), Some(format!("exited with code {code}")))
        }
        None => (RunStatus::Failed, Some("no_exit_status"), None),
    }
}

/// Maps a supervision result onto an `AgentRunResult`. On `Err`, the partial
/// outcome and `unreaped_pid` are preserved; `error_code` is
/// `"reap_handoff_pending"` whenever `unreaped_pid` is set — the caller MUST
/// exclusively reap that pid and MUST NOT signal it or re-dispatch the run
/// until it is reaped — and `"supervision_error"` otherwise.
pub fn map_supervision_result(result: Result<SupervisedOutcome, SupervisionError>) -> AgentRunResult {
    let (outcome, error, error_code, unreaped_pid) = match result {
        Ok(outcome) => (Some(outcome), None, None, None),
        Err(err) => {
            let code = if err.unreaped_pid.is_some() { "reap_handoff_pending" } else { "supervision_error" };
            (err.outcome, Some(err.errors.join("; ")), Some(code), err.unreaped_pid)
        }
    };
    let (status, outcome_code, outcome_error) = outcome.as_ref()
        .map_or((RunStatus::Failed, None, None), status_and_code);
    AgentRunResult {
        status,
        exit_code: outcome.as_ref().and_then(|o| o.exit_code),
        signal: outcome.as_ref().and_then(|o| o.signal),
        error: error.or(outcome_error),
        error_code: error_code.or(outcome_code).map(str::to_string),
        unreaped_pid,
        stdout_excerpt: outcome.as_ref()
            .map_or_else(String::new, |o| utf8_tail_excerpt(&o.stdout, MAX_EXCERPT_BYTES)),
        stderr_excerpt: outcome.as_ref()
            .map_or_else(String::new, |o| utf8_tail_excerpt(&o.stderr, MAX_EXCERPT_BYTES)),
        stdout_captured_bytes: outcome.as_ref().map_or(0, |o| o.stdout.len()),
        stderr_captured_bytes: outcome.as_ref().map_or(0, |o| o.stderr.len()),
    }
}

/// Validates `spec`, then runs it supervised with isolated env and bounded
/// timeout/grace. Spec violations are the only `Err` path; supervision
/// failures map into `AgentRunResult`.
pub fn execute_agent_run(spec: &AgentRunSpec) -> Result<AgentRunResult, RunnerSpecError> {
    validate_run_spec(spec)?;
    let spawn = SupervisedSpawnSpec {
        command: spec.executable.clone(),
        args: spec.args.clone(),
        cwd: Some(spec.cwd.clone()),
        env: IsolatedEnvSpec { vars: spec.env.clone() },
        timeout_ms: spec.timeout_ms,
        grace_ms: spec.grace_ms,
        drain_deadline_ms: None,
        reap_timeout_ms: None,
    };
    Ok(map_supervision_result(run_supervised(&spawn)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use RunnerSpecError::*;

    fn base_spec() -> AgentRunSpec {
        AgentRunSpec { adapter: AgentAdapterKind::PiLocal, executable: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()], cwd: PathBuf::from("/tmp"),
            env: BTreeMap::from([("W6A_MARKER".into(), "present".into())]),
            timeout_ms: 10_000, grace_ms: 100 }
    }

    #[test]
    fn validate_rejects_bad_specs() {
        let mut spec = base_spec();
        spec.executable = String::new(); assert_eq!(validate_run_spec(&spec), Err(EmptyExecutable));
        spec.executable = "bin/sh".into(); assert_eq!(validate_run_spec(&spec), Err(RelativeExecutable));
        spec.executable = "/bin/sh\0x".into(); assert_eq!(validate_run_spec(&spec), Err(NulByte("executable")));
        spec = base_spec(); spec.args.push("a\0".into());
        assert_eq!(validate_run_spec(&spec), Err(NulByte("args")));
        spec = base_spec(); spec.env.insert(String::new(), "v".into());
        assert_eq!(validate_run_spec(&spec), Err(EmptyEnvKey));
        spec.env.clear(); spec.env.insert("K=V".into(), "v".into());
        assert_eq!(validate_run_spec(&spec), Err(EnvKeyContainsEquals("K=V".into())));
        spec = base_spec(); spec.cwd = PathBuf::from("/w6a/definitely-missing");
        assert_eq!(validate_run_spec(&spec), Err(CwdNotDirectory));
        spec.cwd = PathBuf::from("/tmp"); spec.timeout_ms = 0;
        assert_eq!(validate_run_spec(&spec), Err(TimeoutOutOfRange));
    }

    #[test]
    fn map_preserves_reap_handoff() {
        let stdout = [vec![0x80u8; 5000], vec![0xFE, 0xFF]].concat();
        let outcome = SupervisedOutcome { timed_out: false, exit_code: Some(3), signal: None,
            stdout, stderr: Vec::new() };
        let err = SupervisionError { errors: vec!["waitpid deadline expired".to_string()],
            outcome: Some(outcome), unreaped_pid: Some(4242) };
        let result = map_supervision_result(Err(err));
        assert_eq!(result.unreaped_pid, Some(4242));
        assert_eq!(result.error_code.as_deref(), Some("reap_handoff_pending"));
        assert_eq!((result.status, result.exit_code), (RunStatus::Failed, Some(3)));
        assert!(result.error.as_deref().unwrap_or_default().contains("waitpid"));
        assert!(result.stdout_excerpt.len() <= MAX_EXCERPT_BYTES);
        assert_eq!(result.stdout_captured_bytes, 5002);
    }

    #[test]
    fn executes_env_with_isolated_env() {
        let mut spec = base_spec();
        spec.executable = "/usr/bin/env".into(); spec.args = Vec::new();
        let result = execute_agent_run(&spec).unwrap();
        assert_eq!((result.status, result.exit_code), (RunStatus::Succeeded, Some(0)));
        assert!(result.error_code.is_none() && result.unreaped_pid.is_none());
        assert!(result.stdout_excerpt.contains("W6A_MARKER=present"));
        assert!(!result.stdout_excerpt.contains("HOME="));
    }

    #[test]
    fn executes_sh_nonzero_and_timeout() {
        let mut spec = base_spec(); spec.args = vec!["-c".into(), "exit 7".into()];
        let result = execute_agent_run(&spec).unwrap();
        assert_eq!((result.status, result.exit_code), (RunStatus::Failed, Some(7)));
        assert_eq!(result.error_code.as_deref(), Some("non_zero_exit"));
        let mut spec = base_spec(); spec.args = vec!["-c".into(), "sleep 10".into()];
        spec.timeout_ms = 300; spec.grace_ms = 50;
        let result = execute_agent_run(&spec).unwrap();
        assert_eq!(result.status, RunStatus::TimedOut);
        assert_eq!(result.error_code.as_deref(), Some("timed_out"));
    }
}

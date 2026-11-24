#![forbid(unsafe_code)]
//! JSON-RPC handler for `heartbeat.run_agent`: validates inputs fail-closed and
//! executes `paperwork_engine_heartbeat::runner::execute_agent_run` inside
//! `tokio::task::spawn_blocking`, preserving `unreaped_pid`,
//! `"reap_handoff_pending"`, and bounded output excerpts.
//!
//! Host precondition: `paperwork-engine` runs no competing `waitpid` loops and
//! keeps default `SIGCHLD` disposition (no `SIG_IGN`/`SA_NOCLDWAIT`) from before
//! spawn through completion or reap handoff.

use serde_json::{json, Value};

fn err(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[cfg(unix)]
mod unix_impl {
    use super::err;
    use paperwork_engine_heartbeat::runner::{
        execute_agent_run, validate_run_spec, AgentAdapterKind, AgentRunResult, AgentRunSpec,
    };
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
    };

    const DEFAULT_GRACE_MS: u64 = 5_000;
    static RUN_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    static RUN_CALL_LOCK: Mutex<()> = Mutex::new(());

    fn default_grace_ms() -> u64 {
        DEFAULT_GRACE_MS
    }

    fn ok(id: Value, result: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RunAgentParams {
        adapter: AgentAdapterKind,
        executable: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        cwd: String,
        timeout_ms: u64,
        #[serde(default = "default_grace_ms")]
        grace_ms: u64,
    }

    fn parse_and_validate(params: Option<&Value>) -> Option<AgentRunSpec> {
        let obj = params.filter(|p| p.is_object())?;
        let p: RunAgentParams = serde_json::from_value(obj.clone()).ok()?;
        if p.cwd.is_empty() || p.cwd.contains('\0') || !Path::new(&p.cwd).is_absolute() {
            return None;
        }
        let spec = AgentRunSpec {
            adapter: p.adapter,
            executable: p.executable,
            args: p.args,
            env: p.env,
            cwd: PathBuf::from(p.cwd),
            timeout_ms: p.timeout_ms,
            grace_ms: p.grace_ms,
        };
        validate_run_spec(&spec).ok()?;
        Some(spec)
    }

    pub(super) fn result_to_json(res: &AgentRunResult) -> Value {
        json!({
            "status": res.status,
            "exit_code": res.exit_code,
            "signal": res.signal,
            "error": res.error,
            "error_code": res.error_code,
            "unreaped_pid": res.unreaped_pid,
            "stdout_excerpt": res.stdout_excerpt,
            "stderr_excerpt": res.stderr_excerpt,
            "stdout_captured_bytes": res.stdout_captured_bytes,
            "stderr_captured_bytes": res.stderr_captured_bytes,
        })
    }

    pub(super) fn dispatch_with(id: Value, params: Option<&Value>) -> Value {
        let Some(spec) = parse_and_validate(params) else {
            return err(id, -32602, "invalid_params");
        };
        let rt = RUN_RUNTIME.get_or_init(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(4)
                .build()
                .expect("heartbeat_run tokio runtime")
        });
        let _guard = RUN_CALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let outcome = rt.block_on(async move {
            tokio::task::spawn_blocking(move || execute_agent_run(&spec)).await
        });
        match outcome {
            Ok(Ok(res)) => ok(id, result_to_json(&res)),
            Ok(Err(_)) => err(id, -32602, "invalid_params"),
            Err(_) => err(id, -32603, "internal_error"),
        }
    }
}

pub(crate) fn dispatch_with(id: Value, params: Option<&Value>) -> Value {
    #[cfg(unix)]
    {
        unix_impl::dispatch_with(id, params)
    }
    #[cfg(not(unix))]
    {
        let _ = params;
        err(id, -32004, "unsupported_platform")
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{dispatch_with, unix_impl::result_to_json};
    use paperclip_provider_auth_core::ProbeEnv;
    use paperwork_engine_heartbeat::{runner::AgentRunResult, RunStatus};
    use serde_json::{json, Value};

    fn code(v: &Value) -> i64 {
        v["error"]["code"].as_i64().unwrap_or(0)
    }

    fn call_rpc(params: Value) -> Value {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "heartbeat.run_agent",
            "params": params,
        });
        crate::handle_with(req.to_string().as_bytes(), &ProbeEnv::from_pairs(&[]))
    }

    #[test]
    fn param_validation_fails_closed() {
        assert_eq!(code(&dispatch_with(json!(1), None)), -32602);
        let base = json!({
            "adapter": "pi_local",
            "executable": "/bin/sh",
            "args": ["-c", "exit 0"],
            "env": {"A": "1"},
            "cwd": "/tmp",
            "timeout_ms": 5000,
            "grace_ms": 100
        });
        let bad_cases = vec![
            json!(null),
            json!([]),
            json!({}),
            json!("string"),
            json!({"adapter": "unknown", "executable": "/bin/sh", "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "", "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "bin/sh", "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh\0x", "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "args": ["a\0b"], "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "env": {"": "v"}, "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "env": {"K=V": "v"}, "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "env": {"K": "v\0"}, "cwd": "/tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "tmp", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/tmp\0x", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/definitely-missing-w6b-dir", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/bin/sh", "timeout_ms": 1000}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/tmp", "timeout_ms": 0}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/tmp", "timeout_ms": 3_600_001}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/tmp", "timeout_ms": 1000, "grace_ms": 60_001}),
            json!({"adapter": "pi_local", "executable": "/bin/sh", "cwd": "/tmp", "timeout_ms": 1000, "extra": 1}),
        ];
        for bad in bad_cases {
            assert_eq!(code(&call_rpc(bad.clone())), -32602, "expected -32602 for {bad}");
        }
        assert_eq!(call_rpc(base)["result"]["status"], json!("succeeded"));
    }

    #[test]
    fn run_agent_success_isolated_env_and_default_grace() {
        let resp = call_rpc(json!({
            "adapter": "commandcode_local",
            "executable": "/usr/bin/env",
            "env": {"W6B_MARKER": "isolated_ok"},
            "cwd": "/tmp",
            "timeout_ms": 5000
        }));
        assert_eq!(resp["id"], json!(42));
        let r = &resp["result"];
        assert_eq!(r["status"], json!("succeeded"));
        assert_eq!(r["exit_code"], json!(0));
        assert!(r["error"].is_null() && r["error_code"].is_null() && r["unreaped_pid"].is_null());
        let out = r["stdout_excerpt"].as_str().unwrap();
        assert!(out.contains("W6B_MARKER=isolated_ok"));
        assert!(!out.contains("HOME="));
    }

    #[test]
    fn run_agent_nonzero_exit_timeout_and_bounded_output() {
        let nonzero = call_rpc(json!({
            "adapter": "pi_local",
            "executable": "/bin/sh",
            "args": ["-c", "echo errline >&2; exit 9"],
            "cwd": "/tmp",
            "timeout_ms": 5000,
            "grace_ms": 100
        }));
        let nr = &nonzero["result"];
        assert_eq!(nr["status"], json!("failed"));
        assert_eq!(nr["exit_code"], json!(9));
        assert_eq!(nr["error_code"], json!("non_zero_exit"));
        assert!(nr["stderr_excerpt"].as_str().unwrap().contains("errline"));

        let timed_out = call_rpc(json!({
            "adapter": "pi_local",
            "executable": "/bin/sh",
            "args": ["-c", "sleep 10"],
            "cwd": "/tmp",
            "timeout_ms": 250,
            "grace_ms": 50
        }));
        let tr = &timed_out["result"];
        assert_eq!(tr["status"], json!("timed_out"));
        assert_eq!(tr["error_code"], json!("timed_out"));

        let big = call_rpc(json!({
            "adapter": "pi_local",
            "executable": "/bin/sh",
            "args": ["-c", "head -c 10000 /dev/zero | tr '\\0' 'a'"],
            "cwd": "/tmp",
            "timeout_ms": 5000,
            "grace_ms": 100
        }));
        let br = &big["result"];
        assert_eq!(br["status"], json!("succeeded"));
        assert_eq!(br["stdout_captured_bytes"], json!(10000));
        assert_eq!(br["stdout_excerpt"].as_str().unwrap().len(), 4096);
    }

    #[test]
    fn result_json_preserves_reap_handoff_and_pid() {
        let res = AgentRunResult {
            status: RunStatus::Failed,
            exit_code: Some(0),
            signal: Some(9),
            error: Some("waitpid deadline expired".into()),
            error_code: Some("reap_handoff_pending".into()),
            unreaped_pid: Some(4242),
            stdout_excerpt: "tail".into(),
            stderr_excerpt: "err tail".into(),
            stdout_captured_bytes: 5000,
            stderr_captured_bytes: 300,
        };
        let json_val = result_to_json(&res);
        assert_eq!(json_val, json!({
            "status": "failed",
            "exit_code": 0,
            "signal": 9,
            "error": "waitpid deadline expired",
            "error_code": "reap_handoff_pending",
            "unreaped_pid": 4242,
            "stdout_excerpt": "tail",
            "stderr_excerpt": "err tail",
            "stdout_captured_bytes": 5000,
            "stderr_captured_bytes": 300,
        }));
    }
}

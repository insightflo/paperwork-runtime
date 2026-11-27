//! `paperwork-bot` CLI binary.
//!
//! Subcommands:
//! - `eval-policy`: Reads a `PolicyEvalRequest` JSON object from stdin and prints a deterministic
//!   `GovernanceDecision` JSON object to stdout.
//! - `verify-token --expected-sha256 <hex>`: Verifies a token read from env
//!   (`PAPERWORK_TOKEN`, `PAPERWORK_TERMINAL_TOKEN`, or `PAPERWORK_BOT_TOKEN`) or stdin against
//!   the expected SHA-256 hex digest in constant time. Never accepts raw tokens as CLI arguments
//!   and never prints raw tokens.
//! - `heartbeat --server <url> --terminal-id <id> [--status <status>] [--hostname <name>]`:
//!   Sends a terminal heartbeat using `PAPERWORK_TERMINAL_TOKEN`.
//! - `daemon --server <url> --terminal-id <id> [--interval-secs <n>] [--max-iterations <n>] [--socket <path>] [--state-file <path>]`:
//!   Runs a terminal heartbeat daemon loop using `PAPERWORK_TERMINAL_TOKEN`.
//! - `inbound --server <url> --bot-id <id>`:
//!   Reads a JSON payload from stdin and posts it to the bot inbound endpoint using `PAPERWORK_BOT_TOKEN`.
//! - `ctl <status|drain|shutdown> [--socket <path>] [--terminal-id <id>]`:
//!   Sends a local JSON-over-UDS control command to a running `paperwork-bot daemon`.
//! - `doctor [--server <url>] [--terminal-id <id>] [--socket-dir <path>]`:
//!   Runs local diagnostics (token env presence/prefix without printing it, UDS dir `0700` check,
//!   `/compatibility` reachability, and process-supervisor self-test) and outputs a JSON summary.

use paperwork_bot_runtime::client::{
    check_compatibility, run_heartbeat_daemon, send_bot_inbound, send_terminal_heartbeat,
    BackoffConfig, HeartbeatDaemonConfig, ShutdownSignal, DAEMON_VERSION, ENV_BOT_TOKEN,
    ENV_TERMINAL_TOKEN, PROTOCOL_VERSION,
};
#[cfg(unix)]
use paperwork_bot_runtime::control_sock::{
    default_control_socket_dir, default_control_socket_path, ensure_and_validate_socket_dir,
    send_control_command, ControlCommand,
};
#[cfg(unix)]
use paperwork_bot_runtime::executor::supervisor_self_test;
use paperwork_bot_runtime::governance::{evaluate_policy, PolicyEvalRequest};
use paperwork_bot_runtime::token::{redact_secrets, validate_token_prefix, verify_token_sha256};
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::path::PathBuf;
use std::process;
use std::time::Duration;

fn read_stdin_to_string() -> Result<String, String> {
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(buf)
}

fn find_flag(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn require_flag(args: &[String], name: &str) -> Result<String, String> {
    find_flag(args, name).ok_or_else(|| format!("missing required flag {name}"))
}

fn cmd_eval_policy() -> Result<Value, String> {
    let raw = read_stdin_to_string()?;
    let req: PolicyEvalRequest = serde_json::from_str(raw.trim())
        .map_err(|e| format!("invalid policy request JSON: {e}"))?;
    let decision = evaluate_policy(&req);
    serde_json::to_value(decision).map_err(|e| format!("failed to serialize decision: {e}"))
}

fn cmd_verify_token(args: &[String]) -> Result<Value, String> {
    if args.iter().any(|a| a == "--token" || a.starts_with("pcp_")) {
        return Err(
            "raw tokens must never be passed as CLI arguments; supply via env var or stdin"
                .to_string(),
        );
    }
    let expected = require_flag(args, "--expected-sha256")?;

    let raw_token = env::var("PAPERWORK_TOKEN")
        .or_else(|_| env::var(ENV_TERMINAL_TOKEN))
        .or_else(|_| env::var(ENV_BOT_TOKEN))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| {
            read_stdin_to_string()
                .unwrap_or_default()
                .trim()
                .to_string()
        });

    if raw_token.is_empty() {
        return Err(
            "no token provided via PAPERWORK_TOKEN/PAPERWORK_TERMINAL_TOKEN/PAPERWORK_BOT_TOKEN or stdin"
                .to_string(),
        );
    }

    let valid = verify_token_sha256(&raw_token, &expected);
    let token_kind = validate_token_prefix(&raw_token);
    Ok(json!({
        "valid": valid,
        "token_kind": token_kind,
    }))
}

fn cmd_heartbeat(args: &[String]) -> Result<Value, String> {
    let server = require_flag(args, "--server")?;
    let terminal_id = require_flag(args, "--terminal-id")?;
    let status = find_flag(args, "--status").unwrap_or_else(|| "online".to_string());
    let hostname = find_flag(args, "--hostname");
    let timeout_secs: u64 = find_flag(args, "--timeout-secs")
        .as_deref()
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| "invalid --timeout-secs".to_string())
        })
        .transpose()?
        .unwrap_or(10);

    let payload = json!({
        "status": status,
        "hostname": hostname,
    });

    let resp = send_terminal_heartbeat(
        &server,
        &terminal_id,
        &payload,
        Duration::from_secs(timeout_secs),
    )
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": resp.is_success(),
        "status": resp.status,
        "body": redact_secrets(&resp.body),
    }))
}

fn cmd_daemon(args: &[String]) -> Result<Value, String> {
    let server = require_flag(args, "--server")?;
    let terminal_id = require_flag(args, "--terminal-id")?;
    let interval_secs: u64 = find_flag(args, "--interval-secs")
        .as_deref()
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| "invalid --interval-secs".to_string())
        })
        .transpose()?
        .unwrap_or(15);
    let max_iterations: Option<usize> = find_flag(args, "--max-iterations")
        .as_deref()
        .map(|s| {
            s.parse::<usize>()
                .map_err(|_| "invalid --max-iterations".to_string())
        })
        .transpose()?;
    let state_path = find_flag(args, "--state-file").map(PathBuf::from);
    let control_socket_path = find_flag(args, "--socket").map(PathBuf::from);
    let skip_compat = args.iter().any(|a| a == "--skip-compatibility");

    let cfg = HeartbeatDaemonConfig {
        base_url: server,
        terminal_id,
        payload: json!({ "status": "online" }),
        interval: Duration::from_secs(interval_secs.max(1)),
        timeout: Duration::from_secs(10),
        backoff: BackoffConfig::default(),
        max_iterations,
        state_path,
        control_socket_path,
        check_compatibility_on_start: !skip_compat,
    };

    let shutdown = ShutdownSignal::new();
    let summary = run_heartbeat_daemon(&cfg, &shutdown).map_err(|e| e.to_string())?;
    serde_json::to_value(summary).map_err(|e| format!("failed to serialize summary: {e}"))
}

fn cmd_inbound(args: &[String]) -> Result<Value, String> {
    let server = require_flag(args, "--server")?;
    let bot_id = require_flag(args, "--bot-id")?;
    let timeout_secs: u64 = find_flag(args, "--timeout-secs")
        .as_deref()
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| "invalid --timeout-secs".to_string())
        })
        .transpose()?
        .unwrap_or(15);

    let raw = read_stdin_to_string()?;
    let payload: Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("invalid inbound JSON: {e}"))?;

    let resp = send_bot_inbound(
        &server,
        &bot_id,
        &payload,
        Duration::from_secs(timeout_secs),
    )
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": resp.is_success(),
        "status": resp.status,
        "body": redact_secrets(&resp.body),
    }))
}

#[cfg(unix)]
fn cmd_ctl(args: &[String]) -> Result<Value, String> {
    let Some(action_raw) = args.first() else {
        return Err(
            "usage: paperwork-bot ctl <status|drain|shutdown> [--socket <path>] [--terminal-id <id>]"
                .to_string(),
        );
    };
    let command = ControlCommand::parse(action_raw).map_err(|e| e.to_string())?;
    let rest = &args[1..];
    let timeout_secs: u64 = find_flag(rest, "--timeout-secs")
        .as_deref()
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| "invalid --timeout-secs".to_string())
        })
        .transpose()?
        .unwrap_or(5);

    let socket_path = if let Some(p) = find_flag(rest, "--socket") {
        PathBuf::from(p)
    } else if let Some(tid) = find_flag(rest, "--terminal-id") {
        default_control_socket_path(&tid).map_err(|e| e.to_string())?
    } else {
        return Err("ctl requires either --socket <path> or --terminal-id <id>".to_string());
    };

    let resp = send_control_command(&socket_path, command, Duration::from_secs(timeout_secs))
        .map_err(|e| e.to_string())?;
    serde_json::to_value(resp).map_err(|e| format!("failed to serialize ctl response: {e}"))
}

#[cfg(not(unix))]
fn cmd_ctl(_args: &[String]) -> Result<Value, String> {
    Err("ctl UDS control plane is only supported on Unix platforms".to_string())
}

fn cmd_doctor(args: &[String]) -> Result<Value, String> {
    let server = find_flag(args, "--server");
    let terminal_id = find_flag(args, "--terminal-id").unwrap_or_else(|| "doctor-check".into());
    let socket_dir_flag = find_flag(args, "--socket-dir").map(PathBuf::from);
    let timeout_secs: u64 = find_flag(args, "--timeout-secs")
        .as_deref()
        .map(|s| {
            s.parse::<u64>()
                .map_err(|_| "invalid --timeout-secs".to_string())
        })
        .transpose()?
        .unwrap_or(5);

    // 1. Token env presence & prefix check (NEVER prints raw token)
    let raw_token = env::var(ENV_TERMINAL_TOKEN)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let token_kind = raw_token.as_deref().and_then(validate_token_prefix);
    let token_ok = raw_token.is_some() && token_kind.is_some();
    let token_check = json!({
        "ok": token_ok,
        "envVar": ENV_TERMINAL_TOKEN,
        "present": raw_token.is_some(),
        "tokenKind": token_kind,
    });

    // 2. UDS dir 0700 validation
    #[cfg(unix)]
    let (uds_ok, uds_check) = {
        let dir_res = match socket_dir_flag {
            Some(d) => Ok(d),
            None => default_control_socket_dir(&terminal_id),
        };
        match dir_res.and_then(|d| ensure_and_validate_socket_dir(&d)) {
            Ok(canonical) => (
                true,
                json!({
                    "ok": true,
                    "dir": canonical.to_string_lossy(),
                    "mode": "0700",
                }),
            ),
            Err(e) => (
                false,
                json!({
                    "ok": false,
                    "error": redact_secrets(&e.to_string()),
                }),
            ),
        }
    };
    #[cfg(not(unix))]
    let (uds_ok, uds_check) = (false, json!({ "ok": false, "error": "unix required" }));

    // 3. /api/enterprise-bots/compatibility reachability
    let (compat_ok, compat_check) = match server.as_deref() {
        Some(url) => {
            match check_compatibility(url, raw_token.as_deref(), Duration::from_secs(timeout_secs))
            {
                Ok(res) => (
                    res.reachable,
                    json!({
                        "ok": res.reachable,
                        "status": res.status,
                        "protocolVersion": res.protocol_version,
                        "daemonVersion": res.daemon_version,
                    }),
                ),
                Err(e) => (
                    false,
                    json!({
                        "ok": false,
                        "error": e.to_string(),
                    }),
                ),
            }
        }
        None => (
            true,
            json!({
                "ok": true,
                "skipped": true,
                "reason": "no --server flag provided",
            }),
        ),
    };

    // 4. process-supervisor self-test
    #[cfg(unix)]
    let (sup_ok, sup_check) = match supervisor_self_test() {
        Ok(()) => (true, json!({ "ok": true })),
        Err(e) => (
            false,
            json!({
                "ok": false,
                "error": redact_secrets(&e.to_string()),
            }),
        ),
    };
    #[cfg(not(unix))]
    let (sup_ok, sup_check) = (false, json!({ "ok": false, "error": "unix required" }));

    Ok(json!({
        "ok": token_ok && uds_ok && compat_ok && sup_ok,
        "daemonVersion": DAEMON_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "checks": {
            "tokenEnv": token_check,
            "controlSocketDir": uds_check,
            "compatibility": compat_check,
            "processSupervisor": sup_check,
        }
    }))
}

fn usage() -> &'static str {
    "usage: paperwork-bot <eval-policy|verify-token|heartbeat|daemon|inbound|ctl|doctor> [flags]"
}

fn run(args: &[String]) -> Result<Value, String> {
    let Some(cmd) = args.first().map(String::as_str) else {
        return Err(usage().to_string());
    };
    let rest = &args[1..];
    match cmd {
        "eval-policy" => cmd_eval_policy(),
        "verify-token" => cmd_verify_token(rest),
        "heartbeat" => cmd_heartbeat(rest),
        "daemon" => cmd_daemon(rest),
        "inbound" => cmd_inbound(rest),
        "ctl" => cmd_ctl(rest),
        "doctor" => cmd_doctor(rest),
        "-h" | "--help" | "help" => Ok(json!({ "usage": usage() })),
        other => Err(format!("unknown subcommand {other:?}; {}", usage())),
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            let safe = redact_secrets(&e);
            eprintln!("{}", json!({ "error": safe }));
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_token_rejects_cli_token_argument() {
        let args = vec![
            "--expected-sha256".to_string(),
            "0".repeat(64),
            "--token".to_string(),
            "pcp_term_should_fail".to_string(),
        ];
        let err = cmd_verify_token(&args).unwrap_err();
        assert!(err.contains("never be passed as CLI arguments"));
    }

    #[test]
    fn help_and_unknown_subcommand_work() {
        let help = run(&["--help".to_string()]).unwrap();
        let usage_str = help["usage"].as_str().unwrap();
        assert!(usage_str.contains("paperwork-bot"));
        assert!(usage_str.contains("ctl"));
        assert!(usage_str.contains("doctor"));
        assert!(run(&["unknown-cmd".to_string()]).is_err());
    }

    #[test]
    fn doctor_outputs_structured_json_without_leaking_tokens() {
        let dir = env::temp_dir().join(format!("pwork-doc-test-{}", process::id()));
        let res = run(&[
            "doctor".to_string(),
            "--socket-dir".to_string(),
            dir.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert!(res["checks"]["processSupervisor"]["ok"].as_bool().unwrap());
        assert!(res["checks"]["controlSocketDir"]["ok"].as_bool().unwrap());
        assert!(res["checks"]["compatibility"]["skipped"].as_bool().unwrap());
        let serialized = res.to_string();
        assert!(!serialized.contains("pcp_term_"));
        assert!(!serialized.contains("pcp_bot_"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

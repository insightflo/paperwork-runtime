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
//! - `daemon --server <url> --terminal-id <id> [--interval-secs <n>] [--max-iterations <n>]`:
//!   Runs a terminal heartbeat daemon loop using `PAPERWORK_TERMINAL_TOKEN`.
//! - `inbound --server <url> --bot-id <id>`:
//!   Reads a JSON payload from stdin and posts it to the bot inbound endpoint using `PAPERWORK_BOT_TOKEN`.

use paperwork_bot_runtime::client::{
    run_heartbeat_daemon, send_bot_inbound, send_terminal_heartbeat, BackoffConfig,
    HeartbeatDaemonConfig, ShutdownSignal, ENV_BOT_TOKEN, ENV_TERMINAL_TOKEN,
};
use paperwork_bot_runtime::governance::{evaluate_policy, PolicyEvalRequest};
use paperwork_bot_runtime::token::{redact_secrets, validate_token_prefix, verify_token_sha256};
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
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
    args.windows(2)
        .find(|w| w[0] == name)
        .map(|w| w[1].clone())
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
        .unwrap_or_else(|| read_stdin_to_string().unwrap_or_default().trim().to_string());

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
        .map(|s| s.parse::<u64>().map_err(|_| "invalid --timeout-secs".to_string()))
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
        .map(|s| s.parse::<u64>().map_err(|_| "invalid --interval-secs".to_string()))
        .transpose()?
        .unwrap_or(15);
    let max_iterations: Option<usize> = find_flag(args, "--max-iterations")
        .as_deref()
        .map(|s| s.parse::<usize>().map_err(|_| "invalid --max-iterations".to_string()))
        .transpose()?;

    let cfg = HeartbeatDaemonConfig {
        base_url: server,
        terminal_id,
        payload: json!({ "status": "online" }),
        interval: Duration::from_secs(interval_secs.max(1)),
        timeout: Duration::from_secs(10),
        backoff: BackoffConfig::default(),
        max_iterations,
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
        .map(|s| s.parse::<u64>().map_err(|_| "invalid --timeout-secs".to_string()))
        .transpose()?
        .unwrap_or(15);

    let raw = read_stdin_to_string()?;
    let payload: Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("invalid inbound JSON: {e}"))?;

    let resp = send_bot_inbound(&server, &bot_id, &payload, Duration::from_secs(timeout_secs))
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": resp.is_success(),
        "status": resp.status,
        "body": redact_secrets(&resp.body),
    }))
}

fn usage() -> &'static str {
    "usage: paperwork-bot <eval-policy|verify-token|heartbeat|daemon|inbound> [flags]"
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
        assert!(help["usage"].as_str().unwrap().contains("paperwork-bot"));
        assert!(run(&["unknown-cmd".to_string()]).is_err());
    }
}

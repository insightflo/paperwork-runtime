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
//! - `init --server <url> --name <endpoint> [--folder <path>...] [--config <path>]`:
//!   Validates the server URL, writes the `0600` endpoint config JSON, and prints a JSON summary.
//! - `detect-clis`: Prints a JSON array of detected local AI-coding CLIs on the process `PATH`.
//! - `endpoint-doctor [--config <path>] [--json]`: Checks local endpoint readiness;
//!   defaults to `~/.paperwork/endpoint.json`, prints a human summary unless `--json`,
//!   and exits 0 when ready or 1 otherwise. The outbox is next to the config, in `outbox/`.
//! - `endpoint-scan --folder <path> [--max-files <n>] [--max-depth <n>]`:
//!   Prints a sorted workspace snapshot as JSON, using the default watch limits unless overridden.
//! - `endpoint-audit --log <path> [--limit <n>]`:
//!   Prints the latest redacted audit entries as a JSON array (default 20, oldest first).
//! - `render-service --os <macos|linux|windows> --server <url> --name <endpoint> [--binary <path>] [--config <path>]`:
//!   Renders the OS service unit (LaunchAgent plist / systemd user unit / Windows scheduled-task
//!   script) as raw text on stdout for direct redirection into the service file.

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
use paperwork_bot_runtime::endpoint_audit::{redact_sensitive, AuditLogger};
use paperwork_bot_runtime::endpoint_doctor::{run_endpoint_doctor, DoctorInput, DoctorReport};
use paperwork_bot_runtime::endpoint_watch::{scan_workspace, WatchLimits};
#[cfg(unix)]
use paperwork_bot_runtime::executor::supervisor_self_test;
use paperwork_bot_runtime::governance::{evaluate_policy, PolicyEvalRequest};
use paperwork_bot_runtime::local_tools::detect_local_clis;
use paperwork_bot_runtime::service_install::{
    render_linux_systemd_user_unit, render_macos_launch_agent_plist, render_windows_task_script,
    validate_server_url, write_endpoint_config, EndpointInitConfig,
};
use paperwork_bot_runtime::token::{redact_secrets, validate_token_prefix, verify_token_sha256};
use serde_json::{json, Value};
use std::collections::HashMap;
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

/// Collects every value of a repeatable flag (`--folder a --folder b` -> `["a", "b"]`).
fn collect_flags(args: &[String], name: &str) -> Vec<String> {
    args.windows(2)
        .filter(|w| w[0] == name)
        .map(|w| w[1].clone())
        .collect()
}

/// Default endpoint config location under the user home (`$HOME` / `$USERPROFILE`).
fn default_endpoint_config_path() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .ok_or_else(|| "cannot determine home directory; pass --config <path>".to_string())?;
    Ok(PathBuf::from(home)
        .join(".paperwork")
        .join("endpoint.json"))
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

fn cmd_detect_clis() -> Result<Value, String> {
    let detected = detect_local_clis()
        .into_iter()
        .map(|cli| {
            json!({
                "id": cli.id,
                "binary": cli.binary,
                "available": cli.available,
                "path": cli.path.map(|p| p.to_string_lossy().into_owned()),
            })
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(detected))
}

/// Strict value-taking options for the local inspection commands only.
fn parse_endpoint_flags<'a>(
    args: &'a [String],
    allowed: &[&str],
) -> Result<HashMap<&'a str, &'a str>, String> {
    let mut flags = HashMap::new();
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        if !allowed.contains(&flag.as_str()) || flags.contains_key(flag.as_str()) {
            return Err(format!("unknown or repeated flag {flag:?}"));
        }
        let value = args.next()
            .filter(|v| !v.is_empty() && !v.starts_with("--"))
            .ok_or_else(|| format!("{flag} requires a value"))?;
        flags.insert(flag.as_str(), value.as_str());
    }
    Ok(flags)
}

fn endpoint_limit(flags: &HashMap<&str, &str>, name: &str, default: usize) -> Result<usize, String> {
    flags.get(name).map_or(Ok(default), |value| {
        value.parse().map_err(|_| format!("invalid {name}; expected a non-negative integer"))
    })
}

fn cmd_endpoint_scan(args: &[String]) -> Result<Value, String> {
    let flags = parse_endpoint_flags(args, &["--folder", "--max-files", "--max-depth"])?;
    let folder = flags.get("--folder").ok_or("missing required flag --folder")?;
    let defaults = WatchLimits::default();
    let limits = WatchLimits {
        max_files: endpoint_limit(&flags, "--max-files", defaults.max_files)?,
        max_depth: endpoint_limit(&flags, "--max-depth", defaults.max_depth)?,
        ..defaults
    };
    let snapshot = scan_workspace(std::path::Path::new(folder), &limits)?;
    serde_json::to_value(snapshot).map_err(|e| format!("failed to serialize snapshot: {e}"))
}

fn cmd_endpoint_audit(args: &[String]) -> Result<Value, String> {
    let flags = parse_endpoint_flags(args, &["--log", "--limit"])?;
    let log = flags.get("--log").ok_or("missing required flag --log")?;
    let limit = endpoint_limit(&flags, "--limit", 20)?;
    let mut entries = AuditLogger::new(PathBuf::from(log), u64::MAX).read_recent(limit)?;
    // Also mask summaries from logs populated outside AuditLogger::append.
    for entry in &mut entries {
        entry.summary = redact_sensitive(&entry.summary);
    }
    serde_json::to_value(entries).map_err(|e| format!("failed to serialize audit entries: {e}"))
}

fn cmd_endpoint_doctor(args: &[String]) -> Result<DoctorReport, String> {
    #[derive(serde::Deserialize)]
    struct Config {
        server_url: String,
        endpoint_name: String,
        allowed_folders: Vec<String>,
    }
    let mut config_path = None;
    let mut flags = args.iter();
    while let Some(flag) = flags.next() {
        match flag.as_str() {
            "--json" => {}
            "--config" if config_path.is_none() => {
                let path = flags.next()
                    .filter(|p| !p.is_empty() && !p.starts_with("--"))
                    .ok_or("--config requires a path")?;
                config_path = Some(PathBuf::from(path));
            }
            _ => return Err(format!("invalid endpoint-doctor flag {flag:?}")),
        }
    }
    let config_path = config_path.map(Ok).unwrap_or_else(default_endpoint_config_path)?;
    let bytes = std::fs::read(&config_path).map_err(|e| format!("read endpoint config: {e}"))?;
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|e| format!("invalid endpoint config: {e}"))?;
    if config.endpoint_name.trim().is_empty() {
        return Err("endpoint name must not be empty".into());
    }
    let outbox_dir = config_path.parent()
        .unwrap_or(std::path::Path::new(".")).join("outbox");
    let detected_clis = detect_local_clis().into_iter()
        .filter(|cli| cli.available).map(|cli| cli.id.to_string()).collect();
    Ok(run_endpoint_doctor(&DoctorInput {
        server_url: config.server_url,
        config_path,
        // The installer stores plain paths without grant modes; check directory access only.
        allowed_folders: config.allowed_folders.into_iter()
            .map(|p| (p.into(), "ro".into())).collect(),
        outbox_dir,
        detected_clis,
    }))
}

fn cmd_init(args: &[String]) -> Result<Value, String> {
    let server = validate_server_url(&require_flag(args, "--server")?)?;
    let name = require_flag(args, "--name")?;
    if name.trim().is_empty() {
        return Err("endpoint name must not be empty".to_string());
    }
    let config_path = match find_flag(args, "--config") {
        Some(p) => PathBuf::from(p),
        None => default_endpoint_config_path()?,
    };
    let folders = collect_flags(args, "--folder");
    write_endpoint_config(&config_path, &server, &name, &folders)?;
    Ok(json!({
        "ok": true,
        "configPath": config_path.to_string_lossy().into_owned(),
        "serverUrl": server,
        "endpointName": name,
        "allowedFolders": folders,
    }))
}

/// Renders the requested OS service unit as raw text (streamed to stdout, not JSON).
fn cmd_render_service(args: &[String]) -> Result<String, String> {
    let os = require_flag(args, "--os")?;
    let server = validate_server_url(&require_flag(args, "--server")?)?;
    let name = require_flag(args, "--name")?;
    if name.trim().is_empty() {
        return Err("endpoint name must not be empty".to_string());
    }
    let binary_path = match find_flag(args, "--binary") {
        Some(p) => PathBuf::from(p),
        None => env::current_exe()
            .map_err(|e| format!("cannot determine binary path; pass --binary: {e}"))?,
    };
    let config_path = match find_flag(args, "--config") {
        Some(p) => PathBuf::from(p),
        None => default_endpoint_config_path()?,
    };
    let cfg = EndpointInitConfig {
        server_url: server,
        endpoint_name: name,
        binary_path,
        config_path,
        allowed_folders: Vec::new(),
    };
    Ok(match os.as_str() {
        "macos" => render_macos_launch_agent_plist(&cfg),
        "linux" => render_linux_systemd_user_unit(&cfg),
        "windows" => render_windows_task_script(&cfg),
        other => {
            return Err(format!(
                "invalid --os {other:?}; expected macos|linux|windows"
            ))
        }
    })
}

fn usage() -> &'static str {
    "usage: paperwork-bot <eval-policy|verify-token|heartbeat|daemon|inbound|ctl|doctor|init|detect-clis|render-service|endpoint-doctor|endpoint-scan|endpoint-audit> [flags]"
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
        "init" => cmd_init(rest),
        "detect-clis" => cmd_detect_clis(),
        "endpoint-scan" => cmd_endpoint_scan(rest),
        "endpoint-audit" => cmd_endpoint_audit(rest),
        "-h" | "--help" | "help" => Ok(json!({ "usage": usage() })),
        other => Err(format!("unknown subcommand {other:?}; {}", usage())),
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("endpoint-doctor") {
        match cmd_endpoint_doctor(&args[1..]) {
            Ok(report) => {
                if args[1..].iter().any(|a| a == "--json") {
                    println!("{}", serde_json::to_string(&report).expect("serialize doctor report"));
                } else {
                    print!("{}", report.format_human());
                }
                process::exit(if report.ready { 0 } else { 1 });
            }
            Err(e) => {
                eprintln!("{}", json!({ "error": redact_secrets(&e) }));
                process::exit(1);
            }
        }
    }
    // `render-service` streams the raw OS unit text to stdout (for shell redirection into the
    // service file); remaining subcommands print a single JSON value.
    if args.first().map(String::as_str) == Some("render-service") {
        match cmd_render_service(&args[1..]) {
            Ok(text) => print!("{text}"),
            Err(e) => {
                eprintln!("{}", json!({ "error": redact_secrets(&e) }));
                process::exit(1);
            }
        }
        return;
    }
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

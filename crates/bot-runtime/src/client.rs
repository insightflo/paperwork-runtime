//! Lightweight stdlib HTTP/1.1 client and daemon loop helpers for Paperwork control plane.
//!
//! Security invariant:
//! - Terminal tokens are read ONLY from `PAPERWORK_TERMINAL_TOKEN`.
//! - Bot tokens are read ONLY from `PAPERWORK_BOT_TOKEN`.
//! - Tokens are never accepted as CLI arguments and all error strings are redacted.

#[cfg(unix)]
use crate::control_sock::{ControlSocketServer, DaemonTelemetry};
use crate::state::{load_state, now_unix_secs, save_state_atomic, PersistedDaemonState};
use crate::token::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::fmt;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const ENV_TERMINAL_TOKEN: &str = "PAPERWORK_TERMINAL_TOKEN";
pub const ENV_BOT_TOKEN: &str = "PAPERWORK_BOT_TOKEN";
/// Opt-in that lifts the loopback-only restriction for plain `http://` server URLs.
/// Only the exact value `1` counts; any other value (or unset) keeps the restriction.
pub const ENV_ALLOW_REMOTE_HTTP: &str = "PAPERWORK_BOT_ALLOW_REMOTE_HTTP";
pub const PROTOCOL_VERSION: &str = "1.0";
/// Integer sent on the wire: the server's strict telemetry schema requires `protocolVersion`
/// to be an integer (1..=100), not the dotted string used for local display/state.
pub const PROTOCOL_VERSION_MAJOR: u64 = 1;
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMPATIBILITY_PATH: &str = "/api/enterprise-bots/compatibility";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub message: String,
}

impl ClientError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: redact_secrets(&msg.into()),
        }
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ClientError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityResult {
    pub reachable: bool,
    pub status: u16,
    pub protocol_version: String,
    pub daemon_version: String,
    pub body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffConfig {
    pub initial_ms: u64,
    pub max_ms: u64,
    pub multiplier: u32,
    /// Bounded symmetric jitter percentage (0..=50). 0 disables jitter.
    pub jitter_percent: u8,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            initial_ms: 1_000,
            max_ms: 30_000,
            multiplier: 2,
            jitter_percent: 20,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BackoffState {
    config: BackoffConfig,
    current_ms: u64,
    attempts: u32,
}

impl BackoffState {
    pub fn new(config: BackoffConfig) -> Self {
        let initial = config.initial_ms.max(1);
        let max_ms = config.max_ms.max(initial);
        Self {
            config: BackoffConfig {
                initial_ms: initial,
                max_ms,
                multiplier: config.multiplier.max(1),
                jitter_percent: config.jitter_percent.min(50),
            },
            current_ms: initial,
            attempts: 0,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
            ^ u64::from(std::process::id()).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ u64::from(self.attempts).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        self.next_delay_with_seed(seed)
    }

    /// Deterministic jittered exponential backoff step for testing and reproducible scheduling.
    pub fn next_delay_with_seed(&mut self, seed: u64) -> Duration {
        let base_ms = self.current_ms;
        self.attempts = self.attempts.saturating_add(1);
        self.current_ms = self
            .current_ms
            .saturating_mul(u64::from(self.config.multiplier))
            .min(self.config.max_ms);

        let delay_ms = if self.config.jitter_percent == 0 {
            base_ms
        } else {
            let max_delta = base_ms.saturating_mul(u64::from(self.config.jitter_percent)) / 100;
            if max_delta == 0 {
                base_ms
            } else {
                // SplitMix64 mixing step for uniform-ish zero-dependency jitter.
                let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                let span = max_delta.saturating_mul(2).saturating_add(1);
                let offset = z % span;
                base_ms
                    .saturating_sub(max_delta)
                    .saturating_add(offset)
                    .clamp(1, self.config.max_ms)
            }
        };

        Duration::from_millis(delay_ms)
    }

    pub fn reset(&mut self) {
        self.current_ms = self.config.initial_ms;
        self.attempts = 0;
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

/// Cooperative shutdown signal for heartbeat daemon loops.
#[derive(Debug, Clone, Default)]
pub struct ShutdownSignal {
    flag: Arc<AtomicBool>,
}

impl ShutdownSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Sleeps for `duration`, waking early if shutdown is triggered.
    /// Returns `true` if shutdown was triggered during the wait.
    pub fn wait_or_sleep(&self, duration: Duration) -> bool {
        let start = Instant::now();
        let slice = Duration::from_millis(50);
        while !self.is_triggered() {
            let elapsed = start.elapsed();
            if elapsed >= duration {
                return false;
            }
            let remaining = duration - elapsed;
            thread::sleep(remaining.min(slice));
        }
        true
    }
}

fn validate_path_segment(label: &str, segment: &str) -> Result<(), ClientError> {
    let trimmed = segment.trim();
    if trimmed.is_empty()
        || trimmed != segment
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('?')
        || trimmed.contains('#')
        || trimmed
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(ClientError::new(format!(
            "invalid {label}: must be a single safe URL path segment"
        )));
    }
    Ok(())
}

pub fn terminal_heartbeat_path(terminal_id: &str) -> Result<String, ClientError> {
    validate_path_segment("terminal_id", terminal_id)?;
    Ok(format!(
        "/api/enterprise-bots/terminals/{terminal_id}/heartbeat"
    ))
}

pub fn bot_inbound_path(bot_id: &str) -> Result<String, ClientError> {
    validate_path_segment("bot_id", bot_id)?;
    Ok(format!("/api/enterprise-bots/bots/{bot_id}/inbound"))
}

#[derive(Debug)]
struct ParsedHttpUrl {
    host: String,
    port: u16,
    base_path: String,
}

/// Hosts that plain `http://` may target without the remote-HTTP opt-in.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// True when `host` is a loopback name/literal (`localhost`, `127.0.0.1`, `::1`),
/// compared case-insensitively. IPv6 hosts must be passed without brackets.
fn is_loopback_host(host: &str) -> bool {
    LOOPBACK_HOSTS
        .iter()
        .any(|loopback| loopback.eq_ignore_ascii_case(host))
}

/// Reads the remote plain-HTTP opt-in from the process environment.
fn remote_plain_http_allowed() -> bool {
    env::var(ENV_ALLOW_REMOTE_HTTP)
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

fn parse_http_url(base_url: &str) -> Result<ParsedHttpUrl, ClientError> {
    parse_http_url_with_policy(base_url, remote_plain_http_allowed())
}

/// Parses a plain `http://` server URL. Non-loopback hosts are rejected unless
/// `allow_remote_http` is true; the policy is a parameter so tests do not race on
/// the process environment.
fn parse_http_url_with_policy(
    base_url: &str,
    allow_remote_http: bool,
) -> Result<ParsedHttpUrl, ClientError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.starts_with("https://") {
        return Err(ClientError::new(
            "https:// is not supported by the zero-dependency stdlib client; route through localhost/http proxy",
        ));
    }
    let rest = trimmed
        .strip_prefix("http://")
        .ok_or_else(|| ClientError::new("server URL must start with http://"))?;

    let (authority, base_path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], rest[idx..].to_string()),
        None => (rest, String::new()),
    };

    if authority.is_empty() {
        return Err(ClientError::new("server URL is missing host"));
    }

    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped
            .find(']')
            .ok_or_else(|| ClientError::new("malformed IPv6 host in server URL"))?;
        let host = stripped[..end].to_string();
        let after = &stripped[end + 1..];
        let port = if let Some(p) = after.strip_prefix(':') {
            p.parse::<u16>()
                .map_err(|_| ClientError::new("invalid port in server URL"))?
        } else if after.is_empty() {
            80
        } else {
            return Err(ClientError::new("malformed authority in server URL"));
        };
        (host, port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        let port = p
            .parse::<u16>()
            .map_err(|_| ClientError::new("invalid port in server URL"))?;
        (h.to_string(), port)
    } else {
        (authority.to_string(), 80)
    };

    if host.is_empty() {
        return Err(ClientError::new("server URL host is empty"));
    }

    if !is_loopback_host(&host) && !allow_remote_http {
        return Err(ClientError::new(format!(
            "refusing plain http:// to non-loopback host '{host}'; route through a localhost/http proxy or set {ENV_ALLOW_REMOTE_HTTP}=1 to opt in"
        )));
    }

    Ok(ParsedHttpUrl {
        host,
        port,
        base_path,
    })
}

fn connect_http(parsed: &ParsedHttpUrl, timeout: Duration) -> Result<TcpStream, ClientError> {
    let addr = (parsed.host.as_str(), parsed.port)
        .to_socket_addrs()
        .map_err(|e| ClientError::new(format!("DNS resolution failed: {e}")))?
        .next()
        .ok_or_else(|| ClientError::new("could not resolve server address"))?;

    let stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| ClientError::new(format!("TCP connect failed: {e}")))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    Ok(stream)
}

fn format_host_header(parsed: &ParsedHttpUrl) -> String {
    if parsed.port == 80 {
        parsed.host.clone()
    } else {
        format!("{}:{}", parsed.host, parsed.port)
    }
}

/// Performs a synchronous HTTP/1.1 GET with optional Bearer token.
pub fn http_get_json(
    base_url: &str,
    path: &str,
    bearer_token: Option<&str>,
    timeout: Duration,
) -> Result<HttpResponse, ClientError> {
    let parsed = parse_http_url(base_url)?;
    let full_path = format!("{}{}", parsed.base_path, path);
    let mut stream = connect_http(&parsed, timeout)?;
    let host_header = format_host_header(&parsed);

    let auth_header = match bearer_token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tok) => format!("Authorization: Bearer {tok}\r\n"),
        None => String::new(),
    };

    let request_buf = format!(
        "GET {full_path} HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\n{auth_header}Connection: close\r\n\r\n"
    )
    .into_bytes();

    stream
        .write_all(&request_buf)
        .and_then(|_| stream.flush())
        .map_err(|e| ClientError::new(format!("HTTP write failed: {e}")))?;

    let mut raw_response = Vec::new();
    stream
        .read_to_end(&mut raw_response)
        .map_err(|e| ClientError::new(format!("HTTP read failed: {e}")))?;

    parse_http_response(&raw_response)
}

/// Performs a synchronous HTTP/1.1 POST with JSON body and Bearer token.
pub fn http_post_json(
    base_url: &str,
    path: &str,
    bearer_token: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<HttpResponse, ClientError> {
    if bearer_token.trim().is_empty() {
        return Err(ClientError::new("bearer token must be non-empty"));
    }
    let parsed = parse_http_url(base_url)?;
    let full_path = format!("{}{}", parsed.base_path, path);
    let body_bytes = serde_json::to_vec(payload)
        .map_err(|e| ClientError::new(format!("failed to serialize JSON payload: {e}")))?;

    let mut stream = connect_http(&parsed, timeout)?;
    let host_header = format_host_header(&parsed);

    let mut request_buf = format!(
        "POST {full_path} HTTP/1.1\r\nHost: {host_header}\r\nContent-Type: application/json\r\nAccept: application/json\r\nAuthorization: Bearer {bearer_token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    )
    .into_bytes();
    request_buf.extend_from_slice(&body_bytes);

    stream
        .write_all(&request_buf)
        .and_then(|_| stream.flush())
        .map_err(|e| ClientError::new(format!("HTTP write failed: {e}")))?;

    let mut raw_response = Vec::new();
    stream
        .read_to_end(&mut raw_response)
        .map_err(|e| ClientError::new(format!("HTTP read failed: {e}")))?;

    parse_http_response(&raw_response)
}

fn parse_http_response(raw: &[u8]) -> Result<HttpResponse, ClientError> {
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| ClientError::new("malformed HTTP response: missing header terminator"))?;

    let header_str = std::str::from_utf8(&raw[..sep])
        .map_err(|_| ClientError::new("malformed HTTP response headers"))?;
    let status_line = header_str
        .lines()
        .next()
        .ok_or_else(|| ClientError::new("empty HTTP status line"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| ClientError::new("invalid HTTP status code"))?;

    let body = String::from_utf8_lossy(&raw[sep + 4..]).into_owned();
    Ok(HttpResponse { status, body })
}

fn read_env_token(var_name: &str) -> Result<String, ClientError> {
    let val = env::var(var_name).map_err(|_| {
        ClientError::new(format!("missing required environment variable {var_name}"))
    })?;
    let trimmed = val.trim().to_string();
    if trimmed.is_empty() {
        return Err(ClientError::new(format!(
            "environment variable {var_name} is empty"
        )));
    }
    Ok(trimmed)
}

/// Calls `GET /api/enterprise-bots/compatibility` to perform the daemon compatibility handshake.
pub fn check_compatibility(
    base_url: &str,
    bearer_token: Option<&str>,
    timeout: Duration,
) -> Result<CompatibilityResult, ClientError> {
    let resp = http_get_json(base_url, COMPATIBILITY_PATH, bearer_token, timeout)?;
    let parsed_body = serde_json::from_str::<Value>(&resp.body)
        .unwrap_or_else(|_| Value::String(redact_secrets(&resp.body)));
    Ok(CompatibilityResult {
        reachable: resp.is_success(),
        status: resp.status,
        protocol_version: PROTOCOL_VERSION.to_string(),
        daemon_version: DAEMON_VERSION.to_string(),
        body: parsed_body,
    })
}

/// Telemetry keys accepted by the server's strict `terminalTelemetrySchema`
/// (`server/src/routes/enterprise-bots.ts`). Both the body and the telemetry object are
/// `.strict()`, so any other key (e.g. the CLI's `status`/`hostname`) is dropped here instead
/// of being sent and rejected with HTTP 400.
const TELEMETRY_KEYS: [&str; 9] = [
    "os",
    "arch",
    "daemonVersion",
    "protocolVersion",
    "uptimeSecs",
    "cpuPct",
    "memRssMb",
    "activeChildren",
    "lastRttMs",
];

/// Builds the heartbeat body `{"telemetry": {...}}` for
/// `POST /api/enterprise-bots/terminals/:id/heartbeat`.
///
/// Only schema-known keys are forwarded from `base_payload`; runtime-collected fields always
/// win. `lastRttMs` is omitted (not `null`) until the first successful heartbeat because the
/// schema declares it as an optional number.
pub fn build_enriched_heartbeat_payload(
    base_payload: &Value,
    uptime_secs: u64,
    last_rtt_ms: Option<u64>,
    active_children: usize,
) -> Value {
    let mut telemetry: Map<String, Value> = match base_payload {
        Value::Object(map) => map
            .iter()
            .filter(|(k, _)| TELEMETRY_KEYS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        _ => Map::new(),
    };
    telemetry.insert("os".to_string(), json!(std::env::consts::OS));
    telemetry.insert("arch".to_string(), json!(std::env::consts::ARCH));
    telemetry.insert("daemonVersion".to_string(), json!(DAEMON_VERSION));
    telemetry.insert("protocolVersion".to_string(), json!(PROTOCOL_VERSION_MAJOR));
    telemetry.insert("uptimeSecs".to_string(), json!(uptime_secs));
    telemetry.insert("activeChildren".to_string(), json!(active_children));
    if let Some(rtt) = last_rtt_ms {
        telemetry.insert("lastRttMs".to_string(), json!(rtt));
    } else {
        telemetry.remove("lastRttMs");
    }
    json!({ "telemetry": telemetry })
}

/// Sends a single terminal heartbeat using ONLY `PAPERWORK_TERMINAL_TOKEN`.
pub fn send_terminal_heartbeat(
    base_url: &str,
    terminal_id: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<HttpResponse, ClientError> {
    let token = read_env_token(ENV_TERMINAL_TOKEN)?;
    let path = terminal_heartbeat_path(terminal_id)?;
    let enriched = build_enriched_heartbeat_payload(payload, 0, None, 0);
    http_post_json(base_url, &path, &token, &enriched, timeout)
}

/// Sends an inbound bot dispatch payload using ONLY `PAPERWORK_BOT_TOKEN`.
pub fn send_bot_inbound(
    base_url: &str,
    bot_id: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<HttpResponse, ClientError> {
    let token = read_env_token(ENV_BOT_TOKEN)?;
    let path = bot_inbound_path(bot_id)?;
    http_post_json(base_url, &path, &token, payload, timeout)
}

#[derive(Debug, Clone)]
pub struct HeartbeatDaemonConfig {
    pub base_url: String,
    pub terminal_id: String,
    pub payload: Value,
    pub interval: Duration,
    pub timeout: Duration,
    pub backoff: BackoffConfig,
    pub max_iterations: Option<usize>,
    pub state_path: Option<PathBuf>,
    pub control_socket_path: Option<PathBuf>,
    pub check_compatibility_on_start: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonSummary {
    pub iterations: usize,
    pub successes: usize,
    pub failures: usize,
    pub stopped_cleanly: bool,
    pub compatibility_ok: Option<bool>,
    pub last_rtt_ms: Option<u64>,
}

/// Runs a terminal heartbeat loop with jittered exponential backoff, enriched telemetry,
/// optional compatibility handshake, optional UDS control plane, and atomic `state.json` persistence.
/// Persisted state is restored on startup (fail-open to fresh defaults when missing or unreadable).
/// Reads the bearer token exclusively from `PAPERWORK_TERMINAL_TOKEN`.
pub fn run_heartbeat_daemon(
    config: &HeartbeatDaemonConfig,
    shutdown: &ShutdownSignal,
) -> Result<DaemonSummary, ClientError> {
    let token = read_env_token(ENV_TERMINAL_TOKEN)?;
    let path = terminal_heartbeat_path(&config.terminal_id)?;
    run_heartbeat_daemon_with_token(config, &path, &token, shutdown)
}

fn run_heartbeat_daemon_with_token(
    config: &HeartbeatDaemonConfig,
    path: &str,
    token: &str,
    shutdown: &ShutdownSignal,
) -> Result<DaemonSummary, ClientError> {
    let compatibility_ok = if config.check_compatibility_on_start {
        Some(
            check_compatibility(&config.base_url, Some(token), config.timeout)
                .map(|r| r.reachable)
                .unwrap_or(false),
        )
    } else {
        None
    };

    #[cfg(unix)]
    let telemetry = Arc::new(DaemonTelemetry::new(&config.terminal_id));

    #[cfg(unix)]
    let _control_server = match &config.control_socket_path {
        Some(sock_path) => Some(
            ControlSocketServer::start(sock_path, telemetry.clone(), shutdown.clone())
                .map_err(|e| ClientError::new(e.to_string()))?,
        ),
        None => None,
    };

    let started = Instant::now();
    let mut backoff = BackoffState::new(config.backoff);
    let restored = restore_persisted_state(config.state_path.as_deref());
    let mut consecutive_failures: u32 = restored.as_ref().map_or(0, |s| s.consecutive_failures);
    let mut last_rtt_ms: Option<u64> = restored.as_ref().and_then(|s| s.last_rtt_ms);
    let mut last_heartbeat_at: Option<u64> = restored.as_ref().and_then(|s| s.last_heartbeat_at);
    #[cfg(unix)]
    {
        telemetry.set_consecutive_failures(consecutive_failures);
        if let Some(rtt_ms) = last_rtt_ms {
            telemetry.record_rtt_ms(rtt_ms);
        }
    }

    let mut summary = DaemonSummary {
        iterations: 0,
        successes: 0,
        failures: 0,
        stopped_cleanly: true,
        compatibility_ok,
        last_rtt_ms: None,
    };

    while !shutdown.is_triggered() {
        #[cfg(unix)]
        if telemetry.is_draining() && telemetry.active_children() == 0 {
            break;
        }

        if let Some(max) = config.max_iterations {
            if summary.iterations >= max {
                break;
            }
        }
        summary.iterations += 1;

        #[cfg(unix)]
        let active_children = telemetry.active_children();
        #[cfg(not(unix))]
        let active_children = 0usize;

        let enriched = build_enriched_heartbeat_payload(
            &config.payload,
            started.elapsed().as_secs(),
            last_rtt_ms,
            active_children,
        );

        let req_start = Instant::now();
        let ok = match http_post_json(&config.base_url, path, token, &enriched, config.timeout) {
            Ok(resp) if resp.is_success() => true,
            Ok(_) | Err(_) => false,
        };
        let rtt_ms = req_start.elapsed().as_millis() as u64;

        let wait_duration = if ok {
            summary.successes += 1;
            consecutive_failures = 0;
            last_rtt_ms = Some(rtt_ms);
            last_heartbeat_at = Some(now_unix_secs());
            summary.last_rtt_ms = last_rtt_ms;
            backoff.reset();
            #[cfg(unix)]
            {
                telemetry.record_rtt_ms(rtt_ms);
                telemetry.set_backoff_attempts(0);
                telemetry.set_consecutive_failures(0);
            }
            config.interval
        } else {
            summary.failures += 1;
            consecutive_failures = consecutive_failures.saturating_add(1);
            let delay = backoff.next_delay();
            #[cfg(unix)]
            {
                telemetry.set_backoff_attempts(backoff.attempts());
                telemetry.set_consecutive_failures(consecutive_failures);
            }
            delay
        };

        if let Some(state_path) = &config.state_path {
            let persisted = PersistedDaemonState {
                terminal_id: config.terminal_id.clone(),
                server_url: config.base_url.clone(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                last_heartbeat_at,
                last_rtt_ms,
                consecutive_failures,
            };
            let _ = save_state_atomic(state_path, &persisted);
        }

        if let Some(max) = config.max_iterations {
            if summary.iterations >= max {
                break;
            }
        }

        if shutdown.wait_or_sleep(wait_duration) {
            break;
        }
    }

    Ok(summary)
}

/// Loads the persisted `state.json` for a fail-open startup restore.
///
/// Returns `None` (fresh defaults) when no state path is configured, the file does not
/// exist yet, or it cannot be read/parsed. Errors are logged as a warning and never
/// abort the daemon.
fn restore_persisted_state(state_path: Option<&Path>) -> Option<PersistedDaemonState> {
    let path = state_path?;
    match load_state(path) {
        Ok(state) => state,
        Err(e) => {
            eprintln!(
                "[paperwork-bot] warning: ignoring unreadable state file {}: {}",
                path.display(),
                redact_secrets(&e.to_string())
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn request_json_body(req: &str) -> Value {
        let (_, body) = req.split_once("\r\n\r\n").expect("HTTP header terminator");
        serde_json::from_str(body).expect("heartbeat body is JSON")
    }

    /// Mirrors the strict `heartbeatBodySchema`/`terminalTelemetrySchema` in
    /// `server/src/routes/enterprise-bots.ts`: unknown keys or wrong types are rejected.
    fn matches_strict_server_schema(body: &Value) -> bool {
        let Some(top) = body.as_object() else {
            return false;
        };
        if top.keys().map(String::as_str).ne(["telemetry"]) {
            return false;
        }
        let Some(telemetry) = body["telemetry"].as_object() else {
            return false;
        };
        telemetry.iter().all(|(k, v)| match k.as_str() {
            "os" | "arch" | "daemonVersion" => {
                v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 64)
            }
            "protocolVersion" => v.as_u64().is_some_and(|n| (1..=100).contains(&n)),
            "uptimeSecs" | "cpuPct" | "memRssMb" | "activeChildren" | "lastRttMs" => {
                v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
            }
            _ => false,
        })
    }

    #[test]
    fn path_builders_validate_segments() {
        assert_eq!(
            terminal_heartbeat_path("term-123").unwrap(),
            "/api/enterprise-bots/terminals/term-123/heartbeat"
        );
        assert_eq!(
            bot_inbound_path("bot_42").unwrap(),
            "/api/enterprise-bots/bots/bot_42/inbound"
        );
        assert!(terminal_heartbeat_path("../evil").is_err());
        assert!(bot_inbound_path("a/b").is_err());
        assert!(bot_inbound_path("   ").is_err());
    }

    #[test]
    fn backoff_doubles_caps_and_resets() {
        let mut b = BackoffState::new(BackoffConfig {
            initial_ms: 100,
            max_ms: 350,
            multiplier: 2,
            jitter_percent: 0,
        });
        assert_eq!(b.next_delay(), Duration::from_millis(100));
        assert_eq!(b.next_delay(), Duration::from_millis(200));
        assert_eq!(b.next_delay(), Duration::from_millis(350));
        assert_eq!(b.next_delay(), Duration::from_millis(350));
        assert_eq!(b.attempts(), 4);
        b.reset();
        assert_eq!(b.attempts(), 0);
        assert_eq!(b.next_delay(), Duration::from_millis(100));
    }

    #[test]
    fn backoff_with_jitter_stays_within_bounds() {
        let mut b = BackoffState::new(BackoffConfig {
            initial_ms: 1_000,
            max_ms: 4_000,
            multiplier: 2,
            jitter_percent: 25,
        });
        let d1 = b.next_delay_with_seed(42).as_millis() as u64;
        assert!((750..=1_250).contains(&d1), "d1={d1}");
        let d2 = b.next_delay_with_seed(99).as_millis() as u64;
        assert!((1_500..=2_500).contains(&d2), "d2={d2}");
        let d3 = b.next_delay_with_seed(7).as_millis() as u64;
        assert!((3_000..=4_000).contains(&d3), "d3={d3}");
    }

    #[test]
    fn heartbeat_payload_nests_telemetry_and_drops_non_schema_keys() {
        assert!(
            PROTOCOL_VERSION.starts_with(&format!("{PROTOCOL_VERSION_MAJOR}.")),
            "wire protocolVersion must be the integer major of {PROTOCOL_VERSION}"
        );
        let base = json!({ "status": "online", "hostname": null, "cpuPct": 3.5 });
        let first = build_enriched_heartbeat_payload(&base, 0, None, 0);
        assert!(matches_strict_server_schema(&first), "{first}");
        let telemetry = first["telemetry"].as_object().unwrap();
        // `serde_json/preserve_order` unifies across the workspace (IndexMap, insertion
        // order), so compare the key set rather than map iteration order.
        let mut keys = telemetry.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "activeChildren",
                "arch",
                "cpuPct",
                "daemonVersion",
                "os",
                "protocolVersion",
                "uptimeSecs"
            ]
        );
        assert_eq!(telemetry["protocolVersion"], json!(PROTOCOL_VERSION_MAJOR));
        assert!(telemetry["protocolVersion"].is_u64());
        assert!(
            telemetry.get("lastRttMs").is_none(),
            "no RTT before the first success; `null` is rejected by the schema"
        );

        let second = build_enriched_heartbeat_payload(&Value::Null, 15, Some(12), 1);
        assert!(matches_strict_server_schema(&second), "{second}");
        assert_eq!(second["telemetry"]["lastRttMs"], json!(12));
        assert_eq!(second["telemetry"]["uptimeSecs"], json!(15));
        assert_eq!(second["telemetry"]["activeChildren"], json!(1));
        assert!(second["telemetry"].get("cpuPct").is_none());

        // The mirror must stay as strict as the server: the legacy flat shape and the
        // pre-fix field types are all rejected.
        assert!(!matches_strict_server_schema(
            &json!({ "status": "online", "os": "macos", "protocolVersion": 1 })
        ));
        assert!(!matches_strict_server_schema(
            &json!({ "telemetry": { "protocolVersion": "1.0" } })
        ));
        assert!(!matches_strict_server_schema(
            &json!({ "telemetry": { "lastRttMs": null } })
        ));
    }

    #[test]
    fn http_post_json_sends_bearer_and_parses_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(req.starts_with("POST /api/enterprise-bots/terminals/t-1/heartbeat HTTP/1.1"));
            assert!(req.contains("Authorization: Bearer pcp_term_test123"));
            assert!(req.contains("\"status\":\"online\""));
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let url = format!("http://{addr}");
        let path = terminal_heartbeat_path("t-1").unwrap();
        let resp = http_post_json(
            &url,
            &path,
            "pcp_term_test123",
            &json!({"status": "online"}),
            Duration::from_secs(2),
        )
        .unwrap();
        handle.join().unwrap();

        assert_eq!(resp.status, 200);
        assert!(resp.is_success());
        assert_eq!(resp.body, "{\"ok\":true}");
    }

    #[test]
    fn daemon_loop_checks_compatibility_sends_telemetry_and_persists_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = thread::spawn(move || {
            // 1. Compatibility handshake GET
            {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                assert!(req.starts_with("GET /api/enterprise-bots/compatibility HTTP/1.1"));
                let resp = "HTTP/1.1 200 OK\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"protocolVersion\":\"1.0\"}";
                let _ = sock.write_all(resp.as_bytes());
            }
            // 2. Two enriched heartbeat POSTs, validated like the server's strict Zod schema.
            //    The mock returns 400 unless the body is exactly `{"telemetry": {...}}` with
            //    allowlisted keys and an integer protocolVersion; `lastRttMs` must be absent on
            //    beat 1 (no prior success) and a number on beat 2.
            for beat in 0..2 {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = request_json_body(&req);
                let accepted = matches_strict_server_schema(&body)
                    && body["telemetry"]["lastRttMs"].is_u64() == (beat == 1);
                let resp = if accepted {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                } else {
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                };
                let _ = sock.write_all(resp.as_bytes());
            }
        });

        let state_dir = std::env::temp_dir().join(format!(
            "pwork-daemon-test-{}-{}",
            std::process::id(),
            now_unix_secs()
        ));
        let state_path = state_dir.join("state.json");

        let cfg = HeartbeatDaemonConfig {
            base_url: format!("http://{addr}"),
            terminal_id: "t-1".into(),
            payload: json!({"status": "online"}),
            interval: Duration::from_millis(10),
            timeout: Duration::from_secs(2),
            backoff: BackoffConfig {
                initial_ms: 10,
                max_ms: 50,
                multiplier: 2,
                jitter_percent: 10,
            },
            max_iterations: Some(2),
            state_path: Some(state_path.clone()),
            control_socket_path: None,
            check_compatibility_on_start: true,
        };
        let path = terminal_heartbeat_path(&cfg.terminal_id).unwrap();
        let shutdown = ShutdownSignal::new();
        let summary =
            run_heartbeat_daemon_with_token(&cfg, &path, "pcp_term_secret", &shutdown).unwrap();
        handle.join().unwrap();

        assert_eq!(summary.iterations, 2);
        assert_eq!(summary.successes, 2);
        assert_eq!(summary.failures, 0);
        assert!(summary.stopped_cleanly);
        assert_eq!(summary.compatibility_ok, Some(true));
        assert!(summary.last_rtt_ms.is_some());

        let persisted = load_state(&state_path).unwrap().expect("state.json saved");
        assert_eq!(persisted.terminal_id, "t-1");
        assert_eq!(persisted.consecutive_failures, 0);
        assert!(persisted.last_heartbeat_at.is_some());
        let _ = std::fs::remove_dir_all(&state_dir);
    }

    #[test]
    fn daemon_startup_restores_persisted_consecutive_failures_from_state_file() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        // The single heartbeat attempt fails (HTTP 500) so the restored counter is
        // incremented rather than reset, which distinguishes "restored" from "fresh".
        let handle = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(
                req.contains("\"lastRttMs\":77"),
                "first heartbeat must carry restored lastRttMs"
            );
            let resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = sock.write_all(resp.as_bytes());
        });

        let state_dir = std::env::temp_dir().join(format!(
            "pwork-daemon-restore-{}-{}",
            std::process::id(),
            now_unix_secs()
        ));
        let state_path = state_dir.join("state.json");
        let prior = PersistedDaemonState {
            terminal_id: "t-restore".into(),
            server_url: format!("http://{addr}"),
            protocol_version: PROTOCOL_VERSION.to_string(),
            last_heartbeat_at: Some(1_760_000_000),
            last_rtt_ms: Some(77),
            consecutive_failures: 4,
        };
        save_state_atomic(&state_path, &prior).unwrap();

        let cfg = HeartbeatDaemonConfig {
            base_url: format!("http://{addr}"),
            terminal_id: "t-restore".into(),
            payload: json!({"status": "online"}),
            interval: Duration::from_millis(10),
            timeout: Duration::from_secs(2),
            backoff: BackoffConfig {
                initial_ms: 10,
                max_ms: 50,
                multiplier: 2,
                jitter_percent: 0,
            },
            max_iterations: Some(1),
            state_path: Some(state_path.clone()),
            control_socket_path: None,
            check_compatibility_on_start: false,
        };
        let path = terminal_heartbeat_path(&cfg.terminal_id).unwrap();
        let shutdown = ShutdownSignal::new();
        let summary =
            run_heartbeat_daemon_with_token(&cfg, &path, "pcp_term_secret", &shutdown).unwrap();
        handle.join().unwrap();

        assert_eq!(summary.iterations, 1);
        assert_eq!(summary.failures, 1);

        // Fresh defaults would persist 1 / null metadata; 5 and the prior values prove restore.
        let persisted = load_state(&state_path).unwrap().expect("state.json saved");
        assert_eq!(persisted.consecutive_failures, 5);
        assert_eq!(persisted.last_rtt_ms, Some(77));
        assert_eq!(persisted.last_heartbeat_at, Some(1_760_000_000));
        let _ = std::fs::remove_dir_all(&state_dir);
    }

    #[test]
    fn is_loopback_host_matches_only_loopback_names_case_insensitively() {
        for host in ["localhost", "LocalHost", "LOCALHOST", "127.0.0.1", "::1"] {
            assert!(is_loopback_host(host), "expected {host:?} to be loopback");
        }
        for host in [
            "example.com",
            "localhost.example.com",
            "127.0.0.1.example.com",
            "0.0.0.0",
            "[::1]",
            "",
        ] {
            assert!(
                !is_loopback_host(host),
                "expected {host:?} to be non-loopback"
            );
        }
    }

    #[test]
    fn parse_http_url_accepts_loopback_plain_http_hosts() {
        let v4 = parse_http_url("http://127.0.0.1:3100").unwrap();
        assert_eq!((v4.host.as_str(), v4.port), ("127.0.0.1", 3100));
        assert_eq!(v4.base_path, "");

        let name = parse_http_url("http://localhost:3100/api").unwrap();
        assert_eq!((name.host.as_str(), name.port), ("localhost", 3100));
        assert_eq!(name.base_path, "/api");

        let v6 = parse_http_url("http://[::1]:3100").unwrap();
        assert_eq!((v6.host.as_str(), v6.port), ("::1", 3100));

        let upper = parse_http_url("http://LOCALHOST:3100").unwrap();
        assert_eq!(upper.host, "LOCALHOST");
    }

    #[test]
    fn parse_http_url_rejects_non_loopback_plain_http_by_default() {
        let err = parse_http_url("http://example.com:3100").unwrap_err();
        assert!(
            err.message.contains("non-loopback host 'example.com'"),
            "unexpected message: {}",
            err.message
        );
        assert!(err.message.contains(ENV_ALLOW_REMOTE_HTTP));

        let err = parse_http_url_with_policy("http://example.com", false).unwrap_err();
        assert!(err.message.contains("non-loopback host 'example.com'"));

        // Preceding validations keep their own messages.
        assert!(parse_http_url("http://").is_err());
        assert!(parse_http_url("ftp://example.com").is_err());
    }

    #[test]
    fn parse_http_url_allows_remote_plain_http_only_with_explicit_opt_in() {
        let parsed = parse_http_url_with_policy("http://example.com:3100/prefix", true).unwrap();
        assert_eq!((parsed.host.as_str(), parsed.port), ("example.com", 3100));
        assert_eq!(parsed.base_path, "/prefix");

        // Loopback hosts never need the opt-in; remote hosts always need it.
        assert!(parse_http_url_with_policy("http://localhost", false).is_ok());
        assert!(parse_http_url_with_policy("http://10.0.0.5:3100", false).is_err());
    }

    #[test]
    fn client_error_redacts_secrets() {
        let err = ClientError::new("failed with Bearer abc123 and pcp_bot_xyz789");
        assert!(!err.message.contains("abc123"));
        assert!(!err.message.contains("xyz789"));
        assert!(err.message.contains("Bearer [REDACTED]"));
        assert!(err.message.contains("pcp_bot_[REDACTED]"));
    }
}

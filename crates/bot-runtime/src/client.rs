//! Lightweight stdlib HTTP/1.1 client and daemon loop helpers for Paperwork control plane.
//!
//! Security invariant:
//! - Terminal tokens are read ONLY from `PAPERWORK_TERMINAL_TOKEN`.
//! - Bot tokens are read ONLY from `PAPERWORK_BOT_TOKEN`.
//! - Tokens are never accepted as CLI arguments and all error strings are redacted.

use crate::token::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fmt;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub const ENV_TERMINAL_TOKEN: &str = "PAPERWORK_TERMINAL_TOKEN";
pub const ENV_BOT_TOKEN: &str = "PAPERWORK_BOT_TOKEN";

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffConfig {
    pub initial_ms: u64,
    pub max_ms: u64,
    pub multiplier: u32,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            initial_ms: 1_000,
            max_ms: 30_000,
            multiplier: 2,
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
            },
            current_ms: initial,
            attempts: 0,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let delay = Duration::from_millis(self.current_ms);
        self.attempts = self.attempts.saturating_add(1);
        self.current_ms = self
            .current_ms
            .saturating_mul(u64::from(self.config.multiplier))
            .min(self.config.max_ms);
        delay
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
        || trimmed.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(ClientError::new(format!(
            "invalid {label}: must be a single safe URL path segment"
        )));
    }
    Ok(())
}

pub fn terminal_heartbeat_path(terminal_id: &str) -> Result<String, ClientError> {
    validate_path_segment("terminal_id", terminal_id)?;
    Ok(format!("/api/enterprise-bots/terminals/{terminal_id}/heartbeat"))
}

pub fn bot_inbound_path(bot_id: &str) -> Result<String, ClientError> {
    validate_path_segment("bot_id", bot_id)?;
    Ok(format!("/api/enterprise-bots/bots/{bot_id}/inbound"))
}

struct ParsedHttpUrl {
    host: String,
    port: u16,
    base_path: String,
}

fn parse_http_url(base_url: &str) -> Result<ParsedHttpUrl, ClientError> {
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

    Ok(ParsedHttpUrl {
        host,
        port,
        base_path,
    })
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

    let addr = (parsed.host.as_str(), parsed.port)
        .to_socket_addrs()
        .map_err(|e| ClientError::new(format!("DNS resolution failed: {e}")))?
        .next()
        .ok_or_else(|| ClientError::new("could not resolve server address"))?;

    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| ClientError::new(format!("TCP connect failed: {e}")))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let host_header = if parsed.port == 80 {
        parsed.host.clone()
    } else {
        format!("{}:{}", parsed.host, parsed.port)
    };

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
    let val = env::var(var_name)
        .map_err(|_| ClientError::new(format!("missing required environment variable {var_name}")))?;
    let trimmed = val.trim().to_string();
    if trimmed.is_empty() {
        return Err(ClientError::new(format!(
            "environment variable {var_name} is empty"
        )));
    }
    Ok(trimmed)
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
    http_post_json(base_url, &path, &token, payload, timeout)
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonSummary {
    pub iterations: usize,
    pub successes: usize,
    pub failures: usize,
    pub stopped_cleanly: bool,
}

/// Runs a terminal heartbeat loop with exponential backoff and cooperative shutdown.
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
    let mut backoff = BackoffState::new(config.backoff);
    let mut summary = DaemonSummary {
        iterations: 0,
        successes: 0,
        failures: 0,
        stopped_cleanly: true,
    };

    while !shutdown.is_triggered() {
        if let Some(max) = config.max_iterations {
            if summary.iterations >= max {
                break;
            }
        }
        summary.iterations += 1;

        let ok = match http_post_json(
            &config.base_url,
            path,
            token,
            &config.payload,
            config.timeout,
        ) {
            Ok(resp) if resp.is_success() => true,
            Ok(_) | Err(_) => false,
        };

        let wait_duration = if ok {
            summary.successes += 1;
            backoff.reset();
            config.interval
        } else {
            summary.failures += 1;
            backoff.next_delay()
        };

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::TcpListener;

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
    fn daemon_loop_completes_cleanly_with_max_iterations() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = thread::spawn(move || {
            for _ in 0..2 {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
                let _ = sock.write_all(resp.as_bytes());
            }
        });

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
            },
            max_iterations: Some(2),
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

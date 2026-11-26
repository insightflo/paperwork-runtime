//! OpenBot-style Unix Domain Socket (UDS) local control plane.
//!
//! Security invariants:
//! - Control socket directory is preflight-validated with
//!   `paperclip_ops_control::validate_control_socket_dir` (exact `0700`, owned by euid,
//!   no symlink ancestors).
//! - Socket file is created with `0600` permissions at
//!   `$XDG_RUNTIME_DIR/paperwork-bot/<terminal-id>/control.sock` by default.
//! - JSON-over-UDS commands: `status`, `drain`, `shutdown`.

use crate::client::{ShutdownSignal, PROTOCOL_VERSION};
use paperclip_ops_control::validate_control_socket_dir;
use serde::{Deserialize, Serialize};
use std::env;
use std::fmt;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum ControlSockError {
    Invalid(String),
    Security(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for ControlSockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid control socket input: {m}"),
            Self::Security(m) => write!(f, "control socket security error: {m}"),
            Self::Io(e) => write!(f, "control socket io error: {e}"),
            Self::Json(e) => write!(f, "control socket json error: {e}"),
        }
    }
}

impl std::error::Error for ControlSockError {}

impl From<io::Error> for ControlSockError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for ControlSockError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommand {
    Status,
    Drain,
    Shutdown,
}

impl ControlCommand {
    pub fn parse(s: &str) -> Result<Self, ControlSockError> {
        match s.trim() {
            "status" => Ok(Self::Status),
            "drain" => Ok(Self::Drain),
            "shutdown" => Ok(Self::Shutdown),
            other => Err(ControlSockError::Invalid(format!(
                "unknown ctl command {other:?}; expected status|drain|shutdown"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub command: ControlCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusSnapshot {
    pub pid: u32,
    pub terminal_id: String,
    pub protocol_version: String,
    pub uptime_secs: u64,
    pub last_rtt_ms: Option<u64>,
    pub backoff_attempts: u32,
    pub consecutive_failures: u32,
    pub active_children: usize,
    pub draining: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub ok: bool,
    pub command: ControlCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<DaemonStatusSnapshot>,
}

/// Lock-free shared telemetry between the heartbeat loop, executor, and UDS control server.
#[derive(Debug)]
pub struct DaemonTelemetry {
    terminal_id: String,
    protocol_version: String,
    started_at: Instant,
    has_rtt: AtomicBool,
    last_rtt_ms: AtomicU64,
    backoff_attempts: AtomicU32,
    consecutive_failures: AtomicU32,
    active_children: AtomicUsize,
    draining: AtomicBool,
}

impl DaemonTelemetry {
    pub fn new(terminal_id: impl Into<String>) -> Self {
        Self {
            terminal_id: terminal_id.into(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            started_at: Instant::now(),
            has_rtt: AtomicBool::new(false),
            last_rtt_ms: AtomicU64::new(0),
            backoff_attempts: AtomicU32::new(0),
            consecutive_failures: AtomicU32::new(0),
            active_children: AtomicUsize::new(0),
            draining: AtomicBool::new(false),
        }
    }

    pub fn record_rtt_ms(&self, rtt_ms: u64) {
        self.last_rtt_ms.store(rtt_ms, Ordering::Relaxed);
        self.has_rtt.store(true, Ordering::Release);
    }

    pub fn last_rtt_ms(&self) -> Option<u64> {
        if self.has_rtt.load(Ordering::Acquire) {
            Some(self.last_rtt_ms.load(Ordering::Relaxed))
        } else {
            None
        }
    }

    pub fn set_backoff_attempts(&self, attempts: u32) {
        self.backoff_attempts.store(attempts, Ordering::Relaxed);
    }

    pub fn set_consecutive_failures(&self, failures: u32) {
        self.consecutive_failures.store(failures, Ordering::Relaxed);
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures.load(Ordering::Relaxed)
    }

    pub fn active_children_counter(&self) -> &AtomicUsize {
        &self.active_children
    }

    pub fn active_children(&self) -> usize {
        self.active_children.load(Ordering::Relaxed)
    }

    pub fn request_drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub fn snapshot(&self) -> DaemonStatusSnapshot {
        DaemonStatusSnapshot {
            pid: std::process::id(),
            terminal_id: self.terminal_id.clone(),
            protocol_version: self.protocol_version.clone(),
            uptime_secs: self.uptime_secs(),
            last_rtt_ms: self.last_rtt_ms(),
            backoff_attempts: self.backoff_attempts.load(Ordering::Relaxed),
            consecutive_failures: self.consecutive_failures.load(Ordering::Relaxed),
            active_children: self.active_children.load(Ordering::Relaxed),
            draining: self.draining.load(Ordering::SeqCst),
        }
    }
}

fn validate_terminal_segment(terminal_id: &str) -> Result<(), ControlSockError> {
    let trimmed = terminal_id.trim();
    if trimmed.is_empty()
        || trimmed != terminal_id
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(ControlSockError::Invalid(
            "terminal_id must be a single safe path segment".into(),
        ));
    }
    Ok(())
}

/// Resolves the default control socket path:
/// `$XDG_RUNTIME_DIR/paperwork-bot/<terminal-id>/control.sock`
/// (falling back to `<temp_dir>/paperwork-bot/<terminal-id>/control.sock` if `XDG_RUNTIME_DIR` is unset).
pub fn default_control_socket_dir(terminal_id: &str) -> Result<PathBuf, ControlSockError> {
    validate_terminal_segment(terminal_id)?;
    let base = match env::var("XDG_RUNTIME_DIR") {
        Ok(val) if !val.trim().is_empty() => {
            let p = PathBuf::from(val.trim());
            if !p.is_absolute() {
                return Err(ControlSockError::Invalid(
                    "XDG_RUNTIME_DIR must be an absolute path".into(),
                ));
            }
            p
        }
        _ => env::temp_dir(),
    };
    Ok(base.join("paperwork-bot").join(terminal_id))
}

pub fn default_control_socket_path(terminal_id: &str) -> Result<PathBuf, ControlSockError> {
    Ok(default_control_socket_dir(terminal_id)?.join("control.sock"))
}

/// Ensures `dir` exists with `0700` permissions, canonicalizes it, and runs
/// `paperclip_ops_control::validate_control_socket_dir` fail-closed.
pub fn ensure_and_validate_socket_dir(dir: &Path) -> Result<PathBuf, ControlSockError> {
    if let Some(parent) = dir.parent() {
        if !parent.exists() {
            let mut b = fs::DirBuilder::new();
            b.recursive(true).mode(0o700);
            b.create(parent)?;
        }
    }
    match fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(ControlSockError::Io(e)),
    }
    let canonical = fs::canonicalize(dir)?;
    validate_control_socket_dir(&canonical)
        .map_err(|e| ControlSockError::Security(e.to_string()))?;
    Ok(canonical)
}

/// Background UDS control server handle; stops and removes the socket file when closed/dropped.
pub struct ControlSocketServer {
    socket_path: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl ControlSocketServer {
    pub fn start(
        socket_path: &Path,
        telemetry: Arc<DaemonTelemetry>,
        shutdown: ShutdownSignal,
    ) -> Result<Self, ControlSockError> {
        let Some(dir) = socket_path.parent() else {
            return Err(ControlSockError::Invalid(
                "control socket path must have a parent directory".into(),
            ));
        };
        let Some(file_name) = socket_path.file_name() else {
            return Err(ControlSockError::Invalid(
                "control socket path must have a file name".into(),
            ));
        };

        let validated_dir = ensure_and_validate_socket_dir(dir)?;
        let canonical_socket = validated_dir.join(file_name);

        if let Ok(meta) = fs::symlink_metadata(&canonical_socket) {
            if meta.file_type().is_socket() {
                let _ = fs::remove_file(&canonical_socket);
            } else {
                return Err(ControlSockError::Security(
                    "refusing to overwrite non-socket file at control socket path".into(),
                ));
            }
        }

        let listener = UnixListener::bind(&canonical_socket)?;
        fs::set_permissions(&canonical_socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_shutdown = shutdown.clone();
        let handle = thread::Builder::new()
            .name("paperwork-bot-ctl".into())
            .spawn(move || {
                while !thread_stop.load(Ordering::Acquire) && !thread_shutdown.is_triggered() {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = handle_client(stream, &telemetry, &thread_shutdown);
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => {
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            })?;

        Ok(Self {
            socket_path: canonical_socket,
            stop,
            handle: Some(handle),
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let _ = fs::remove_file(&self.socket_path);
    }
}

impl Drop for ControlSocketServer {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn handle_client(
    mut stream: UnixStream,
    telemetry: &DaemonTelemetry,
    shutdown: &ShutdownSignal,
) -> Result<(), ControlSockError> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let mut line = String::new();
    let mut reader = BufReader::new(stream.try_clone()?);
    reader.read_line(&mut line)?;

    let response = match serde_json::from_str::<ControlRequest>(line.trim()) {
        Ok(req) => match req.command {
            ControlCommand::Status => ControlResponse {
                ok: true,
                command: ControlCommand::Status,
                message: None,
                status: Some(telemetry.snapshot()),
            },
            ControlCommand::Drain => {
                telemetry.request_drain();
                ControlResponse {
                    ok: true,
                    command: ControlCommand::Drain,
                    message: Some("daemon entering drain mode".into()),
                    status: Some(telemetry.snapshot()),
                }
            }
            ControlCommand::Shutdown => {
                telemetry.request_drain();
                shutdown.trigger();
                ControlResponse {
                    ok: true,
                    command: ControlCommand::Shutdown,
                    message: Some("daemon shutdown triggered".into()),
                    status: Some(telemetry.snapshot()),
                }
            }
        },
        Err(e) => ControlResponse {
            ok: false,
            command: ControlCommand::Status,
            message: Some(format!("invalid control request: {e}")),
            status: None,
        },
    };

    let mut payload = serde_json::to_vec(&response)?;
    payload.push(b'\n');
    stream.write_all(&payload)?;
    stream.flush()?;
    Ok(())
}

/// Sends a single JSON-over-UDS command (`status`, `drain`, or `shutdown`) to a running daemon.
pub fn send_control_command(
    socket_path: &Path,
    command: ControlCommand,
    timeout: Duration,
) -> Result<ControlResponse, ControlSockError> {
    if let Some(parent) = socket_path.parent() {
        let canonical = fs::canonicalize(parent)?;
        validate_control_socket_dir(&canonical)
            .map_err(|e| ControlSockError::Security(e.to_string()))?;
    }

    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;

    let req = ControlRequest { command };
    let mut bytes = serde_json::to_vec(&req)?;
    bytes.push(b'\n');
    stream.write_all(&bytes)?;
    stream.flush()?;

    let mut line = String::new();
    let mut reader = BufReader::new(stream);
    reader.read_line(&mut line)?;
    if line.trim().is_empty() {
        return Err(ControlSockError::Invalid(
            "empty response from control socket".into(),
        ));
    }
    Ok(serde_json::from_str(line.trim())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn unique_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = PathBuf::from("/tmp").join(format!(
            "pbc-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut b = fs::DirBuilder::new();
        b.recursive(true).mode(0o700);
        b.create(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn control_socket_status_drain_and_shutdown_roundtrip() {
        let dir = unique_dir("rt");
        let sock = dir.join("control.sock");
        let telemetry = Arc::new(DaemonTelemetry::new("term-uds-1"));
        telemetry.record_rtt_ms(19);
        telemetry.set_backoff_attempts(2);
        telemetry.set_consecutive_failures(1);
        telemetry.active_children_counter().store(3, Ordering::Relaxed);

        let shutdown = ShutdownSignal::new();
        let server = ControlSocketServer::start(&sock, telemetry.clone(), shutdown.clone()).unwrap();

        let sock_mode = fs::metadata(server.socket_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o600, "control.sock must be 0600");

        let status_resp =
            send_control_command(server.socket_path(), ControlCommand::Status, Duration::from_secs(2))
                .unwrap();
        assert!(status_resp.ok);
        let snap = status_resp.status.expect("status snapshot");
        assert_eq!(snap.pid, std::process::id());
        assert_eq!(snap.terminal_id, "term-uds-1");
        assert_eq!(snap.last_rtt_ms, Some(19));
        assert_eq!(snap.backoff_attempts, 2);
        assert_eq!(snap.consecutive_failures, 1);
        assert_eq!(snap.active_children, 3);
        assert!(!snap.draining);

        let drain_resp =
            send_control_command(server.socket_path(), ControlCommand::Drain, Duration::from_secs(2))
                .unwrap();
        assert!(drain_resp.ok);
        assert!(telemetry.is_draining());
        assert!(!shutdown.is_triggered());

        let shutdown_resp = send_control_command(
            server.socket_path(),
            ControlCommand::Shutdown,
            Duration::from_secs(2),
        )
        .unwrap();
        assert!(shutdown_resp.ok);
        assert!(shutdown.is_triggered());

        server.stop();
        assert!(!sock.exists(), "socket file should be cleaned up on stop");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_socket_rejects_unsafe_0755_dir() {
        let dir = unique_dir("unsafe");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let sock = dir.join("control.sock");
        let telemetry = Arc::new(DaemonTelemetry::new("term-unsafe"));
        let shutdown = ShutdownSignal::new();
        let err = ControlSocketServer::start(&sock, telemetry, shutdown)
            .err()
            .expect("must reject non-0700 dir");
        assert!(matches!(err, ControlSockError::Security(_)));
        let _ = fs::remove_dir_all(&dir);
    }
}

//! Remote task dispatch for the personal endpoint bot. Maps serialized endpoint task
//! requests onto the fail-closed `local_tools` execution engine (grant confinement,
//! size/time caps clamped here and never widened), and persists results in an offline
//! JSONL outbox that survives crashes and de-duplicates on ack.

use paperwork_bot_runtime::local_tools::{
    detect_local_clis, list_local_dir, read_local_file, run_local_shell, write_local_file,
    FolderGrant,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Hard cap applied to `ReadFile.max_bytes` (also the default): 256 KiB.
pub const MAX_READ_BYTES: usize = 256 * 1024;
/// Hard cap applied to `ListDir.max_entries` (also the default).
pub const MAX_LIST_ENTRIES: usize = 500;
/// Hard cap applied to `RunShell.timeout_ms` (also the default): 120 s in ms.
pub const MAX_TIMEOUT_MS: u64 = 120_000;
/// stdout/stderr truncation cap handed to `run_local_shell`.
pub const MAX_SHELL_OUTPUT_BYTES: usize = 256 * 1024;

/// A remote endpoint task addressed to this bot, tagged on the wire as `{"kind": ...}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EndpointTaskRequest {
    ReadFile { path: String, max_bytes: Option<usize> },
    WriteFile { path: String, content: String },
    ListDir { path: String, max_entries: Option<usize> },
    RunShell { cwd: String, command: String, timeout_ms: Option<u64> },
    DetectClis,
}

/// Outcome of one dispatched endpoint task, persisted verbatim in the offline outbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointTaskResult {
    pub task_id: String,
    pub ok: bool,
    pub output: serde_json::Value,
    pub error: Option<String>,
}

/// Dispatches `req` through the fail-closed `local_tools` engine using `grants`. Engine
/// denials (escape, read-only) and errors surface as `ok: false` results carrying the
/// engine's error code — never panics and never widens granted access.
pub fn execute_endpoint_task(task_id: &str, grants: &[FolderGrant], req: &EndpointTaskRequest) -> EndpointTaskResult {
    let outcome = match req {
        EndpointTaskRequest::ReadFile { path, max_bytes } => read_local_file(
            grants,
            Path::new(path),
            max_bytes.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES),
        )
        .map(serde_json::Value::String),
        EndpointTaskRequest::WriteFile { path, content } => write_local_file(
            grants,
            Path::new(path),
            content.as_bytes(),
        )
        .map(|written| serde_json::Value::String(written.to_string_lossy().into_owned())),
        EndpointTaskRequest::ListDir { path, max_entries } => list_local_dir(
            grants,
            Path::new(path),
            max_entries.unwrap_or(MAX_LIST_ENTRIES).min(MAX_LIST_ENTRIES),
        )
        .map(|entries| serde_json::to_value(entries).unwrap_or(serde_json::Value::Null)),
        EndpointTaskRequest::RunShell { cwd, command, timeout_ms } => run_local_shell(
            grants,
            Path::new(cwd),
            command,
            timeout_ms.unwrap_or(MAX_TIMEOUT_MS).min(MAX_TIMEOUT_MS),
            MAX_SHELL_OUTPUT_BYTES,
        )
        .map(|exec| serde_json::to_value(exec).unwrap_or(serde_json::Value::Null)),
        EndpointTaskRequest::DetectClis => Ok(detect_clis_output()),
    };
    match outcome {
        Ok(output) => EndpointTaskResult { task_id: task_id.to_string(), ok: true, output, error: None },
        Err(error) => EndpointTaskResult { task_id: task_id.to_string(), ok: false, output: serde_json::Value::Null, error: Some(error) },
    }
}

/// Serializes probed CLIs to JSON. `DetectedCli` in `local_tools` has no `Serialize` impl
/// on purpose, so this outbox wire-format mapping lives here, next to its consumers.
fn detect_clis_output() -> serde_json::Value {
    serde_json::Value::Array(
        detect_local_clis()
            .into_iter()
            .map(|cli| {
                serde_json::json!({
                    "id": cli.id,
                    "binary": cli.binary,
                    "path": cli.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                    "available": cli.available,
                })
            })
            .collect(),
    )
}

/// Offline JSONL outbox for endpoint task results produced while the bot is disconnected
/// from its server. One JSON object per line, appended atomically; entries stay pending
/// until explicitly acked, after which they can never be loaded again.
pub struct OfflineResultQueue;

impl OfflineResultQueue {
    /// Appends exactly one JSON line for `result` in a single append-mode write (atomic
    /// w.r.t. other appenders), keeping the queue file owner-only (`0600`) on Unix.
    pub fn append_result(queue_path: &Path, result: &EndpointTaskResult) -> Result<(), String> {
        let mut line = serde_json::to_string(result)
            .map_err(|e| format!("result_serialize_failed: {e}"))?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(queue_path)
            .map_err(|e| format!("queue_open_failed: {e}"))?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("queue_perms_failed: {e}"))?;
        let bytes = line.as_bytes();
        let written = file.write(bytes).map_err(|e| format!("queue_append_failed: {e}"))?;
        if written != bytes.len() {
            return Err("queue_append_short_write".into());
        }
        Ok(())
    }

    /// Reads every valid pending result. A missing queue means nothing is pending; torn
    /// or unparseable lines (crash residue) are skipped, never surfaced as failures.
    pub fn load_pending(queue_path: &Path) -> Result<Vec<EndpointTaskResult>, String> {
        let content = match fs::read_to_string(queue_path) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("queue_read_failed: {e}")),
        };
        Ok(content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect())
    }

    /// Removes every pending line whose `task_id` matches by rewriting the queue
    /// atomically (temp file + rename), so an acked result can never be redelivered.
    /// Idempotent: acking an unknown `task_id` is a no-op. The rewrite also compacts
    /// away unparseable crash-residue lines.
    pub fn ack_task(queue_path: &Path, task_id: &str) -> Result<(), String> {
        let pending = Self::load_pending(queue_path)?;
        if !pending.iter().any(|r| r.task_id == task_id) {
            return Ok(());
        }
        let mut body = String::new();
        for result in &pending {
            if result.task_id != task_id {
                let line = serde_json::to_string(result)
                    .map_err(|e| format!("result_serialize_failed: {e}"))?;
                body.push_str(&line);
                body.push('\n');
            }
        }
        write_queue_atomic(queue_path, body.as_bytes())
    }
}

static QUEUE_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Atomically replaces `queue_path` with `body`: write a fresh temp file in the same
/// directory, then rename it over the queue so readers never observe a partial rewrite.
fn write_queue_atomic(queue_path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = queue_path.parent().ok_or("invalid_queue_path")?;
    let temp = parent.join(format!(
        ".result-queue-{}-{}.tmp",
        std::process::id(),
        QUEUE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let write_body = || -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)
            .map_err(|e| format!("queue_temp_open_failed: {e}"))?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("queue_perms_failed: {e}"))?;
        file.write_all(body).map_err(|e| format!("queue_temp_write_failed: {e}"))
    };
    if let Err(e) = write_body() {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    fs::rename(&temp, queue_path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("queue_rename_failed: {e}")
    })
}

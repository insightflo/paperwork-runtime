//! Append-only local audit trail for every file / shell / CLI action executed on the
//! user's PC by `paperwork-bot`. One JSON object per line, owner-only (`0600`) on Unix,
//! size-rotated to `<path>.1` past `max_bytes`; `summary` always passes through
//! [`redact_sensitive`] so secrets never reach the on-disk log.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// One audited local action on the personal endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp_ms: u64,
    pub task_id: String,
    pub action: String,
    pub target_path: String,
    pub allowed: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub summary: String,
}

/// Masks every secret shape this audit trail knows about in free-form log text:
/// `Bearer <token>`, provider key prefixes (`sk-`, `ghp_`, `xoxb-`), and `key=` /
/// `token=` / `password=` assignments. Secret values become `[REDACTED]`; surrounding
/// text is preserved verbatim.
pub fn redact_sensitive(input: &str) -> String {
    redact_key_values(&redact_prefixed_keys(&redact_bearer(input)))
}

/// Replaces each token after a standalone (case-insensitive) `Bearer ` with `[REDACTED]`.
fn redact_bearer(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut cuts: Vec<(usize, usize)> = Vec::new();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("bearer") {
        let at = from + rel;
        from = at + "bearer".len();
        let standalone = at == 0 || !is_word_byte(bytes[at - 1]);
        let mut value = at + "bearer".len();
        while value < bytes.len() && (bytes[value] == b' ' || bytes[value] == b'\t') { value += 1; }
        if standalone {
            if let Some(end) = token_run_end(bytes, value) {
                cuts.push((value, end));
                from = end;
            }
        }
    }
    splice(input, &cuts)
}

/// Replaces the value of provider keys starting with `sk-`, `ghp_`, or `xoxb-` with
/// `[REDACTED]` (prefix preserved for readability). Requires a non-word character before
/// the prefix, so ordinary words like `task-` never match.
fn redact_prefixed_keys(input: &str) -> String {
    const PREFIXES: [&str; 3] = ["sk-", "ghp_", "xoxb-"];
    let bytes = input.as_bytes();
    let mut cuts: Vec<(usize, usize)> = Vec::new();
    for prefix in PREFIXES {
        let mut from = 0;
        while let Some(rel) = input[from..].find(prefix) {
            let at = from + rel;
            from = at + prefix.len();
            if at == 0 || !is_word_byte(bytes[at - 1]) {
                if let Some(end) = token_run_end(bytes, at + prefix.len()) {
                    cuts.push((at + prefix.len(), end));
                }
            }
        }
    }
    cuts.sort_unstable();
    splice(input, &cuts)
}

/// Replaces the value of `key=`, `token=`, and `password=` assignments (key matched
/// case-insensitively as the exact word before `=`) with `[REDACTED]`.
fn redact_key_values(input: &str) -> String {
    const SECRET_KEYS: [&str; 3] = ["key", "token", "password"];
    let bytes = input.as_bytes();
    let mut cuts: Vec<(usize, usize)> = Vec::new();
    for at in input.match_indices('=').map(|(at, _)| at) {
        let mut key_start = at;
        while key_start > 0 && is_word_byte(bytes[key_start - 1]) {
            key_start -= 1;
        }
        let key = input[key_start..at].to_ascii_lowercase();
        if SECRET_KEYS.contains(&key.as_str()) {
            if let Some(end) = value_run_end(bytes, at + 1) {
                cuts.push((at + 1, end));
            }
        }
    }
    cuts.sort_unstable();
    splice(input, &cuts)
}

/// End index (exclusive) of the non-empty run of token characters starting at `start`.
fn token_run_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut end = start;
    while end < bytes.len() && is_token_byte(bytes[end]) { end += 1; }
    (end > start).then_some(end)
}

/// End index (exclusive) of a `key=value` assignment value: runs until whitespace or quote.
fn value_run_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut end = start;
    while end < bytes.len() && !bytes[end].is_ascii_whitespace() && bytes[end] != b'"' && bytes[end] != b'\'' { end += 1; }
    (end > start).then_some(end)
}

fn is_token_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' }

fn is_word_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' }

/// Builds `input` with each sorted cut range `(start, end)` replaced by `[REDACTED]`.
/// Overlapping or already-passed cuts are skipped safely.
fn splice(input: &str, cuts: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    for &(start, end) in cuts {
        if start < cursor {
            continue;
        }
        out.push_str(&input[cursor..start]);
        out.push_str("[REDACTED]");
        cursor = end;
    }
    out.push_str(&input[cursor..]);
    out
}

/// Appends audit entries as JSONL under `path`, rotating the active file to `path.1` when
/// it grows past `max_bytes`, and reading the newest entries back for local inspection.
pub struct AuditLogger {
    path: PathBuf,
    max_bytes: u64,
}

impl AuditLogger {
    /// Creates a logger that keeps at most `max_bytes` bytes in the active `path` file.
    pub fn new(path: PathBuf, max_bytes: u64) -> Self {
        Self { path, max_bytes }
    }

    /// Serializes `entry` (with its `summary` passed through [`redact_sensitive`]) as one
    /// JSON line appended to the active file, rotating first when the file already holds
    /// more than `max_bytes` bytes. The file is `0600` on Unix.
    pub fn append(&self, entry: &AuditEntry) -> Result<(), String> {
        let mut safe = entry.clone();
        safe.summary = redact_sensitive(&entry.summary);
        let mut line = serde_json::to_string(&safe)
            .map_err(|e| format!("audit_serialize_failed: {e}"))?;
        line.push('\n');
        self.rotate_if_over_limit()?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("audit_open_failed: {e}"))?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("audit_perms_failed: {e}"))?;
        let bytes = line.as_bytes();
        let written = file.write(bytes).map_err(|e| format!("audit_append_failed: {e}"))?;
        if written != bytes.len() {
            return Err("audit_append_short_write".into());
        }
        Ok(())
    }

    /// Returns up to `limit` newest entries in chronological order (oldest first of the
    /// kept tail), skipping torn or malformed lines. A missing file reads as empty.
    pub fn read_recent(&self, limit: usize) -> Result<Vec<AuditEntry>, String> {
        let content = match fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("audit_read_failed: {e}")),
        };
        let mut entries: Vec<AuditEntry> = content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let start = entries.len().saturating_sub(limit);
        Ok(entries.split_off(start))
    }

    /// Renames the active file to `path.1` (replacing any previous rotation) when it
    /// currently holds more than `max_bytes` bytes. A missing file never rotates.
    fn rotate_if_over_limit(&self) -> Result<(), String> {
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size <= self.max_bytes {
            return Ok(());
        }
        let rotated = rotated_path(&self.path);
        let _ = fs::remove_file(&rotated);
        fs::rename(&self.path, &rotated).map_err(|e| format!("audit_rotate_failed: {e}"))
    }
}

/// Rotation target for `path`: the same path with a `.1` suffix appended.
fn rotated_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.1", path.to_string_lossy()))
}

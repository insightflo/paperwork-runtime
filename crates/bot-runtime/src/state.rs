//! Atomic state persistence for the Paperwork bot daemon (`state.json`).
//!
//! Security invariants:
//! - Written via temp-file + `sync_all()` + `rename()` with `0600` file permissions.
//! - NEVER stores raw tokens (`pcp_term_*`, `pcp_bot_*`, or `Bearer *`).

use crate::token::{BOT_TOKEN_PREFIX, TERMINAL_TOKEN_PREFIX};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

#[derive(Debug)]
pub enum StateError {
    Invalid(String),
    SecretRejected(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid state: {m}"),
            Self::SecretRejected(m) => write!(f, "refused to persist secret material: {m}"),
            Self::Io(e) => write!(f, "state io error: {e}"),
            Self::Json(e) => write!(f, "state json error: {e}"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<io::Error> for StateError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDaemonState {
    pub terminal_id: String,
    pub server_url: String,
    pub protocol_version: String,
    pub last_heartbeat_at: Option<u64>,
    pub last_rtt_ms: Option<u64>,
    pub consecutive_failures: u32,
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn temp_nonce() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        nanos,
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn contains_forbidden_secret(serialized: &str) -> bool {
    let lower = serialized.to_ascii_lowercase();
    serialized.contains(TERMINAL_TOKEN_PREFIX)
        || serialized.contains(BOT_TOKEN_PREFIX)
        || lower.contains("bearer ")
}

/// Atomically persists `state` to `path` (`0600` permissions, temp-file + `sync_all` + `rename`).
pub fn save_state_atomic(path: &Path, state: &PersistedDaemonState) -> Result<(), StateError> {
    let Some(parent) = path.parent() else {
        return Err(StateError::Invalid(
            "state path must have a parent directory".into(),
        ));
    };
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Err(StateError::Invalid(
            "state path must have a valid UTF-8 file name".into(),
        ));
    };

    let bytes = serde_json::to_vec_pretty(state)?;
    let as_str = std::str::from_utf8(&bytes)
        .map_err(|_| StateError::Invalid("serialized state is not valid UTF-8".into()))?;
    if contains_forbidden_secret(as_str) {
        return Err(StateError::SecretRejected(
            "state.json must never contain raw tokens or bearer credentials".into(),
        ));
    }

    if !parent.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(parent)?;
    }

    let tmp_path: PathBuf = parent.join(format!(".{file_name}.{}.tmp", temp_nonce()));
    let write_res = (|| -> Result<(), StateError> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(&tmp_path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);

        #[cfg(unix)]
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;

        fs::rename(&tmp_path, path)?;

        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_res
}

/// Loads persisted daemon state from `path`, returning `Ok(None)` if not yet written.
pub fn load_state(path: &Path) -> Result<Option<PersistedDaemonState>, StateError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StateError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pwork-bot-state-{tag}-{}", temp_nonce()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_state_roundtrip_and_0600_permissions() {
        let dir = test_dir("roundtrip");
        let path = dir.join("state.json");
        assert!(load_state(&path).unwrap().is_none());

        let state = PersistedDaemonState {
            terminal_id: "term-42".into(),
            server_url: "http://127.0.0.1:3100".into(),
            protocol_version: "1.0".into(),
            last_heartbeat_at: Some(1_760_000_000),
            last_rtt_ms: Some(12),
            consecutive_failures: 0,
        };
        save_state_atomic(&path, &state).unwrap();

        let loaded = load_state(&path).unwrap().expect("state must exist");
        assert_eq!(loaded, state);

        #[cfg(unix)]
        {
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "state.json must have 0600 permissions");
        }

        // Overwrite atomically and verify no leftover temp files remain.
        let updated = PersistedDaemonState {
            consecutive_failures: 3,
            last_rtt_ms: Some(44),
            ..state
        };
        save_state_atomic(&path, &updated).unwrap();
        assert_eq!(load_state(&path).unwrap(), Some(updated));

        let entries: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(entries.len(), 1, "no temporary files should remain");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_persist_raw_tokens() {
        let dir = test_dir("no-secret");
        let path = dir.join("state.json");
        let poisoned = PersistedDaemonState {
            terminal_id: "term-1".into(),
            server_url: "http://127.0.0.1:3100/?tok=pcp_term_secret999".into(),
            protocol_version: "1.0".into(),
            last_heartbeat_at: None,
            last_rtt_ms: None,
            consecutive_failures: 0,
        };
        let err = save_state_atomic(&path, &poisoned).unwrap_err();
        assert!(matches!(err, StateError::SecretRejected(_)));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}

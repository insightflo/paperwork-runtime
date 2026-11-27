//! Secure pairing-code validation and device-credential persistence for
//! personal Paperwork endpoints.
//!
//! Security invariants:
//! - Pairing codes use an unambiguous alphabet (`0`/`O`/`1`/`I` are excluded).
//! - Credentials are persisted via temp-file + `sync_all()` + `rename()` with
//!   `0600` permissions on Unix so only the owning user can read them.
//! - Raw device tokens are never stored or logged: only a SHA-256 hash is
//!   kept, and [`mask_secret_token`] keeps any logged token fragment safe.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

/// Unambiguous pairing alphabet: uppercase alphanumerics without `0`, `O`, `1`, `I`.
const PAIRING_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// A pairing code is strictly 6 characters long.
const PAIRING_CODE_LEN: usize = 6;

/// Tokens shorter than this are fully redacted instead of partially masked.
const MASK_MIN_LEN: usize = 12;

/// Leading characters kept when masking a long token.
const MASK_KEEP_HEAD: usize = 4;

/// Trailing characters kept when masking a long token.
const MASK_KEEP_TAIL: usize = 4;

/// Errors produced while persisting or loading device credentials.
#[derive(Debug)]
pub enum CredentialError {
    Invalid(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid credential: {m}"),
            Self::Io(e) => write!(f, "credential io error: {e}"),
            Self::Json(e) => write!(f, "credential json error: {e}"),
        }
    }
}

impl std::error::Error for CredentialError {}

impl From<io::Error> for CredentialError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for CredentialError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

/// Normalizes a human-entered pairing code and validates it strictly.
///
/// Strips spaces and hyphens, uppercases ASCII letters, and requires exactly
/// [`PAIRING_CODE_LEN`] characters drawn from the unambiguous pairing
/// alphabet (no `0`, `O`, `1`, `I`). Returns the normalized code or a
/// rejection reason.
pub fn normalize_pairing_code(raw: &str) -> Result<String, String> {
    let mut normalized = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch == ' ' || ch == '-' {
            continue;
        }
        let upper = ch.to_ascii_uppercase();
        if !PAIRING_ALPHABET.contains(upper) {
            return Err(format!(
                "pairing code has invalid character {upper:?}: expected 6 characters from {PAIRING_ALPHABET}"
            ));
        }
        normalized.push(upper);
    }
    let len = normalized.chars().count();
    if len != PAIRING_CODE_LEN {
        return Err(format!(
            "pairing code must be exactly {PAIRING_CODE_LEN} characters, got {len}"
        ));
    }
    Ok(normalized)
}

/// A device credential issued after a successful personal-endpoint pairing.
///
/// `token_hash` holds only the SHA-256 digest of the raw device token; raw
/// tokens must never be placed in this struct or any persisted file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredential {
    pub device_id: String,
    pub bot_name: String,
    pub server_url: String,
    pub token_hash: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub allowed_folders: Vec<String>,
}

impl DeviceCredential {
    /// Returns `true` once `now_ms` has reached `expires_at_ms` (inclusive boundary).
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// Masks a bearer/device token for safe logging.
///
/// Tokens with at least [`MASK_MIN_LEN`] characters keep their first
/// [`MASK_KEEP_HEAD`] and last [`MASK_KEEP_TAIL`] characters joined by `...`
/// (e.g. `pcp_...3456`); shorter tokens are fully redacted as `***`.
pub fn mask_secret_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() < MASK_MIN_LEN {
        return "***".to_string();
    }
    let head: String = chars[..MASK_KEEP_HEAD].iter().collect();
    let tail: String = chars[chars.len() - MASK_KEEP_TAIL..].iter().collect();
    format!("{head}...{tail}")
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

/// Atomically persists `credential` to `path` as pretty JSON.
///
/// Uses temp-file + `sync_all()` + `rename()`; on Unix the file carries `0600`
/// permissions. A failed write removes the temporary file and leaves any
/// existing credential untouched.
pub fn write_credentials_atomic(
    path: &Path,
    credential: &DeviceCredential,
) -> Result<(), CredentialError> {
    let Some(parent) = path.parent() else {
        return Err(CredentialError::Invalid(
            "credential path must have a parent directory".into(),
        ));
    };
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Err(CredentialError::Invalid(
            "credential path must have a valid UTF-8 file name".into(),
        ));
    };

    let bytes = serde_json::to_vec_pretty(credential)?;

    if !parent.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(parent)?;
    }

    let tmp_path: PathBuf = parent.join(format!(".{file_name}.{}.tmp", temp_nonce()));
    let write_res = (|| -> Result<(), CredentialError> {
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

/// Loads a device credential from `path`, returning `Ok(None)` when the file
/// does not exist yet.
pub fn read_credentials(path: &Path) -> Result<Option<DeviceCredential>, CredentialError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CredentialError::Io(e)),
    }
}

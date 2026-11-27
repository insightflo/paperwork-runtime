//! Local readiness diagnostics only; performs no network or CLI execution.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorReport {
    pub ready: bool,
    pub checks: Vec<DoctorCheck>,
    pub pass_count: usize,
    pub warn_count: usize,
    pub fail_count: usize,
}
impl DoctorReport {
    pub fn format_human(&self) -> String {
        let state = if self.ready { "Ready" } else { "Not ready" };
        let mut text = format!(
            "{state}: {} passed, {} warnings, {} failed\n",
            self.pass_count, self.warn_count, self.fail_count
        );
        for check in &self.checks {
            let marker = match check.status {
                CheckStatus::Pass => "OK",
                CheckStatus::Warn => "WARN",
                CheckStatus::Fail => "FAIL",
            };
            // Keep user-controlled paths from injecting additional output lines.
            let label = check.label.replace(['\n', '\r'], " ");
            let detail = check.detail.replace(['\n', '\r'], " ");
            text.push_str(&format!("[{marker}] {label}: {detail}\n"));
        }
        text
    }
}
pub struct DoctorInput {
    pub server_url: String,
    pub config_path: PathBuf,
    pub allowed_folders: Vec<(PathBuf, String)>,
    pub outbox_dir: PathBuf,
    pub detected_clis: Vec<String>,
}
/// Check the supplied snapshot in stable order. Warnings do not block readiness.
/// Permission and write checks reflect this process's current filesystem access.
pub fn run_endpoint_doctor(input: &DoctorInput) -> DoctorReport {
    let mut checks = Vec::new();
    let mut add = |id: String, label: String, result: Result<String, String>| {
        let (status, detail) = match result {
            Ok(detail) => (CheckStatus::Pass, detail),
            Err(detail) => (CheckStatus::Fail, detail),
        };
        checks.push(DoctorCheck { id, label, status, detail });
    };
    add(
        "server_url".into(),
        "Server URL".into(),
        if valid_server_url(&input.server_url) {
            Ok("HTTPS or exact local HTTP host configured".into())
        } else {
            Err("Use a valid https:// URL, or http://127.0.0.1 / http://localhost".into())
        },
    );
    add("config".into(), "Configuration".into(), config_check(&input.config_path));
    for (index, (path, mode)) in input.allowed_folders.iter().enumerate() {
        let result = if mode != "ro" && mode != "rw" {
            Err("Unknown grant mode; use ro (read only) or rw (read/write)".into())
        } else if !path.is_dir() {
            Err("Folder is missing, inaccessible, or not a directory".into())
        } else if mode == "rw" {
            probe_write(path)
                .map(|()| "Read/write folder is writable".into())
                .map_err(|e| e.to_string())
        } else {
            Ok("Read-only folder exists".into())
        };
        add(format!("folder:{index}"), format!("Folder {} ({mode})", path.display()), result);
    }
    let outbox = &input.outbox_dir;
    let result = match fs::symlink_metadata(outbox) {
        _ if outbox.as_os_str().is_empty() => Err(io::Error::other("Outbox path is empty")),
        Ok(_) if outbox.is_dir() => probe_write(outbox),
        Ok(_) => Err(io::Error::other("Outbox is not a directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let parent =
                outbox.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            probe_write(parent)
        }
        Err(e) => Err(e),
    };
    add(
        "outbox".into(),
        "Outbox".into(),
        result.map(|()| "Outbox or its parent is writable".into()).map_err(|e| e.to_string()),
    );
    checks.push(DoctorCheck {
        id: "clis".into(),
        label: "Local CLIs".into(),
        status: if input.detected_clis.is_empty() {
            CheckStatus::Warn
        } else {
            CheckStatus::Pass
        },
        detail: if input.detected_clis.is_empty() {
            "No CLIs found; file and shell endpoints remain available".into()
        } else {
            format!("{} CLI(s) detected", input.detected_clis.len())
        },
    });
    let count = |status| checks.iter().filter(|c| c.status == status).count();
    let pass_count = count(CheckStatus::Pass);
    let warn_count = count(CheckStatus::Warn);
    let fail_count = checks.len() - pass_count - warn_count;
    DoctorReport { ready: fail_count == 0, checks, pass_count, warn_count, fail_count }
}
fn config_check(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot access {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err("Configuration must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("Config is open to group/others; restrict permissions to 0600".into());
        }
    }
    Ok("Configuration exists; Unix permissions checked where supported".into())
}

fn valid_server_url(url: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, suffix) = if let Some(ip) = authority.strip_prefix('[') {
        let Some((host, suffix)) = ip.split_once(']') else {
            return false;
        };
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        (host, suffix)
    } else {
        let host = authority.split(':').next().unwrap_or_default();
        if host.is_empty()
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
        {
            return false;
        }
        (host, &authority[host.len()..])
    };
    if !suffix.is_empty()
        && !suffix.strip_prefix(':').is_some_and(|p| {
            !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok()
        })
    {
        return false;
    }
    scheme == "https" || host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost")
}

fn probe_write(dir: &Path) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let meta = fs::metadata(dir)?;
    if !meta.is_dir() {
        return Err(io::Error::other("Path is not a directory"));
    }
    #[cfg(unix)]
    if meta.permissions().readonly() {
        return Err(io::Error::other("Directory is not writable"));
    }
    for _ in 0..16 {
        let path = dir.join(format!(
            ".paperwork-doctor-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = file.write_all(b"\n");
        drop(file); // Windows requires closing the handle before deleting the probe.
        let removed = fs::remove_file(&path);
        return written.and(removed);
    }
    Err(io::Error::other("Could not reserve a write probe"))
}

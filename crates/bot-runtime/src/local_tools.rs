//! Fail-closed local file / shell / CLI execution primitives for the personal endpoint bot.
//! All filesystem access is confined to granted folders ([`FolderGrant`]) via canonical-path
//! containment: symlink-following, `..` rejection, read-only enforcement, atomic writes.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Access mode of a granted folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderMode {
    Ro,
    Rw,
}

/// A granted folder root and its access mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderGrant {
    pub path: PathBuf,
    pub mode: FolderMode,
}

/// Resolves `target` against `grants` and returns the canonical confined path. Existing targets
/// are canonicalized (following symlinks); not-yet-existing targets resolve against their
/// nearest existing ancestor plus the remaining components (rejecting any `..`/root/prefix
/// component in the unresolved suffix). Fails closed with `path_outside_allowed_folders` when
/// no granted root contains the resolved path, or `folder_read_only` when the containing grant
/// is `Ro` but `require_write` is set. Overlapping grants resolve to the most restrictive mode.
pub fn resolve_confined_path(
    grants: &[FolderGrant],
    target: &Path,
    require_write: bool,
) -> Result<PathBuf, String> {
    let resolved = resolve_target_path(target)
        .ok_or_else(|| "path_outside_allowed_folders".to_string())?;
    let mut allowed = false;
    let mut read_only = false;
    for grant in grants {
        let Ok(root) = fs::canonicalize(&grant.path) else { continue }; // nonexistent root grants nothing
        if !resolved.starts_with(&root) {
            continue;
        }
        allowed = true;
        read_only |= grant.mode == FolderMode::Ro;
    }
    if read_only && require_write { return Err("folder_read_only".into()); }
    if allowed { Ok(resolved) } else { Err("path_outside_allowed_folders".into()) }
}

/// Canonicalizes an existing `target`, or resolves it against its nearest existing ancestor
/// plus the remaining (strictly normal) components. Relative targets anchor to the process cwd.
/// Returns `None` when the path cannot be resolved safely (fail closed).
fn resolve_target_path(target: &Path) -> Option<PathBuf> {
    let target = if target.is_relative() {
        std::env::current_dir().ok()?.join(target)
    } else {
        target.to_path_buf()
    };
    if let Ok(canonical) = fs::canonicalize(&target) {
        return Some(canonical);
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut ancestor = target;
    while !ancestor.as_os_str().is_empty() && !ancestor.exists() {
        match ancestor.components().next_back()? {
            Component::Normal(name) => suffix.push(name.to_os_string()),
            _ => return None, // `..`, root, or prefix component in unresolved suffix
        }
        ancestor = ancestor.parent()?.to_path_buf();
    }
    let mut resolved = fs::canonicalize(ancestor).ok()?;
    for name in suffix.into_iter().rev() {
        resolved.push(name);
    }
    Some(resolved)
}

/// Reads a file inside an allowed folder, bounded by `max_bytes`.
pub fn read_local_file(
    grants: &[FolderGrant],
    target: &Path,
    max_bytes: usize,
) -> Result<String, String> {
    let resolved = resolve_confined_path(grants, target, false)?;
    let meta = fs::metadata(&resolved).map_err(|e| format!("file_stat_failed: {e}"))?;
    if meta.len() > max_bytes as u64 { return Err("file_exceeds_max_bytes".into()); }    let bytes = fs::read(&resolved).map_err(|e| format!("file_read_failed: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "file_not_valid_utf8".to_string())
}

static WRITE_TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Atomically writes `content` to `target` (temp file in the same directory, then rename).
/// Parent directories are created only inside the granted `Rw` root.
pub fn write_local_file(
    grants: &[FolderGrant],
    target: &Path,
    content: &[u8],
) -> Result<PathBuf, String> {
    let resolved = resolve_confined_path(grants, target, true)?;
    if resolved.is_dir() { return Err("target_is_directory".into()); }
    let parent = resolved.parent().ok_or("invalid_target_path")?.to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| format!("parent_dir_create_failed: {e}"))?;
    let temp = parent.join(format!(
        ".local-tools-{}-{}.tmp",
        std::process::id(),
        WRITE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = fs::write(&temp, content) {
        let _ = fs::remove_file(&temp);
        return Err(format!("temp_write_failed: {e}"));
    }
    if let Err(e) = fs::rename(&temp, &resolved) {
        let _ = fs::remove_file(&temp);
        return Err(format!("atomic_rename_failed: {e}"));
    }
    Ok(resolved)
}

/// One entry of [`list_local_dir`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
}

/// Lists a directory inside an allowed folder, sorted deterministically by name, capped at `max_entries`.
pub fn list_local_dir(
    grants: &[FolderGrant],
    target: &Path,
    max_entries: usize,
) -> Result<Vec<LocalDirEntry>, String> {
    let resolved = resolve_confined_path(grants, target, false)?;
    if !resolved.is_dir() { return Err("not_a_directory".into()); }
    let read_err = |e: std::io::Error| format!("dir_read_failed: {e}");
    let mut entries = Vec::new();
    for entry in fs::read_dir(&resolved).map_err(read_err)? {
        let entry = entry.map_err(read_err)?;
        let is_dir = entry.file_type().map_err(read_err)?.is_dir();
        let size_bytes = entry.metadata().map_err(read_err)?.len();
        entries.push(LocalDirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir,
            size_bytes,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries.truncate(max_entries);
    Ok(entries)
}

/// Result of [`run_local_shell`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Runs `command` via `sh -c` (Unix) / `cmd /C` (Windows) with `cwd` confined to an allowed
/// `Rw` folder. Kills the child on `timeout_ms` (reporting `timed_out`) and truncates
/// stdout/stderr to `max_output_bytes`.
pub fn run_local_shell(
    grants: &[FolderGrant],
    cwd: &Path,
    command: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> Result<ShellExecResult, String> {
    let confined_cwd = resolve_confined_path(grants, cwd, true)?;
    let (program, flag) = if cfg!(windows) { ("cmd", "/C") } else { ("sh", "-c") };
    let mut cmd = Command::new(program);
    cmd.args([flag, command]);
    cmd.current_dir(&confined_cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("shell_spawn_failed: {e}"))?;
    let stdout_pipe = child.stdout.take().ok_or("shell_pipe_failed")?;
    let stderr_pipe = child.stderr.take().ok_or("shell_pipe_failed")?;
    let stdout_thread = std::thread::spawn(move || drain_capped(stdout_pipe, max_output_bytes));
    let stderr_thread = std::thread::spawn(move || drain_capped(stderr_pipe, max_output_bytes));

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| format!("shell_wait_failed: {e}"))? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            timed_out = true;
            break child.wait().map_err(|e| format!("shell_wait_failed: {e}"))?;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let stdout_bytes = stdout_thread.join().map_err(|_| "shell_output_join_failed".to_string())?;
    let stderr_bytes = stderr_thread.join().map_err(|_| "shell_output_join_failed".to_string())?;
    Ok(ShellExecResult {
        exit_code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        timed_out,
    })
}

/// Reads `reader` to EOF, keeping at most `cap` bytes (draining the rest).
fn drain_capped<R: Read>(mut reader: R, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8_192];
    while let Ok(n) = reader.read(&mut chunk) {
        if n == 0 { break; }        let take = cap.saturating_sub(buf.len()).min(n);
        buf.extend_from_slice(&chunk[..take]);
    }
    buf
}

/// Known AI-coding CLI binaries probed for local auto-discovery.
const DETECTED_CLI_TABLE: &[(&str, &str)] = &[
    ("pi", "pi"), ("claude", "claude"), ("codex", "codex"), ("agy", "agy"),
    ("opencode", "opencode"), ("cursor", "cursor"), ("gemini", "gemini"),
];

/// One probed CLI and whether an executable binary was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedCli {
    pub id: &'static str,
    pub binary: &'static str,
    pub path: Option<PathBuf>,
    pub available: bool,
}

/// Probes the known CLIs inside `path_dirs` (first executable hit wins per binary).
pub fn detect_local_clis_in_dirs(path_dirs: &[PathBuf]) -> Vec<DetectedCli> {
    DETECTED_CLI_TABLE
        .iter()
        .map(|&(id, binary)| {
            let path = path_dirs.iter().find_map(|dir| {
                candidate_binaries(binary)
                    .into_iter()
                    .map(|name| dir.join(name))
                    .find(|p| is_executable_file(p))
            });
            DetectedCli { id, binary, available: path.is_some(), path }
        })
        .collect()
}

/// Probes the known CLIs on the process `PATH`.
pub fn detect_local_clis() -> Vec<DetectedCli> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    detect_local_clis_in_dirs(&dirs)
}

/// Candidate file names for `binary` on this platform.
fn candidate_binaries(binary: &str) -> Vec<String> {
    if cfg!(windows) {
        [".exe", ".cmd", ".bat"].iter().map(|e| format!("{binary}{e}")).collect()
    } else {
        vec![binary.to_string()]
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file())
}

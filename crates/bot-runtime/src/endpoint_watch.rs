//! Workspace snapshot & file-change detection for the personal endpoint bot.
//!
//! [`scan_workspace`] fingerprints every regular file under one whitelisted
//! workspace root (relative path, size, mtime in ms) and [`diff_snapshots`]
//! compares two snapshots into sorted added/modified/removed path lists. The
//! walker is deliberately conservative: it never follows symlinks (a symlinked
//! directory could escape or loop the whitelist; a symlinked file's size/mtime
//! would describe the target, not the link), skips configured ignored
//! directories at any depth, and caps both traversal depth and file count so a
//! huge or adversarial tree cannot exhaust the daemon. Capped scans report
//! `truncated = true` instead of failing, so callers can treat the result as a
//! lower bound. Entries are sorted by relative path, making snapshots and
//! diffs deterministic for identical trees.
//!
//! This module is self-contained on purpose: it compiles standalone (including
//! via `#[path]` test includes) without touching `lib.rs`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Fingerprint of one regular file, keyed by its `/`-separated path relative
/// to the workspace root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFingerprint {
    pub rel_path: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

/// Bounds for a single workspace scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchLimits {
    /// Maximum directory levels below the root an entry may occupy
    /// (`0` = only files directly inside the root).
    pub max_depth: usize,
    /// Maximum number of files fingerprinted per scan; further files mark the
    /// snapshot `truncated` instead of being collected.
    pub max_files: usize,
    /// Directory names (matched at any depth) that are never descended into.
    pub ignored_dirs: Vec<String>,
}

impl Default for WatchLimits {
    fn default() -> Self {
        Self {
            max_depth: 12,
            max_files: 50_000,
            ignored_dirs: [".git", "node_modules", "target", "dist", ".next"]
                .iter()
                .map(|name| name.to_string())
                .collect(),
        }
    }
}

/// Point-in-time listing of every fingerprinted file under one workspace root.
/// `entries` is sorted by `rel_path`; `truncated` marks a lower bound.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub entries: Vec<FileFingerprint>,
    pub truncated: bool,
}

/// Change report between two snapshots; every list is sorted by relative path.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkspaceDiff {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

impl WorkspaceDiff {
    /// True when both snapshots describe the identical set of file states.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

/// Scans `root` into a deterministic snapshot.
///
/// Fails closed: the root must exist, be a real directory, and must not
/// itself be a symlink (following it could scan outside the whitelist).
/// Symlinks found inside the tree are skipped silently; ignored directories
/// are configuration, so skipping them does not set `truncated`.
pub fn scan_workspace(root: &Path, limits: &WatchLimits) -> Result<WorkspaceSnapshot, String> {
    let meta = fs::symlink_metadata(root)
        .map_err(|e| format!("workspace root {} is not accessible: {e}", root.display()))?;
    if meta.is_symlink() {
        return Err(format!("workspace root {} is a symlink; refusing to follow it", root.display()));
    }
    if !meta.is_dir() {
        return Err(format!("workspace root {} is not a directory", root.display()));
    }
    let mut snapshot = WorkspaceSnapshot {
        root: root.to_string_lossy().into_owned(),
        entries: Vec::new(),
        truncated: false,
    };
    walk_dir(root, "", 0, limits, &mut snapshot.entries, &mut snapshot.truncated)?;
    snapshot.entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(snapshot)
}

/// Compares two snapshots by relative path. A file is `modified` when its
/// size or mtime changed (name and content identity come from the caller's
/// snapshot cadence, so re-scanning after edits is detected even when only
/// the mtime moved).
pub fn diff_snapshots(prev: &WorkspaceSnapshot, next: &WorkspaceSnapshot) -> WorkspaceDiff {
    let prev_by_path: HashMap<&str, &FileFingerprint> =
        prev.entries.iter().map(|e| (e.rel_path.as_str(), e)).collect();
    let next_by_path: HashMap<&str, &FileFingerprint> =
        next.entries.iter().map(|e| (e.rel_path.as_str(), e)).collect();
    let mut diff = WorkspaceDiff::default();
    for (path, fingerprint) in &next_by_path {
        match prev_by_path.get(path) {
            None => diff.added.push((*path).to_string()),
            Some(old) => {
                if old.size_bytes != fingerprint.size_bytes
                    || old.modified_ms != fingerprint.modified_ms
                {
                    diff.modified.push((*path).to_string());
                }
            }
        }
    }
    for path in prev_by_path.keys() {
        if !next_by_path.contains_key(path) {
            diff.removed.push((*path).to_string());
        }
    }
    diff.added.sort();
    diff.modified.sort();
    diff.removed.sort();
    diff
}

/// Recurses one directory. `rel_prefix` is the entries' parent path relative
/// to the root ("" for the root itself); `depth` counts directory levels the
/// entries inside `dir` occupy, starting at 0. Once the file cap is reached,
/// remaining siblings stop contributing and `truncated` is latched.
fn walk_dir(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    limits: &WatchLimits,
    out: &mut Vec<FileFingerprint>,
    truncated: &mut bool,
) -> Result<(), String> {
    let mut children: Vec<std::path::PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("failed to list directory {}: {e}", dir.display()))?;
    children.sort();
    for child in children {
        // symlink_metadata, not metadata: never resolve the final component,
        // so symlinked dirs cannot be entered and symlinked files skipped.
        let meta = fs::symlink_metadata(&child)
            .map_err(|e| format!("failed to stat {}: {e}", child.display()))?;
        if meta.is_symlink() {
            continue;
        }
        let name = child
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| format!("failed to name {}", child.display()))?;
        if meta.is_dir() {
            if limits.ignored_dirs.iter().any(|ignored| ignored == &name) {
                continue;
            }
            if depth + 1 > limits.max_depth {
                // Descending would exceed the depth cap; the subtree is
                // treated as unobserved even if it turns out to be empty.
                *truncated = true;
                continue;
            }
            walk_dir(&child, &join_rel(rel_prefix, &name), depth + 1, limits, out, truncated)?;
        } else if out.len() >= limits.max_files {
            *truncated = true;
            return Ok(());
        } else {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since_epoch| since_epoch.as_millis() as u64)
                .unwrap_or(0);
            out.push(FileFingerprint {
                rel_path: join_rel(rel_prefix, &name),
                size_bytes: meta.len(),
                modified_ms,
            });
        }
    }
    Ok(())
}

/// Joins one entry name onto its parent's root-relative path with `/`.
fn join_rel(rel_prefix: &str, name: &str) -> String {
    if rel_prefix.is_empty() {
        name.to_string()
    } else {
        format!("{rel_prefix}/{name}")
    }
}

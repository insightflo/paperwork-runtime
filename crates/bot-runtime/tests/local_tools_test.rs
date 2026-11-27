//! Integration tests for the fail-closed local file / shell / CLI execution engine
//! (`local_tools`): folder-grant confinement, atomic writes, shell confinement +
//! timeout kill, and CLI auto-discovery.
#![cfg(unix)]

// This test only uses `TempDir` from the shared helpers; silence the rest for this target.
#[allow(dead_code)]
mod common;

use common::TempDir;
use paperwork_bot_runtime::local_tools::{
    detect_local_clis_in_dirs, list_local_dir, read_local_file, resolve_confined_path,
    run_local_shell, write_local_file, FolderGrant, FolderMode,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn grant(dir: &Path, mode: FolderMode) -> FolderGrant {
    FolderGrant {
        path: dir.to_path_buf(),
        mode,
    }
}

fn make_ro_rw(tmp: &TempDir) -> (PathBuf, PathBuf) {
    let ro = tmp.join("ro");
    let rw = tmp.join("rw");
    fs::create_dir_all(&ro).expect("ro dir");
    fs::create_dir_all(&rw).expect("rw dir");
    (ro, rw)
}

#[test]
fn read_only_grant_allows_read_and_list_but_blocks_write() {
    let tmp = TempDir::new("lt-ro");
    let (ro, _rw) = make_ro_rw(&tmp);
    fs::write(ro.join("a.txt"), "alpha").expect("fixture");
    let grants = [grant(&ro, FolderMode::Ro)];

    assert_eq!(
        read_local_file(&grants, &ro.join("a.txt"), 1024).unwrap(),
        "alpha"
    );
    let entries = list_local_dir(&grants, &ro, 10).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "a.txt");
    assert!(!entries[0].is_dir);

    let err = write_local_file(&grants, &ro.join("b.txt"), b"beta").unwrap_err();
    assert_eq!(err, "folder_read_only");
    assert!(!ro.join("b.txt").exists(), "blocked write must leave no file");
}

#[test]
fn rw_grant_allows_read_write_list_and_atomic_creation() {
    let tmp = TempDir::new("lt-rw");
    let (_ro, rw) = make_ro_rw(&tmp);
    let grants = [grant(&rw, FolderMode::Rw)];

    let written = write_local_file(&grants, &rw.join("nested/deep/x.txt"), b"v1").unwrap();
    assert_eq!(written.file_name().unwrap(), "x.txt");
    assert!(
        rw.join("nested/deep/x.txt").is_file(),
        "parent dirs created inside grant"
    );
    assert_eq!(read_local_file(&grants, &written, 64).unwrap(), "v1");

    write_local_file(&grants, &rw.join("nested/deep/x.txt"), b"v2-replaced").unwrap();
    assert_eq!(
        read_local_file(&grants, &rw.join("nested/deep/x.txt"), 64).unwrap(),
        "v2-replaced"
    );

    fs::write(rw.join("b.txt"), "bb").expect("fixture");
    fs::write(rw.join("a.txt"), "aa").expect("fixture");
    let entries = list_local_dir(&grants, &rw, 10).unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"a.txt") && names.contains(&"b.txt") && names.contains(&"nested"));
    assert_eq!(names.first(), Some(&"a.txt"), "deterministic name sort");
    let nested = entries.iter().find(|e| e.name == "nested").unwrap();
    assert!(nested.is_dir);
    let file = entries.iter().find(|e| e.name == "a.txt").unwrap();
    assert_eq!(file.size_bytes, 2);

    let err = read_local_file(&grants, &rw.join("a.txt"), 1).unwrap_err();
    assert_eq!(err, "file_exceeds_max_bytes");
}

#[test]
fn traversal_and_symlink_escapes_are_rejected() {
    let tmp = TempDir::new("lt-escape");
    let (_ro, rw) = make_ro_rw(&tmp);
    let grants = [grant(&rw, FolderMode::Rw)];

    for evil in ["../escape.txt", "missing/../escape2.txt"] {
        let err = resolve_confined_path(&grants, &rw.join(evil), false).unwrap_err();
        assert_eq!(err, "path_outside_allowed_folders", "traversal via {evil}");
    }
    let err = write_local_file(&grants, &rw.join("../escape.txt"), b"x").unwrap_err();
    assert_eq!(err, "path_outside_allowed_folders");

    let outside = tmp.join("outside");
    fs::create_dir_all(&outside).expect("outside dir");
    fs::write(outside.join("secret.txt"), "s3cret").expect("secret fixture");
    std::os::unix::fs::symlink(&outside, rw.join("door")).expect("symlink");
    let err = read_local_file(&grants, &rw.join("door/secret.txt"), 64).unwrap_err();
    assert_eq!(err, "path_outside_allowed_folders", "symlink escape");
}

#[test]
fn shell_exec_is_confined_and_killed_on_timeout() {
    let tmp = TempDir::new("lt-shell");
    let (ro, rw) = make_ro_rw(&tmp);
    let grants = [grant(&ro, FolderMode::Ro), grant(&rw, FolderMode::Rw)];

    let ok = run_local_shell(&grants, &rw, "echo hello", 5_000, 4_096).unwrap();
    assert_eq!(ok.exit_code, 0);
    assert_eq!(ok.stdout, "hello\n");
    assert!(!ok.timed_out);

    run_local_shell(&grants, &rw, "echo confined > made.txt", 5_000, 4_096).unwrap();
    assert_eq!(
        read_local_file(&grants, &rw.join("made.txt"), 64).unwrap(),
        "confined\n"
    );

    let outside = tmp.join("no-grant");
    fs::create_dir_all(&outside).expect("no-grant dir");
    let err = run_local_shell(&grants, &outside, "true", 1_000, 1_024).unwrap_err();
    assert_eq!(err, "path_outside_allowed_folders");
    let err = run_local_shell(&grants, &ro, "true", 1_000, 1_024).unwrap_err();
    assert_eq!(err, "folder_read_only");

    let started = Instant::now();
    let killed = run_local_shell(&grants, &rw, "sleep 5", 300, 1_024).unwrap();
    assert!(killed.timed_out, "child must be reported as timed out");
    assert_ne!(killed.exit_code, 0);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "timeout must kill the child promptly"
    );

    let capped =
        run_local_shell(&grants, &rw, "head -c 200 /dev/zero | tr '\\0' 'a'", 5_000, 10).unwrap();
    assert_eq!(capped.stdout.len(), 10, "stdout truncated to max_output_bytes");
}

#[test]
fn detect_local_clis_in_dirs_detects_executables_only() {
    let tmp = TempDir::new("lt-detect");
    fs::write(tmp.join("pi"), "#!/bin/sh\n").expect("fixture");
    fs::set_permissions(tmp.join("pi"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(tmp.join("claude"), "not executable").expect("fixture");
    fs::set_permissions(tmp.join("claude"), fs::Permissions::from_mode(0o644)).unwrap();

    let found = detect_local_clis_in_dirs(&[tmp.path().to_path_buf()]);
    assert_eq!(found.len(), 7);

    let pi = found.iter().find(|c| c.id == "pi").expect("pi probed");
    assert!(pi.available);
    assert_eq!(pi.binary, "pi");
    assert_eq!(pi.path.as_deref(), Some(tmp.join("pi").as_path()));

    for id in ["claude", "codex", "agy", "opencode", "cursor", "gemini"] {
        let cli = found.iter().find(|c| c.id == id).expect("cli probed");
        assert!(!cli.available, "{id} must not be detected");
        assert_eq!(cli.path, None);
    }
}

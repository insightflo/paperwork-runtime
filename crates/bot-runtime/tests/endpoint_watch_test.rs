//! TDD tests for the workspace snapshot & file-change detector.
//! Included by path so this suite exercises the exact `src/endpoint_watch.rs`
//! source without any `lib.rs` registration.
#[path = "../src/endpoint_watch.rs"]
mod endpoint_watch;

use endpoint_watch::*;
use std::fs;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("paperwork-watch-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create fixture root");
        Fixture { root }
    }

    /// Writes one fixture file, creating intermediate directories as needed.
    fn file(&self, rel: &str, contents: &str) -> &Self {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().expect("rel has a parent")).expect("mkdir for file");
        fs::write(&path, contents).expect("write fixture file");
        self
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn limits(max_depth: usize, max_files: usize) -> WatchLimits {
    WatchLimits { max_depth, max_files, ignored_dirs: WatchLimits::default().ignored_dirs }
}

fn scan(fx: &Fixture, limits: &WatchLimits) -> WorkspaceSnapshot {
    scan_workspace(&fx.root, limits).expect("scan succeeds")
}

fn names(snap: &WorkspaceSnapshot) -> Vec<String> {
    snap.entries.iter().map(|e| e.rel_path.clone()).collect()
}

#[test]
fn initial_scan_sorts_entries_by_rel_path() {
    let fx = Fixture::new("sort");
    fx.file("b.txt", "bee").file("a.txt", "ay").file("sub/c.txt", "see");
    let snap = scan(&fx, &limits(4, 100));
    assert_eq!(snap.root, fx.root.to_string_lossy());
    assert_eq!(names(&snap), ["a.txt", "b.txt", "sub/c.txt"]);
    assert!(!snap.truncated);
}

#[test]
fn ignores_default_ignored_dirs_at_any_depth() {
    let fx = Fixture::new("ignored");
    fx.file(".git/config", "x").file("node_modules/pkg/i.js", "x");
    fx.file("target/debug/a.rlib", "x").file("dist/b.js", "x").file(".next/c.js", "x");
    fx.file("src/deep/target/d.o", "x").file("keep.rs", "fn main() {}");
    let snap = scan(&fx, &limits(8, 100));
    assert_eq!(names(&snap), ["keep.rs"]);
    assert!(!snap.truncated);
}

#[cfg(unix)]
#[test]
fn skips_symlinks_without_following_them() {
    let fx = Fixture::new("symlink");
    let outside = std::env::temp_dir().join(format!("paperwork-watch-out-{}-sym", std::process::id()));
    fs::create_dir_all(&outside).expect("mkdir outside");
    fs::write(outside.join("secret.txt"), "must not be scanned").expect("write outside file");
    fx.file("real.txt", "real");
    std::os::unix::fs::symlink(&outside, fx.root.join("linked-dir")).expect("symlink dir");
    std::os::unix::fs::symlink(outside.join("secret.txt"), fx.root.join("linked-file")).expect("symlink file");
    let snap = scan(&fx, &limits(4, 100));
    assert_eq!(names(&snap), ["real.txt"]);
    let _ = fs::remove_dir_all(&outside);
}

#[cfg(unix)]
#[test]
fn rejects_symlink_root_fail_closed() {
    let fx = Fixture::new("symroot");
    let outside = std::env::temp_dir().join(format!("paperwork-watch-out-{}-root", std::process::id()));
    fs::create_dir_all(&outside).expect("mkdir outside");
    std::os::unix::fs::symlink(&outside, fx.root.join("alias")).expect("symlink root");
    let result = scan_workspace(&fx.root.join("alias"), &limits(4, 100));
    assert!(result.is_err(), "symlink root must be rejected");
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn max_files_truncation_sets_flag() {
    let fx = Fixture::new("cap");
    fx.file("a.txt", "1").file("b.txt", "2").file("c.txt", "3");
    let snap = scan(&fx, &limits(4, 2));
    assert_eq!(names(&snap), ["a.txt", "b.txt"]);
    assert!(snap.truncated, "cap exceeded must set truncated");
}

#[test]
fn exact_file_cap_does_not_truncate() {
    let fx = Fixture::new("exactcap");
    fx.file("a.txt", "1").file("b.txt", "2").file("c.txt", "3");
    let snap = scan(&fx, &limits(4, 3));
    assert_eq!(names(&snap), ["a.txt", "b.txt", "c.txt"]);
    assert!(!snap.truncated, "exact cap must not set truncated");
}

#[test]
fn max_depth_caps_traversal_and_sets_flag() {
    let fx = Fixture::new("depth");
    fx.file("a.txt", "1").file("sub/b.txt", "2").file("sub/deep/c.txt", "3");
    let snap = scan(&fx, &limits(1, 100));
    assert_eq!(names(&snap), ["a.txt", "sub/b.txt"]);
    assert!(snap.truncated, "depth cap must set truncated");
}

#[test]
fn rejects_missing_root() {
    let missing = std::env::temp_dir().join(format!("paperwork-watch-absent-{}", std::process::id()));
    let _ = fs::remove_dir_all(&missing);
    assert!(scan_workspace(&missing, &limits(4, 100)).is_err());
}

#[test]
fn rejects_non_directory_root() {
    let fx = Fixture::new("fileroot");
    fs::write(fx.root.join("plain.txt"), "not a dir").expect("write plain file");
    assert!(scan_workspace(&fx.root.join("plain.txt"), &limits(4, 100)).is_err());
}

#[test]
fn diff_reports_added_modified_and_removed() {
    let fx = Fixture::new("diff");
    fx.file("keep.txt", "v1").file("gone.txt", "bye");
    let prev = scan(&fx, &limits(4, 100));
    fx.file("keep.txt", "v2 with more bytes").file("new.txt", "hello");
    fs::remove_file(fx.root.join("gone.txt")).expect("remove gone.txt");
    let next = scan(&fx, &limits(4, 100));
    let diff = diff_snapshots(&prev, &next);
    assert_eq!(diff.added, ["new.txt"]);
    assert_eq!(diff.modified, ["keep.txt"]);
    assert_eq!(diff.removed, ["gone.txt"]);
    assert!(!diff.is_empty());
}

#[test]
fn identical_snapshots_have_empty_diff() {
    let fx = Fixture::new("samediff");
    fx.file("a.txt", "same").file("sub/b.txt", "same");
    let first = scan(&fx, &limits(4, 100));
    let second = scan(&fx, &limits(4, 100));
    let diff = diff_snapshots(&first, &second);
    assert!(diff.is_empty());
    assert_eq!(diff.added, [""; 0]);
    assert_eq!(diff.modified, [""; 0]);
    assert_eq!(diff.removed, [""; 0]);
}

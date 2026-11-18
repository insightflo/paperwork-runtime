// crates/qa-file-owner/tests/guard_locking.rs
//
// Real-process guard/flock tests — lockRoot/target validation, kernel lock exclusion
// and handoff, guard file invariants, lock release on exit paths.

mod common;
use common::*;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;

#[test]
fn exclusion_lock_wait_serial_handoff_modes_and_no_leftovers() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let a = ws.file("a.md", b"before a\n", 0o600);
    let b = ws.file("b.md", b"before b\n", 0o640);
    let mut h1 = spawn_helper(&[]);
    assert!(h1.begin_ok(&lock_root, &[&a, &b]).is_empty());

    let mut h2 = spawn_helper(&[]);
    h2.send_frame(&json!({
        "v": 1, "id": "begin-2", "op": "begin", "lockRoot": lock_root, "targets": [a.clone(), b.clone()],
    }));
    let ev = h2.recv();
    assert_eq!(ev["type"], json!("lock_wait"));
    assert_eq!(ev["target"], json!(a)); // sorted order — "a.md" guard contends first

    let reply = h1.publish(json!([
        pub_item(&a, b"before a\n", b"first applied\n"),
        pub_item(&b, b"before b\n", b"first b\n"),
    ]));
    assert_eq!(reply["outcome"], json!("published"));
    assert_eq!(reply["files"][0]["status"], json!("applied"));
    assert_eq!(reply["files"][0]["observedSha256"], json!(sha256_hex(b"first applied\n")));
    assert_eq!(fs::read(&a).unwrap(), b"first applied\n");
    assert_eq!(mode_of(&a), 0o600, "original mode preserved");
    assert_eq!(mode_of(&b), 0o640, "original mode preserved");
    assert_eq!(h1.close_ok(), 0);

    // second holder only becomes ready after the first released the guards
    loop {
        let f = h2.recv();
        if f["type"] == "ready" {
            assert_eq!(f["id"], json!("begin-2"));
            break;
        }
        assert_eq!(f["type"], json!("lock_wait"));
    }
    let reply2 = h2.publish(json!([pub_item(&a, b"first applied\n", b"second newer\n")]));
    assert_eq!(reply2["outcome"], json!("published"));
    assert_eq!(fs::read(&a).unwrap(), b"second newer\n");
    assert_eq!(h2.close_ok(), 0);

    // guard files are never unlinked; no temp residue anywhere
    let mut guards = ws.entries(&lock_root);
    guards.sort();
    assert_eq!(guards.len(), 2);
    assert!(guards.iter().all(|n| n.starts_with("c5-") && n.ends_with(".guard")));
    for e in ws.entries(&ws.root.to_string_lossy()) {
        assert!(!e.starts_with(".c5pub-"), "temp leftover: {e}");
    }
}

#[test]
fn sigkill_releases_kernel_flock_and_next_process_acquires() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("report.md", BEFORE, 0o600);
    let mut h1 = spawn_helper(&[]);
    h1.begin_ok(&lock_root, &[&file]);
    h1.child.kill().expect("SIGKILL");
    let status = h1.wait_status();
    assert_eq!(status.signal(), Some(libc::SIGKILL));
    let mut h2 = spawn_helper(&[]);
    h2.begin_ok(&lock_root, &[&file]);
    let reply = h2.publish(json!([pub_item(&file, BEFORE, b"after death\n")]));
    assert_eq!(reply["outcome"], json!("published"));
    assert_eq!(fs::read(&file).unwrap(), b"after death\n");
    assert_eq!(h2.close_ok(), 0);
}

#[test]
fn lock_root_validation() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    // lockRoot that is a file → bad_lock_root
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": file, "targets": [&file],
    }));
    h.expect_error("bad_lock_root", &json!("x"));
    // non-canonical lockRoot → bad_lock_root
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin",
        "lockRoot": format!("{lock_root}/../guards"), "targets": [&file],
    }));
    h.expect_error("bad_lock_root", &json!("x"));
    // missing lockRoot → internal exit 3 (os.stat OSError parity)
    let mut h = spawn_helper(&[]);
    let missing = format!("{}/nonexistent", ws.root.to_string_lossy());
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": missing, "targets": [&file],
    }));
    let f = h.recv();
    assert_eq!(f["code"], json!("internal"));
    assert_eq!(h.wait_code(), 3);
    // group/world-writable lockRoot → unsafe_lock_root
    let writable = ws.dir("open-guards", 0o777);
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": writable, "targets": [&file],
    }));
    h.expect_error("unsafe_lock_root", &json!("x"));
}

#[test]
fn targets_empty_and_duplicates_are_rejected() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    for targets in [json!([]), json!("x"), Value::Null] {
        let mut h = spawn_helper(&[]);
        h.send_frame(&json!({
            "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": targets,
        }));
        h.expect_error("targets_empty", &json!("x"));
    }
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": [&file, &file],
    }));
    h.expect_error("duplicate_targets", &json!("x"));
    // non-canonical target → bad_target
    let mut h = spawn_helper(&[]);
    let rel = format!("{}/./f", ws.root.to_string_lossy());
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": [rel],
    }));
    h.expect_error("bad_target", &json!("x"));
}

#[test]
fn symlink_target_and_lock_root_are_alias_refused() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("real.md", BEFORE, 0o600);
    let link = ws.root.join("link.md");
    std::os::unix::fs::symlink(&file, &link).expect("symlink");
    let link = link.to_string_lossy().into_owned();
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": [link],
    }));
    h.expect_error("alias_refused", &json!("x"));
    // symlinked lockRoot
    let linked_root = ws.root.join("linked-root");
    std::os::unix::fs::symlink(&lock_root, &linked_root).expect("symlink root");
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin",
        "lockRoot": linked_root.to_string_lossy(), "targets": [&file],
    }));
    h.expect_error("alias_refused", &json!("x"));
}

#[test]
fn unsafe_and_bad_guards_are_rejected() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    // 0666 guard → unsafe_guard
    let gp = guard_path(&lock_root, &file);
    fs::write(&gp, b"").expect("seed guard");
    fs::set_permissions(&gp, fs::Permissions::from_mode(0o666)).expect("chmod guard");
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": [&file],
    }));
    h.expect_error("unsafe_guard", &json!("x"));
    // hardlinked guard (nlink=2) → bad_guard
    fs::set_permissions(&gp, fs::Permissions::from_mode(0o600)).expect("chmod guard");
    let alias = format!("{}.alias", ws.root.join("guard-alias").to_string_lossy());
    fs::hard_link(&gp, &alias).expect("hardlink");
    let mut h = spawn_helper(&[]);
    h.send_frame(&json!({
        "v": 1, "id": "x", "op": "begin", "lockRoot": lock_root, "targets": [&file],
    }));
    h.expect_error("bad_guard", &json!("x"));
    fs::remove_file(&alias).expect("unlink alias");
}

#[test]
fn eof_after_begin_exits_zero_and_releases_locks() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    h.close_stdin();
    assert_eq!(h.wait_code(), 0);
    let gp = guard_path(&lock_root, &file);
    assert!(PathBuf::from(&gp).exists(), "guard file is never unlinked");
    assert!(!guard_locked(&gp), "guard lock released at process exit");
}

#[test]
fn close_replies_closed_and_releases_locks() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    assert!(guard_locked(&guard_path(&lock_root, &file)));
    assert_eq!(h.close_ok(), 0);
    let gp = guard_path(&lock_root, &file);
    assert!(PathBuf::from(&gp).exists());
    assert!(!guard_locked(&gp));
}

#[test]
fn refusal_exits_release_locks_for_the_next_process() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let mut h1 = spawn_helper(&[]);
    h1.begin_ok(&lock_root, &[&file]);
    h1.send_frame(&json!({
        "v": 1, "id": "p", "op": "publish",
        "items": [pub_item("/nonexistent-target-x", b"a", b"b")],
    }));
    h1.expect_error("item_out_of_scope", &json!("p"));
    // helper died → kernel released the guard
    assert!(!guard_locked(&guard_path(&lock_root, &file)));
    let mut h2 = spawn_helper(&[]);
    h2.begin_ok(&lock_root, &[&file]);
    assert_eq!(h2.close_ok(), 0);
}

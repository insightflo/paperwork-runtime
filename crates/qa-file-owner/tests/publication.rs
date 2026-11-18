// crates/qa-file-owner/tests/publication.rs
//
// Real-process publication tests — item validation, preflight classification,
// atomic write/held/io_error semantics under the held guard.

mod common;
use common::*;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;

#[test]
fn publish_item_validation_rejections() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f", BEFORE, 0o600);
    let other = ws.file("other.md", b"other\n", 0o600);
    let sha = sha256_hex(b"after\n");

    let cases: Vec<(Value, &'static str)> = vec![
        // items container
        (json!([]), "bad_items"),
        (json!(5), "bad_items"),
        (json!(["x"]), "bad_items"), // non-object item
        // scope / duplicates
        (json!([pub_item(&other, b"other\n", b"changed\n")]), "item_out_of_scope"),
        (json!([pub_item(&file, BEFORE, b"a\n"), pub_item(&file, BEFORE, b"b\n")]), "duplicate_items"),
        // hex fields
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE).to_uppercase(),
                 "beforeSize": BEFORE.len() as u64, "afterSha256": sha, "afterSize": 6u64,
                 "bytesB64": b64(b"after\n")}]), "bad_items"),
        (json!([{"target": file, "beforeSha256": "abc", "beforeSize": BEFORE.len() as u64,
                 "afterSha256": sha, "afterSize": 6u64, "bytesB64": b64(b"after\n")}]), "bad_items"),
        // int fields
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": true,
                 "afterSha256": sha, "afterSize": 6u64, "bytesB64": b64(b"after\n")}]), "bad_items"),
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
                 "afterSha256": sha, "afterSize": -1i64, "bytesB64": b64(b"x")}]), "bad_items"),
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
                 "afterSha256": sha, "afterSize": 1.5f64, "bytesB64": b64(b"x")}]), "bad_items"),
        // base64
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
                 "afterSha256": sha, "afterSize": 6u64, "bytesB64": "!!!not-b64!!!"}]), "bad_items"),
        (json!([{"target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
                 "afterSha256": sha, "afterSize": 6u64, "bytesB64": 123}]), "bad_items"),
    ];
    for (items, code) in cases {
        let mut h = spawn_helper(&[]);
        h.begin_ok(&lock_root, &[&file]);
        h.send_frame(&json!({"v": 1, "id": "p", "op": "publish", "items": items}));
        h.expect_error(code, &json!("p"));
    }

    // bytes_over_cap — declared identity is consistent but decoded bytes exceed 2MiB
    let big = vec![b'a'; MAX_FILE_BYTES + 1];
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    h.send_frame(&json!({
        "v": 1, "id": "p", "op": "publish",
        "items": [{
            "target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
            "afterSha256": sha256_hex(&big), "afterSize": big.len() as u64, "bytesB64": b64(&big),
        }],
    }));
    h.expect_error("bytes_over_cap", &json!("p"));

    // identity_mismatch — decoded bytes do not match declared after identity
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    h.send_frame(&json!({
        "v": 1, "id": "p", "op": "publish",
        "items": [{
            "target": file, "beforeSha256": sha256_hex(BEFORE), "beforeSize": BEFORE.len() as u64,
            "afterSha256": sha256_hex(b"different\n"), "afterSize": 10u64, "bytesB64": b64(b"x"),
        }],
    }));
    h.expect_error("identity_mismatch", &json!("p"));
}

#[test]
fn preflight_mismatch_holds_all_items_before_any_write() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let a = ws.file("a.txt", BEFORE, 0o600);
    let b = ws.file("b.txt", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&a, &b]);
    let reply = h.publish(json!([
        pub_item(&a, BEFORE, b"new a\n"),
        pub_item(&b, b"unmatched\n", b"new b\n"),
    ]));
    assert_eq!(reply["ok"], json!(false));
    assert_eq!(reply["outcome"], json!("held"));
    assert_eq!(reply["files"][0]["target"], json!(a));
    assert_eq!(reply["files"][0]["status"], json!("held"));
    assert_eq!(reply["files"][0]["detail"], json!("not written: preflight held before any write"));
    assert_eq!(reply["files"][0]["observedSha256"], json!(sha256_hex(BEFORE)));
    assert_eq!(reply["files"][1]["status"], json!("mismatch_held"));
    assert_eq!(reply["files"][1]["detail"], json!("bytes match neither before nor after identity"));
    assert!(reply["detail"].as_str().unwrap_or_default().starts_with("preflight held: "));
    // nothing was written; locks still held (helper alive and usable)
    assert_eq!(fs::read(&a).unwrap(), BEFORE);
    assert_eq!(fs::read(&b).unwrap(), BEFORE);
    let good = h.publish(json!([pub_item(&a, BEFORE, b"new a\n"), pub_item(&b, BEFORE, b"new b\n")]));
    assert_eq!(good["outcome"], json!("published"));
    assert_eq!(h.close_ok(), 0);
}

#[test]
fn already_applied_is_idempotent_skip() {
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("f.txt", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    let first = h.publish(json!([pub_item(&file, BEFORE, b"fixed bytes\n")]));
    assert_eq!(first["files"][0]["status"], json!("applied"));
    let again = h.publish(json!([pub_item(&file, BEFORE, b"fixed bytes\n")]));
    assert_eq!(again["outcome"], json!("published"));
    assert_eq!(again["files"][0]["status"], json!("already_applied"));
    assert_eq!(fs::read(&file).unwrap(), b"fixed bytes\n");
    assert_eq!(h.close_ok(), 0);
}

#[test]
fn preflight_io_error_reports_without_writing() {
    if unsafe { libc::geteuid() } == 0 {
        return; // root bypasses mode bits — chmod 000 cannot produce EACCES
    }
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let file = ws.file("locked.txt", BEFORE, 0o600);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).expect("chmod 000");
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&file]);
    let reply = h.publish(json!([pub_item(&file, BEFORE, b"x\n")]));
    assert_eq!(reply["ok"], json!(false));
    assert_eq!(reply["outcome"], json!("io_error"));
    assert_eq!(reply["files"][0]["status"], json!("io_error"));
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("restore");
    assert_eq!(fs::read(&file).unwrap(), BEFORE);
    assert_eq!(h.close_ok(), 0);
}

#[test]
fn partial_write_failure_preserves_actuals_and_marks_not_attempted() {
    if unsafe { libc::geteuid() } == 0 {
        return; // root bypasses mode bits — chmod 500 cannot produce EACCES
    }
    let ws = Ws::new();
    let lock_root = ws.lock_root();
    let first = ws.file("first.txt", BEFORE, 0o600);
    let blocked_dir = ws.dir("blocked", 0o700);
    let second = format!("{blocked_dir}/second.txt");
    fs::write(&second, BEFORE).expect("write second");
    fs::set_permissions(&second, fs::Permissions::from_mode(0o600)).expect("chmod second");
    let third = ws.file("third.txt", BEFORE, 0o600);
    let mut h = spawn_helper(&[]);
    h.begin_ok(&lock_root, &[&first, &second, &third]);
    fs::set_permissions(&blocked_dir, fs::Permissions::from_mode(0o500)).expect("seal dir");
    let reply = h.publish(json!([
        pub_item(&first, BEFORE, b"one\n"),
        pub_item(&second, BEFORE, b"two\n"),
        pub_item(&third, BEFORE, b"three\n"),
    ]));
    fs::set_permissions(&blocked_dir, fs::Permissions::from_mode(0o700)).expect("unseal dir");
    assert_eq!(reply["ok"], json!(false));
    assert_eq!(reply["outcome"], json!("io_error"));
    assert_eq!(reply["files"][0]["status"], json!("applied"));
    assert_eq!(reply["files"][1]["status"], json!("io_error"));
    assert_eq!(reply["files"][2]["status"], json!("not_attempted"));
    assert_eq!(reply["files"][2]["detail"], json!("not attempted: earlier io failure"));
    assert_eq!(fs::read(&first).unwrap(), b"one\n");
    assert_eq!(fs::read(&third).unwrap(), BEFORE); // never attempted
    assert_eq!(h.close_ok(), 0);
}

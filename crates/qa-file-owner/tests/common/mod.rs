#![allow(dead_code)]
// crates/qa-file-owner/tests/common/mod.rs
//
// Shared helpers for the real-process/kernel integration tests — no mocks for FS/kernel/
// process. `cargo test` defines CARGO_BIN_EXE_* for integration targets, so the helper
// binary path is a compile-time constant: no nested build, never a stale binary.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub const BEFORE: &[u8] = b"before bytes\n";
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

pub fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_paperclip-qa-file-owner"))
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

pub fn b64(data: &[u8]) -> String {
    B64.encode(data)
}

static WS_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct Ws {
    pub root: PathBuf,
}

impl Ws {
    pub fn new() -> Ws {
        let seq = WS_SEQ.fetch_add(1, Ordering::SeqCst);
        let raw = std::env::temp_dir().join(format!("c5rust-{}-{}", std::process::id(), seq));
        fs::create_dir(&raw).expect("create workspace");
        // resolve /var→/private/var etc. so paths are canonical like the Node tests require
        Ws { root: fs::canonicalize(&raw).expect("canonical workspace") }
    }
    pub fn dir(&self, name: &str, mode: u32) -> String {
        let p = self.root.join(name);
        fs::create_dir(&p).expect("mkdir");
        fs::set_permissions(&p, fs::Permissions::from_mode(mode)).expect("chmod dir");
        p.into_os_string().into_string().expect("utf8 path")
    }
    pub fn lock_root(&self) -> String {
        self.dir("guards", 0o700)
    }
    pub fn file(&self, name: &str, bytes: &[u8], mode: u32) -> String {
        let p = self.root.join(name);
        fs::write(&p, bytes).expect("write file");
        fs::set_permissions(&p, fs::Permissions::from_mode(mode)).expect("chmod file");
        p.into_os_string().into_string().expect("utf8 path")
    }
    pub fn entries(&self, dir: &str) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read_dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect()
    }
}

impl Drop for Ws {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn guard_path(lock_root: &str, target: &str) -> String {
    format!("{}/c5-{}.guard", lock_root.trim_end_matches('/'), sha256_hex(target.as_bytes()))
}

/// True when another process still holds the flock (mirrors the Python probe, exit 42).
pub fn guard_locked(gp: &str) -> bool {
    let c = CString::new(gp.as_bytes()).expect("cstring");
    unsafe {
        let fd = libc::open(c.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
        assert!(fd >= 0, "guard file missing: {gp}");
        let r = libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB);
        if r == 0 {
            libc::flock(fd, libc::LOCK_UN);
        }
        libc::close(fd);
        r != 0
    }
}

pub fn mode_of(path: &str) -> u32 {
    fs::metadata(path).expect("metadata").permissions().mode() & 0o777
}

pub struct Helper {
    pub child: Child,
    stdin: Option<std::process::ChildStdin>,
    rx: mpsc::Receiver<Value>,
}

impl Helper {
    pub fn send_frame(&mut self, frame: &Value) {
        self.raw_write(format!("{frame}\n").as_bytes());
    }
    pub fn raw_write(&mut self, bytes: &[u8]) {
        if let Some(s) = self.stdin.as_mut() {
            let _ = s.write_all(bytes);
            let _ = s.flush();
        }
    }
    pub fn close_stdin(&mut self) {
        self.stdin.take();
    }
    pub fn recv(&self) -> Value {
        self.rx.recv_timeout(Duration::from_secs(15)).expect("timed out waiting for helper frame")
    }
    /// Send begin, collect lock_wait events, require ready.
    pub fn begin_ok(&mut self, lock_root: &str, targets: &[&str]) -> Vec<Value> {
        self.send_frame(&json!({
            "v": 1, "id": "begin-1", "op": "begin",
            "lockRoot": lock_root, "targets": targets,
        }));
        let mut events = Vec::new();
        loop {
            let f = self.recv();
            match f["type"].as_str().unwrap_or_default() {
                "lock_wait" => events.push(f),
                "ready" => {
                    assert_eq!(f["id"], json!("begin-1"));
                    return events;
                }
                other => panic!("expected ready, got {other}: {f}"),
            }
        }
    }
    pub fn publish(&mut self, items: Value) -> Value {
        self.send_frame(&json!({"v": 1, "id": "pub-1", "op": "publish", "items": items}));
        self.recv()
    }
    /// Send close, require the closed reply, then await process exit.
    pub fn close_ok(&mut self) -> i32 {
        self.send_frame(&json!({"v": 1, "id": "close-1", "op": "close"}));
        let f = self.recv();
        assert_eq!(f["type"], json!("closed"));
        assert_eq!(f["id"], json!("close-1"));
        self.wait_code()
    }
    pub fn wait_status(&mut self) -> ExitStatus {
        self.child.wait().expect("wait")
    }
    pub fn wait_code(&mut self) -> i32 {
        self.stdin.take();
        self.wait_status().code().unwrap_or(-1)
    }
    /// Refusal probe: the error frame must arrive, then exit 2.
    pub fn expect_error(&mut self, code: &str, id: &Value) {
        let f = self.recv();
        assert_eq!(f["v"], json!(1));
        assert_eq!(f["type"], json!("error"));
        assert_eq!(f["code"], json!(code), "frame: {f}");
        assert_eq!(f["id"], *id, "frame: {f}");
        assert_eq!(self.wait_code(), 2, "expected exit 2 for {code}");
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn spawn_helper(args: &[&str]) -> Helper {
    let mut child = Command::new(bin())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper binary");
    let stdout = child.stdout.take().expect("stdout pipe");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_str::<Value>(line.trim_end()) {
                        if tx.send(v).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });
    let stdin = child.stdin.take();
    Helper { child, stdin, rx }
}

pub fn pub_item(target: &str, before: &[u8], after: &[u8]) -> Value {
    json!({
        "target": target,
        "beforeSha256": sha256_hex(before),
        "beforeSize": before.len(),
        "afterSha256": sha256_hex(after),
        "afterSize": after.len(),
        "bytesB64": b64(after),
    })
}

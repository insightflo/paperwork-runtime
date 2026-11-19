use std::fs::{self, Permissions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const BIN: &str = env!("CARGO_BIN_EXE_paperclip-run-log");

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let mut p = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        p.push(format!("{prefix}-{pid}-{nanos}"));
        fs::create_dir_all(&p).expect("create temp");
        Self(fs::canonicalize(&p).expect("canonicalize"))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                let _ = fs::set_permissions(entry.path(), Permissions::from_mode(0o700));
            }
        }
        let _ = fs::set_permissions(&self.0, Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_cmd(subcmd: &str, payload: &str) -> Output {
    let mut child = Command::new(BIN)
        .arg(subcmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn paperclip-run-log");
    child.stdin.take().unwrap().write_all(payload.as_bytes()).expect("stdin");
    child.wait_with_output().expect("wait")
}

fn run_json(subcmd: &str, payload: Value) -> Value {
    let out = run_cmd(subcmd, &payload.to_string());
    assert!(out.status.success(), "{subcmd} failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("valid stdout json")
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn assert_no_tmp_files(dir: &Path) {
    for entry in fs::read_dir(dir).expect("read_dir").flatten() {
        let name = entry.file_name();
        assert!(!name.to_string_lossy().ends_with(".tmp"), "leftover tmp: {}", name.to_string_lossy());
    }
}

fn paginate_all(path: &Path, limit_bytes: usize) -> String {
    let mut offset = 0_u64;
    let mut out = String::new();
    loop {
        let res = run_json("read-range", json!({ "path": path, "offset": offset, "limitBytes": limit_bytes }));
        out.push_str(res["content"].as_str().expect("content string"));
        match res.get("nextOffset") {
            Some(next) => offset = next.as_u64().expect("nextOffset u64"),
            None => break,
        }
    }
    out
}

#[test]
fn zero_byte_and_one_byte_files_finalize_and_read() {
    let tmp = TempDir::new("run-log-small");
    let empty = tmp.0.join("empty.ndjson");
    fs::write(&empty, b"").unwrap();

    let pre = run_json("read-range", json!({ "path": &empty, "offset": 0, "limitBytes": 4096 }));
    assert_eq!(pre["content"], "");
    assert!(pre.get("nextOffset").is_none());

    let fin = run_json("finalize", json!({ "path": &empty }));
    assert_eq!(fin, json!({ "bytes": 0, "sha256": sha256_hex(b""), "compressed": true }));
    assert!(!empty.exists() && tmp.0.join("empty.ndjson.gz").exists());

    let post = run_json("read-range", json!({ "path": &empty, "offset": 0, "limitBytes": 4096 }));
    assert_eq!(post["content"], "");
    assert!(post.get("nextOffset").is_none());

    let one = tmp.0.join("one.ndjson");
    fs::write(&one, b"x").unwrap();
    let fin1 = run_json("finalize", json!({ "path": &one }));
    assert_eq!(fin1, json!({ "bytes": 1, "sha256": sha256_hex(b"x"), "compressed": true }));
    let r1 = run_json("read-range", json!({ "path": &one, "offset": 0, "limitBytes": 0 }));
    assert_eq!(r1["content"], "x");
    assert!(r1.get("nextOffset").is_none());
    assert_no_tmp_files(&tmp.0);
}

#[test]
fn multi_mb_compression_and_chunked_pagination_parity() {
    let tmp = TempDir::new("run-log-multi-mb");
    let line = "{\"ts\":\"2026-11-19T00:00:00Z\",\"stream\":\"stdout\",\"chunk\":\"hello paperclip rust run log\\n\"}\n";
    let large_data = line.repeat(48_000);
    assert!(large_data.len() > 4 * 1024 * 1024);

    let large_path = tmp.0.join("large.ndjson");
    fs::write(&large_path, large_data.as_bytes()).unwrap();
    let fin = run_json("finalize", json!({ "path": &large_path }));
    assert_eq!(fin, json!({ "bytes": large_data.len(), "sha256": sha256_hex(large_data.as_bytes()), "compressed": true }));
    assert!(!large_path.exists());
    let gz_path = tmp.0.join("large.ndjson.gz");
    assert!(fs::metadata(&gz_path).unwrap().len() < large_data.len() as u64);
    assert_eq!(paginate_all(&large_path, 512 * 1024), large_data);

    let paged_data = line.repeat(1_500);
    let paged_path = tmp.0.join("paged.ndjson");
    fs::write(&paged_path, paged_data.as_bytes()).unwrap();
    assert_eq!(paginate_all(&paged_path, 4096), paged_data);
    let _ = run_json("finalize", json!({ "path": &paged_path }));
    assert_eq!(paginate_all(&paged_path, 4096), paged_data);
    assert_no_tmp_files(&tmp.0);
}

#[test]
fn boundaries_exact_eof_and_utf8_split_parity() {
    let tmp = TempDir::new("run-log-bounds");
    let p = tmp.0.join("utf8.ndjson");
    fs::write(&p, "ab🚀cd".as_bytes()).unwrap(); // 2 + 4 + 2 = 8 bytes

    for finalized in [false, true] {
        if finalized {
            let _ = run_json("finalize", json!({ "path": &p }));
        }
        let at_eof = run_json("read-range", json!({ "path": &p, "offset": 8, "limitBytes": 16 }));
        assert_eq!(at_eof["content"], "");
        assert!(at_eof.get("nextOffset").is_none());

        let past_eof = run_json("read-range", json!({ "path": &p, "offset": 99, "limitBytes": 16 }));
        assert_eq!(past_eof["content"], "");
        assert!(past_eof.get("nextOffset").is_none());

        let exact_rem = run_json("read-range", json!({ "path": &p, "offset": 6, "limitBytes": 2 }));
        assert_eq!(exact_rem["content"], "cd");
        assert!(exact_rem.get("nextOffset").is_none());

        let first = run_json("read-range", json!({ "path": &p, "offset": 0, "limitBytes": 4 }));
        assert_eq!(first["content"], "ab\u{FFFD}");
        assert_eq!(first["nextOffset"], 4);

        let second = run_json("read-range", json!({ "path": &p, "offset": 4, "limitBytes": 10 }));
        assert_eq!(second["content"], "\u{FFFD}\u{FFFD}cd");
        assert!(second.get("nextOffset").is_none());
    }
}

#[test]
fn idempotent_finalize_and_concatenated_multi_member_gzip() {
    let tmp = TempDir::new("run-log-idem");
    let p = tmp.0.join("idem.ndjson");
    fs::write(&p, b"line-1\nline-2\n").unwrap();
    assert_eq!(run_json("finalize", json!({ "path": &p })), run_json("finalize", json!({ "path": &p })));

    let multi = tmp.0.join("multi.ndjson");
    let multi_gz = tmp.0.join("multi.ndjson.gz");
    let (part1, part2) = (b"member-one\n", b"member-two\n");
    let mut combined_gz = Vec::new();
    for part in [&part1[..], &part2[..]] {
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(part).unwrap();
        combined_gz.extend_from_slice(&enc.finish().unwrap());
    }
    fs::write(&multi_gz, &combined_gz).unwrap();

    let combined_raw = [part1.as_slice(), part2.as_slice()].concat();
    let fin = run_json("finalize", json!({ "path": &multi }));
    assert_eq!(fin, json!({ "bytes": combined_raw.len(), "sha256": sha256_hex(&combined_raw), "compressed": true }));
    let expected = String::from_utf8(combined_raw).unwrap();
    assert_eq!(paginate_all(&multi, 5), expected);
    assert_eq!(paginate_all(&multi_gz, 5), expected);
    assert_no_tmp_files(&tmp.0);
}

#[test]
fn concurrent_read_range_during_finalize_swap_never_fails() {
    let tmp = TempDir::new("run-log-race");
    let p = tmp.0.join("race.ndjson");
    let content = "0123456789abcdef\n".repeat(40_000);
    fs::write(&p, content.as_bytes()).unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let active_reads = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for tid in 0..4_usize {
        let (p_clone, expected, stop_clone, active_clone) =
            (p.clone(), content.clone(), Arc::clone(&stop), Arc::clone(&active_reads));
        handles.push(thread::spawn(move || {
            let offsets = [0_usize, 1024, 250_000, expected.len() - 100];
            let mut iter = 0_usize;
            while !stop_clone.load(Ordering::Relaxed) || iter < 6 {
                let off = offsets[(tid + iter) % offsets.len()];
                let res = run_json("read-range", json!({ "path": &p_clone, "offset": off, "limitBytes": 256 }));
                let end = (off + 256).min(expected.len());
                assert_eq!(res["content"].as_str().unwrap(), &expected[off..end]);
                assert_eq!(res.get("nextOffset").and_then(Value::as_u64).is_some(), end < expected.len());
                active_clone.fetch_add(1, Ordering::Relaxed);
                iter += 1;
            }
        }));
    }

    while active_reads.load(Ordering::Relaxed) < 8 {
        thread::yield_now();
    }
    let fin = run_json("finalize", json!({ "path": &p }));
    assert_eq!(fin, json!({ "bytes": content.len(), "sha256": sha256_hex(content.as_bytes()), "compressed": true }));
    let after_swap_target = active_reads.load(Ordering::Relaxed) + 8;
    while active_reads.load(Ordering::Relaxed) < after_swap_target {
        thread::yield_now();
    }
    stop.store(true, Ordering::Relaxed);
    for h in handles {
        h.join().expect("reader thread");
    }
    assert_no_tmp_files(&tmp.0);
}

#[test]
fn missing_file_exits_2_invalid_exits_1_and_no_tmp_leftovers() {
    let tmp = TempDir::new("run-log-err");
    let missing = tmp.0.join("missing.ndjson");
    for sub in ["finalize", "read-range"] {
        let out = run_cmd(sub, &json!({ "path": &missing }).to_string());
        assert_eq!(out.status.code(), Some(2));
        assert_eq!(serde_json::from_slice::<Value>(&out.stderr).unwrap(), json!({ "error": "not_found" }));
    }

    assert_eq!(run_cmd("unknown", "{}").status.code(), Some(1));
    assert_eq!(run_cmd("finalize", "not-json").status.code(), Some(1));
    assert_eq!(run_cmd("finalize", &json!({ "path": "" }).to_string()).status.code(), Some(1));
    assert_eq!(run_cmd("finalize", &json!({ "path": "rel.ndjson" }).to_string()).status.code(), Some(1));
    assert_eq!(run_cmd("finalize", &json!({ "path": "/tmp/a\0b.ndjson" }).to_string()).status.code(), Some(1));
    assert_eq!(run_cmd("finalize", &json!({ "path": &tmp.0 }).to_string()).status.code(), Some(1));
    assert_eq!(run_cmd("read-range", &json!({ "path": tmp.0.join("missing.ndjson.gz") }).to_string()).status.code(), Some(2));
    assert_eq!(run_cmd("finalize", &format!(r#"{{"path":"/{}"}}"#, "a".repeat(70_000))).status.code(), Some(1));

    let corrupt = tmp.0.join("corrupt.ndjson");
    fs::write(tmp.0.join("corrupt.ndjson.gz"), b"not-gzip").unwrap();
    assert_eq!(run_cmd("finalize", &json!({ "path": &corrupt }).to_string()).status.code(), Some(1));

    let ro_dir = tmp.0.join("ro");
    fs::create_dir_all(&ro_dir).unwrap();
    let ro_file = ro_dir.join("log.ndjson");
    fs::write(&ro_file, b"hello").unwrap();
    fs::set_permissions(&ro_dir, Permissions::from_mode(0o555)).unwrap();
    assert_eq!(run_cmd("finalize", &json!({ "path": &ro_file }).to_string()).status.code(), Some(1));
    assert_no_tmp_files(&ro_dir);
    assert_no_tmp_files(&tmp.0);
}

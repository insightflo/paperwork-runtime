use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_paperclip-artifact-io");

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
        fn make_writable(dir: &Path) {
            if let Ok(meta) = fs::symlink_metadata(dir) {
                if !meta.file_type().is_symlink() && meta.is_dir() {
                    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
                    if let Ok(entries) = fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            make_writable(&entry.path());
                        }
                    }
                }
            }
        }
        make_writable(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_cmd(cwd: &Path, payload: Value) -> std::process::Output {
    let mut child = Command::new(BIN)
        .arg("write")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn write");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .expect("stdin");
    child.wait_with_output().expect("wait write")
}

#[test]
fn reader_reads_exact_bytes_and_rejects_symlinks_fifo_oversize_and_root_swap() {
    let tmp = TempDir::new("artifact-io-read");
    let root = tmp.0.join("root");
    let outside = tmp.0.join("outside");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(root.join("sub/data.bin"), [0_u8, 128, 255]).unwrap();
    fs::write(outside.join("secret.txt"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leaf-link")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("dir-link")).unwrap();
    let meta = fs::metadata(&root).unwrap();

    let ok = Command::new(BIN)
        .args(["read", "sub/data.bin", &meta.dev().to_string(), &meta.ino().to_string(), "32"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(ok.status.success(), "stderr: {}", String::from_utf8_lossy(&ok.stderr));
    assert_eq!(ok.stdout, [0_u8, 128, 255]);

    for bad in ["leaf-link", "dir-link/secret.txt", "../outside/secret.txt"] {
        let out = Command::new(BIN)
            .args(["read", bad, &meta.dev().to_string(), &meta.ino().to_string(), "32"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{bad} should fail");
    }

    let small = Command::new(BIN)
        .args(["read", "sub/data.bin", &meta.dev().to_string(), &meta.ino().to_string(), "2"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(!small.status.success());

    let fifo_path = root.join("pipe.fifo");
    let mkfifo = Command::new("mkfifo").arg(&fifo_path).status().unwrap();
    assert!(mkfifo.success());
    let fifo_out = Command::new(BIN)
        .args(["read", "pipe.fifo", &meta.dev().to_string(), &meta.ino().to_string(), "32"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(!fifo_out.status.success());

    let swapped = Command::new(BIN)
        .args(["read", "sub/data.bin", &meta.dev().to_string(), &(meta.ino() + 999999).to_string(), "32"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(!swapped.status.success());
    assert!(String::from_utf8_lossy(&swapped.stderr).contains("artifact_root_replaced"));
}

#[test]
fn writer_creates_nested_readonly_tree_exclusively_and_reuses_idempotently() {
    let tmp = TempDir::new("artifact-io-write");
    let root = tmp.0.join("root");
    fs::create_dir_all(&root).unwrap();
    let root_meta = fs::metadata(&root).unwrap();
    let bytes = vec![0_u8, 128, 255, 10];
    let payload = json!({
        "dev": root_meta.dev(),
        "ino": root_meta.ino(),
        "node": {
            "name": ".",
            "exclusive": false,
            "readonly": false,
            "target": false,
            "files": [],
            "directories": [{
                "name": "runs",
                "exclusive": false,
                "readonly": false,
                "target": false,
                "files": [],
                "directories": [{
                    "name": "attempt-1",
                    "exclusive": true,
                    "readonly": false,
                    "target": true,
                    "files": [{"name": "out.bin", "base64": STANDARD.encode(&bytes)}],
                    "directories": [{
                        "name": "input",
                        "exclusive": false,
                        "readonly": true,
                        "target": false,
                        "directories": [],
                        "files": [{"name": "content.json", "base64": STANDARD.encode(br#"{"ok":true}"#)}]
                    }]
                }]
            }]
        }
    });

    let first = write_cmd(&root, payload.clone());
    assert!(first.status.success(), "stderr: {}", String::from_utf8_lossy(&first.stderr));
    let target: Value = serde_json::from_slice(&first.stdout).unwrap();
    let tmeta = fs::metadata(root.join("runs/attempt-1")).unwrap();
    assert_eq!(target["dev"], json!(tmeta.dev()));
    assert_eq!(target["ino"], json!(tmeta.ino()));
    assert_eq!(fs::read(root.join("runs/attempt-1/out.bin")).unwrap(), bytes);
    let ro_mode = fs::metadata(root.join("runs/attempt-1/input")).unwrap().permissions().mode() & 0o777;
    assert_eq!(ro_mode, 0o500);

    // Repeating exclusive attempt creation must fail closed.
    let repeat = write_cmd(&root, payload);
    assert!(!repeat.status.success());

    // writeArtifactFile idempotent reuse vs conflict
    let reuse_payload = json!({
        "dev": tmeta.dev(),
        "ino": tmeta.ino(),
        "node": {
            "name": ".", "exclusive": false, "readonly": false, "target": true,
            "directories": [],
            "files": [{"name": "out.bin", "base64": STANDARD.encode(&bytes)}]
        }
    });
    assert!(write_cmd(&root.join("runs/attempt-1"), reuse_payload).status.success());

    let conflict_payload = json!({
        "dev": tmeta.dev(),
        "ino": tmeta.ino(),
        "node": {
            "name": ".", "exclusive": false, "readonly": false, "target": true,
            "directories": [],
            "files": [{"name": "out.bin", "base64": STANDARD.encode(b"different")}]
        }
    });
    let conflict = write_cmd(&root.join("runs/attempt-1"), conflict_payload);
    assert!(!conflict.status.success());
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("artifact_file_conflict"));

    // No leaked temp files anywhere in target dir.
    for entry in fs::read_dir(root.join("runs/attempt-1")).unwrap().flatten() {
        let name = entry.file_name();
        assert!(!name.to_string_lossy().starts_with(".artifact-"));
    }
}

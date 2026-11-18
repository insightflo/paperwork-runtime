// crates/qa-file-owner/src/publish_io.rs
//
// [purpose] publish IO — preflight classification of on-disk target bytes, and the atomic
//   temp→write→fsync→fchmod→rename→readback→dir-fsync publication path.

use crate::guard::{is_link, open_eintr, realpath_lenient};
use crate::protocol::{py_err, sha256_hex, MAX_FILE_BYTES};
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::RawFd;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) struct Item {
    pub(crate) before_sha: String,
    pub(crate) after_sha: String,
    pub(crate) before_size: u64,
    pub(crate) after_size: u64,
    pub(crate) data: Vec<u8>,
}

/// One classified plan row; `detail` keeps the Python shape exactly — the integer mode for
/// "apply", the info string otherwise.
pub(crate) struct ClassRow {
    pub(crate) status: &'static str,
    pub(crate) detail: Value,
    pub(crate) digest: Option<String>,
    pub(crate) size: Option<u64>,
    pub(crate) mode: u32,
}

fn class_row(status: &'static str, detail: Value, digest: Option<String>, size: Option<u64>) -> ClassRow {
    ClassRow { status, detail, digest, size, mode: 0 }
}

fn read_capped(path: &str, cap: usize) -> io::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    let mut buf = Vec::new();
    file.by_ref().take(cap as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Classify current on-disk bytes — after: skip / before: apply / anything else: mismatch_held
/// (never written). OSError → ENOENT is "target missing", anything else is io_error.
pub(crate) fn classify(target: &str, item: &Item) -> ClassRow {
    if is_link(target) || realpath_lenient(target) != target {
        return class_row("mismatch_held", json!("target resolves through a symlink"), None, None);
    }
    let meta = match fs::metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return class_row("mismatch_held", json!("target missing"), None, None)
        }
        Err(e) => {
            return class_row("io_error", json!(format!("preflight failed: {}", py_err(&e))), None, None)
        }
    };
    if !meta.file_type().is_file() {
        return class_row("mismatch_held", json!("target is not a regular file"), None, None);
    }
    let data = match read_capped(target, MAX_FILE_BYTES + 1) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return class_row("mismatch_held", json!("target missing"), None, None)
        }
        Err(e) => {
            return class_row("io_error", json!(format!("preflight failed: {}", py_err(&e))), None, None)
        }
    };
    let digest = sha256_hex(&data);
    let size = data.len() as u64;
    if data.len() > MAX_FILE_BYTES {
        return class_row("mismatch_held", json!("current bytes exceed file cap"), Some(digest), Some(size));
    }
    if digest == item.after_sha && size == item.after_size {
        return class_row("already_applied", json!("already_applied"), Some(digest), Some(size));
    }
    if digest == item.before_sha && size == item.before_size {
        let mut row = class_row("apply", Value::Null, Some(digest), Some(size));
        row.mode = meta.mode() & 0o7777;
        row.detail = json!(row.mode); // Python: detail cell holds the integer mode for "apply"
        return row;
    }
    class_row("mismatch_held", json!("bytes match neither before nor after identity"), Some(digest), Some(size))
}

pub(crate) fn parent_str(target: &str) -> &str {
    match target.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &target[..i],
    }
}

fn fsync_fd(fd: RawFd) -> io::Result<()> {
    loop {
        if unsafe { libc::fsync(fd) } == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINTR) {
            return Err(e);
        }
    }
}

pub(crate) fn fsync_dir(dir: &str) -> io::Result<()> {
    let c = CString::new(dir.as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = open_eintr(&c, libc::O_RDONLY | libc::O_CLOEXEC, 0)?;
    let result = fsync_fd(fd);
    unsafe { libc::close(fd) };
    result
}

fn write_all_fd(fd: RawFd, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n > 0 {
            data = &data[n as usize..];
            continue;
        }
        let e = io::Error::last_os_error();
        if n < 0 && e.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if n < 0 {
            return Err(e);
        }
        return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0"));
    }
    Ok(())
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn rand_u64() -> u64 {
    let mut bytes = [0u8; 8];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        if f.read_exact(&mut bytes).is_ok() {
            return u64::from_ne_bytes(bytes);
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15)
}

/// `.c5pub-<pid>-<seq>-<rand>` exclusive temp sibling of the target (O_EXCL|O_NOFOLLOW, 0o600).
fn create_temp(dir: &str) -> io::Result<(RawFd, String)> {
    let pid = std::process::id();
    for _ in 0..128 {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let name = format!("{dir}/.c5pub-{pid}-{seq}-{:016x}", rand_u64());
        let c = CString::new(name.as_bytes())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        match open_eintr(
            &c,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        ) {
            Ok(fd) => return Ok((fd, name)),
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "could not allocate a unique temp name"))
}

/// temp → write → fsync → fchmod → rename → readback verify → dir fsync.
/// Ok(None) = written, Ok(Some(msg)) = readback mismatch (a returned failure string, like
/// Python), Err(io) = OSError during write IO. The leftover temp is always unlinked on the way
/// out — guard files are never touched.
pub(crate) fn write_atomically(
    target: &str,
    data: &[u8],
    mode: u32,
    after_sha: &str,
    after_size: u64,
) -> io::Result<Option<String>> {
    let dir = parent_str(target).to_string();
    let mut fd: RawFd = -1;
    let mut temp: Option<String> = None;
    let outcome = (|| -> io::Result<Option<String>> {
        let (opened, name) = create_temp(&dir)?;
        fd = opened;
        temp = Some(name);
        write_all_fd(fd, data)?;
        fsync_fd(fd)?;
        if unsafe { libc::fchmod(fd, mode as libc::mode_t) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let rc = unsafe { libc::close(fd) };
        fd = -1; // fd is consumed/closed on POSIX even if close fails with EINTR
        if rc != 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EINTR) {
                return Err(e);
            }
        }
        fs::rename(temp.as_ref().expect("temp set"), target)?;
        temp = None;
        let readback = fs::read(target)?;
        if sha256_hex(&readback) != after_sha || readback.len() as u64 != after_size {
            return Ok(Some(format!(
                "readback does not match declared after identity for {target}"
            )));
        }
        fsync_dir(&dir)?;
        Ok(None)
    })();
    if fd >= 0 {
        unsafe { libc::close(fd) };
    }
    if let Some(name) = temp {
        if let Err(e) = fs::remove_file(&name) {
            if e.kind() != io::ErrorKind::NotFound {
                return Err(e); // Python finally: non-ENOENT unlink errors surface
            }
        }
    }
    outcome
}

/// Preserve actual per-file results — rows after the first io_error become not_attempted.
pub(crate) fn io_report(files: Vec<Value>, detail: String) -> Value {
    let mut seen_failure = false;
    let mut rows = Vec::with_capacity(files.len());
    for mut row in files {
        let status = row["status"].as_str().unwrap_or_default().to_string();
        if seen_failure && (status == "apply" || status == "already_applied") {
            row["status"] = json!("not_attempted");
            row["detail"] = json!("not attempted: earlier io failure");
        }
        if status == "io_error" {
            seen_failure = true;
        }
        rows.push(row);
    }
    json!({"type": "publish_result", "ok": false, "outcome": "io_error", "files": rows, "detail": detail})
}

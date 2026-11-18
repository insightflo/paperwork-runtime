// crates/qa-file-owner/src/guard.rs
//
// [purpose] canonical-path admission + guard-file locking — posix_normpath parity,
//   symlink/alias refusal, guard open→flock→post-lock inode re-verification.

use crate::protocol::{py_err, py_repr, refuse, send, sha256_hex, Denied, V};
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::RawFd;
use std::path::PathBuf;

/// Faithful port of POSIX `os.path.normpath` (including the two-leading-slash rule).
fn posix_normpath(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let mut initial_slashes = usize::from(path.starts_with('/'));
    if initial_slashes == 1 && path.starts_with("//") && !path.starts_with("///") {
        initial_slashes = 2;
    }
    let mut comps: Vec<&str> = Vec::new();
    for comp in path.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp != ".." || (initial_slashes == 0 && comps.is_empty()) || comps.last() == Some(&"..") {
            comps.push(comp);
        } else if !comps.is_empty() {
            comps.pop();
        }
    }
    let joined = comps.join("/");
    let out = if initial_slashes > 0 {
        format!("{}{}", "/".repeat(initial_slashes), joined)
    } else {
        joined
    };
    if out.is_empty() { ".".to_string() } else { out }
}

fn lexists(p: &str) -> bool { fs::symlink_metadata(p).is_ok() }

pub(crate) fn is_link(p: &str) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// `os.path.realpath(strict=False)` equivalent — resolves the deepest existing ancestor
/// canonically and appends the nonexistent tail verbatim, so missing files still report
/// symlinked components.
pub(crate) fn realpath_lenient(p: &str) -> String {
    let mut path = PathBuf::from(p);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::canonicalize(&path) {
            Ok(resolved) => {
                let mut out = resolved;
                for comp in tail.iter().rev() {
                    out.push(comp);
                }
                return out.to_string_lossy().into_owned();
            }
            Err(_) => match path.file_name() {
                Some(name) => {
                    tail.push(name.to_os_string());
                    path.pop();
                }
                None => return p.to_string(),
            },
        }
    }
}

/// Absolute canonical path string + (when it exists) symlink/non-canonical component refusal.
pub(crate) fn require_canonical_path<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a str, Denied> {
    let code = match what {
        "lock_root" => "bad_lock_root",
        "target" => "bad_target",
        _ => "bad_path",
    };
    let p = match value {
        Some(Value::String(s))
            if s.starts_with('/') && !s.contains('\0') && posix_normpath(s) == *s =>
        {
            s.as_str()
        }
        _ => {
            return Err(refuse(
                code,
                format!("{what} must be an absolute canonical path string: {}", py_repr(value)),
            ))
        }
    };
    if lexists(p) && (is_link(p) || realpath_lenient(p) != p) {
        return Err(refuse(
            "alias_refused",
            format!("{what} resolves through a symlink component: {p}"),
        ));
    }
    Ok(p)
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } == 0 {
        Ok(st)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn flock_op(fd: RawFd, op: i32) -> io::Result<()> {
    loop {
        if unsafe { libc::flock(fd, op) } == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINTR) {
            return Err(e);
        }
    }
}

fn flock_blocking(fd: RawFd) -> Result<(), Denied> {
    flock_op(fd, libc::LOCK_EX).map_err(|e| Denied::Internal(py_err(&e)))
}

/// libc::open with EINTR retry; `mode` is only consumed when O_CREAT is set.
pub(crate) fn open_eintr(path: &CString, flags: i32, mode: libc::mode_t) -> io::Result<RawFd> {
    loop {
        let fd = unsafe { libc::open(path.as_ptr(), flags, mode as libc::c_uint) };
        if fd >= 0 {
            return Ok(fd);
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINTR) {
            return Err(e);
        }
    }
}

/// Post-lock re-verification: the path must still name the exact locked inode.
fn verify_guard_identity(gp: &str, held_dev: u64, held_ino: u64) -> Result<(), Denied> {
    let named = fs::symlink_metadata(gp).map_err(|e| Denied::Internal(py_err(&e)))?;
    if !named.file_type().is_file() || named.dev() != held_dev || named.ino() != held_ino {
        return Err(refuse(
            "guard_replaced",
            format!("guard path no longer matches the locked inode: {gp}"),
        ));
    }
    Ok(())
}

pub(crate) fn open_guard_fd(lock_root: &str, target: &str) -> Result<RawFd, Denied> {
    let gp = format!(
        "{}/c5-{}.guard",
        lock_root.trim_end_matches('/'),
        sha256_hex(target.as_bytes())
    );
    let c_path = CString::new(gp.as_bytes())
        .map_err(|_| Denied::Internal("OSError: guard path contains NUL".to_string()))?;
    let fd = open_eintr(
        &c_path,
        libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
    .map_err(|e| Denied::Internal(py_err(&e)))?;
    match arm_guard(fd, &gp, target) {
        Ok(()) => Ok(fd),
        Err(error) => {
            unsafe { libc::close(fd) };
            Err(error)
        }
    }
}

fn arm_guard(fd: RawFd, gp: &str, target: &str) -> Result<(), Denied> {
    let held = fstat(fd).map_err(|e| Denied::Internal(py_err(&e)))?;
    if (held.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err(refuse("bad_guard", format!("guard is not a regular file: {gp}")));
    }
    if (held.st_mode & 0o022) != 0 {
        return Err(refuse(
            "unsafe_guard",
            format!("guard is group or world writable: {gp}"),
        ));
    }
    if held.st_nlink as u64 != 1 || held.st_uid != unsafe { libc::getuid() } {
        return Err(refuse(
            "bad_guard",
            format!("guard must be a single-link file owned by the current uid: {gp}"),
        ));
    }
    if let Err(wait) = flock_op(fd, libc::LOCK_EX | libc::LOCK_NB) {
        match wait.raw_os_error() {
            Some(e) if e == libc::EAGAIN || e == libc::EWOULDBLOCK || e == libc::EACCES => {
                // positive contention signal — uncorrelated event, then block (EINTR-retried)
                send(&json!({"v": V, "type": "lock_wait", "target": target}));
                flock_blocking(fd)?;
            }
            _ => return Err(Denied::Internal(py_err(&wait))),
        }
    }
    verify_guard_identity(gp, held.st_dev as u64, held.st_ino as u64)
}

// unit tests — pure helpers only; the real-process/kernel suite lives in tests/
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Compact RAII temp workspace for these in-crate unit tests.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> TempDir {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let raw = std::env::temp_dir()
                .join(format!("c5unit-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir(&raw).expect("create workspace");
            TempDir(fs::canonicalize(&raw).expect("canonical workspace"))
        }
        fn path(&self, name: &str, mode: u32, bytes: Option<&[u8]>) -> String {
            let p = self.0.join(name);
            match bytes {
                Some(b) => fs::write(&p, b).expect("write file"),
                None => fs::create_dir(&p).expect("mkdir"),
            }
            fs::set_permissions(&p, fs::Permissions::from_mode(mode)).expect("chmod");
            p.into_os_string().into_string().expect("utf8 path")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn posix_normpath_matches_python_semantics() {
        for (input, expected) in [
            ("/", "/"), ("//", "//"), ("///", "/"), ("/a/b/", "/a/b"), ("/a//b", "/a/b"),
            ("/a/./b", "/a/b"), ("/a/../b", "/b"), ("/../", "/"), ("/a/b/../../c", "/c"),
            ("/a/b/c", "/a/b/c"),
        ] {
            assert_eq!(posix_normpath(input), expected);
        }
    }

    #[test]
    fn guard_identity_detects_inode_swap_and_accepts_same_inode() {
        let ws = TempDir::new();
        let gp = ws.path("g.guard", 0o600, Some(b"a"));
        let c = CString::new(gp.as_bytes()).unwrap();
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        assert!(fd >= 0);
        let held = fstat(fd).expect("fstat held");
        // swap the path's inode underneath the held fd (the held inode survives via the fd)
        let tmp = ws.path("g.swap", 0o600, Some(b"b"));
        fs::rename(&tmp, &gp).expect("rename over");
        let swapped = verify_guard_identity(&gp, held.st_dev as u64, held.st_ino as u64);
        match swapped {
            Err(Denied::Refusal("guard_replaced", _)) => {}
            other => panic!("expected guard_replaced, got {other:?}"),
        }
        unsafe { libc::close(fd) };
        let fd2 = unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        let held2 = fstat(fd2).expect("fstat held2");
        assert!(verify_guard_identity(&gp, held2.st_dev as u64, held2.st_ino as u64).is_ok());
        unsafe { libc::close(fd2) };
        // non-regular path is also a replacement refusal
        let dir = ws.path("guarddir", 0o700, None);
        let dir_meta = fs::metadata(&dir).unwrap();
        match verify_guard_identity(&dir, dir_meta.dev(), dir_meta.ino()) {
            Err(Denied::Refusal("guard_replaced", _)) => {}
            _ => panic!("expected guard_replaced for directory path"),
        }
    }
}

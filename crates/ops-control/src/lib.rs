//! ops-control: dirfd-anchored, fail-closed ops primitives for the Paperclip control plane.
//! * `verify_skills_lock` — each lock entry is opened via openat(O_NOFOLLOW|O_NONBLOCK)
//!   anchored on a root dirfd, fstat-confirmed regular, then SHA-256 compared. Path escapes,
//!   symlinks (incl. dangling), non-regular/missing files and digest drift all fail closed.
//! * `read_routine_hold`/`write_routine_hold` — hold state inside an euid-owned exact-0700
//!   state dir (fstat-verified on the opened dir fd), read with O_NOFOLLOW, written via
//!   atomic temp-file + fsync + renameat (0600 file).
//! * `validate_control_socket_dir` — PREFLIGHT check only, NOT a TOCTOU-free guarantee for a
//!   later path-based bind(2)/connect(2): it certifies the lexical ancestor chain at call
//!   time (no symlink components; ancestors owned by root or the euid and not group/world-
//!   writable unless sticky; leaf mode exactly 0700 owned by the euid). Pass a canonical
//!   path; re-verify or anchor on an fd if the dir may be swapped before socket use.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub enum OpsControlError {
    Invalid(String),
    Unsafe(String),
    Drift { path: String, expected: String, actual: String },
    Io(io::Error),
}
impl std::fmt::Display for OpsControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid input: {m}"),
            Self::Unsafe(m) => write!(f, "unsafe: {m}"),
            Self::Drift { path, expected, actual } => write!(f, "sha256 drift at {path}: expected {expected} got {actual}"),
            Self::Io(e) => write!(f, "io: {e}"),
        }
    }
}
impl std::error::Error for OpsControlError {}
impl From<io::Error> for OpsControlError { fn from(e: io::Error) -> Self { Self::Io(e) } }

fn inv(m: impl Into<String>) -> OpsControlError { OpsControlError::Invalid(m.into()) }
fn bad(m: impl Into<String>) -> OpsControlError { OpsControlError::Unsafe(m.into()) }
fn sys(op: &'static str) -> OpsControlError { let e = io::Error::last_os_error(); OpsControlError::Io(io::Error::new(e.kind(), format!("{op}: {e}"))) }
fn cstr(b: impl AsRef<[u8]>) -> Result<CString, OpsControlError> { CString::new(b.as_ref()).map_err(|_| inv("NUL byte in name")) }
fn nonce() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{t}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}
fn notfound(e: &OpsControlError) -> bool { matches!(e, OpsControlError::Io(i) if i.kind() == io::ErrorKind::NotFound) }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

const DIRF: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
fn stat_fd(raw: i32) -> Result<libc::stat, OpsControlError> {
    let mut st = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstat(raw, &mut st) } != 0 { Err(sys("fstat")) } else { Ok(st) }
}
fn open_abs(path: &Path, flags: i32) -> Result<OwnedFd, OpsControlError> {
    let fd = unsafe { libc::open(cstr(path.as_os_str().as_bytes())?.as_ptr(), flags) };
    if fd < 0 { Err(sys("open")) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
}
fn openat_fd(p: &OwnedFd, name: &[u8], flags: i32) -> Result<OwnedFd, OpsControlError> {
    let fd = unsafe { libc::openat(p.as_raw_fd(), cstr(name)?.as_ptr(), flags) };
    if fd < 0 { Err(sys("openat")) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
}
fn open_dir_at(p: &OwnedFd, name: &[u8]) -> Result<OwnedFd, OpsControlError> { openat_fd(p, name, DIRF) }
fn open_file_at(p: &OwnedFd, name: &[u8]) -> Result<File, OpsControlError> {
    openat_fd(p, name, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).map(File::from)
}
fn create_file_at(p: &OwnedFd, name: &str, mode: libc::mode_t) -> Result<File, OpsControlError> {
    let fd = unsafe { libc::openat(p.as_raw_fd(), cstr(name)?.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode as libc::c_uint) };
    if fd < 0 { Err(sys("openat(create)")) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
}
fn sha256_fd(mut f: File) -> Result<String, OpsControlError> {
    let (mut h, mut buf) = (Sha256::new(), [0u8; 1 << 16]);
    loop { let n = f.read(&mut buf)?; if n == 0 { return Ok(hex(&h.finalize())); } h.update(&buf[..n]); }
}
fn validate_relpath(rel: &str) -> Result<(), OpsControlError> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.bytes().any(|b| b < 0x20 || b == 0x7f) { return Err(inv("illegal relpath")); }
    if rel.split('/').any(|s| s.is_empty() || matches!(s, "." | "..")) { return Err(inv("relpath escapes root")); }
    Ok(())
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsLock { #[serde(default)] pub skills: Vec<SkillsLockEntry> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsLockEntry { pub path: String, pub sha256: String }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsVerifiedFile { pub path: String, pub sha256: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsVerifyReport { pub ok: bool, pub checked: usize, pub files: Vec<SkillsVerifiedFile> }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHold { pub routine_id: String, pub reason: String, pub by: String, pub held_at_unix: u64 }

pub fn verify_skills_lock(root: &Path, lock: &SkillsLock) -> Result<SkillsVerifyReport, OpsControlError> {
    let rootfd = open_abs(root, DIRF)?;
    if stat_fd(rootfd.as_raw_fd())?.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(bad("skills root is not a directory")); }
    let mut files = Vec::with_capacity(lock.skills.len());
    for e in &lock.skills {
        validate_relpath(&e.path)?;
        let expected = e.sha256.trim().to_ascii_lowercase();
        if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(inv("entry sha256 must be 64 hex chars")); }
        let comps: Vec<&str> = e.path.split('/').collect();
        let mut cur: Option<OwnedFd> = None;
        for c in &comps[..comps.len() - 1] { cur = Some(open_dir_at(cur.as_ref().unwrap_or(&rootfd), c.as_bytes())?); }
        let f = open_file_at(cur.as_ref().unwrap_or(&rootfd), comps[comps.len() - 1].as_bytes())?;
        if stat_fd(f.as_raw_fd())?.st_mode & libc::S_IFMT != libc::S_IFREG { return Err(bad(format!("{}: not a regular file", e.path))); }
        let got = sha256_fd(f)?;
        if got != expected { return Err(OpsControlError::Drift { path: e.path.clone(), expected, actual: got }); }
        files.push(SkillsVerifiedFile { path: e.path.clone(), sha256: got });
    }
    Ok(SkillsVerifyReport { ok: true, checked: files.len(), files })
}

const HOLD_FILE: &str = "routine-hold.json";

fn open_state_dir(dir: &Path) -> Result<OwnedFd, OpsControlError> {
    let fd = open_abs(dir, DIRF)?;
    let st = stat_fd(fd.as_raw_fd())?;
    if st.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(bad("state dir is not a directory")); }
    if st.st_uid != unsafe { libc::geteuid() } { return Err(bad("state dir not owned by euid")); }
    if st.st_mode & 0o777 != 0o700 { return Err(bad("state dir mode must be exactly 0700")); }
    Ok(fd)
}
pub fn read_routine_hold(dir: &Path) -> Result<Option<RoutineHold>, OpsControlError> {
    let d = match open_state_dir(dir) { Ok(d) => d, Err(e) if notfound(&e) => return Ok(None), Err(e) => return Err(e) };
    let f = match open_file_at(&d, HOLD_FILE.as_bytes()) { Ok(f) => f, Err(e) if notfound(&e) => return Ok(None), Err(e) => return Err(e) };
    if stat_fd(f.as_raw_fd())?.st_mode & libc::S_IFMT != libc::S_IFREG { return Err(bad("routine-hold.json is not a regular file")); }
    serde_json::from_reader(f).map(Some).map_err(|_| bad("corrupt routine-hold.json"))
}
pub fn write_routine_hold(dir: &Path, hold: &RoutineHold) -> Result<(), OpsControlError> {
    if dir.metadata().is_err() {
        fs::create_dir_all(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    let d = open_state_dir(dir)?;
    let tmp = format!(".{HOLD_FILE}.{}.tmp", nonce());
    let r = (|| -> Result<(), OpsControlError> {
        let mut f = create_file_at(&d, &tmp, 0o600)?;
        f.write_all(serde_json::to_string(hold).map_err(|e| inv(e.to_string()))?.as_bytes())?;
        f.sync_all()?;
        drop(f);
        let (cf, ct) = (cstr(&tmp)?, cstr(HOLD_FILE)?);
        if unsafe { libc::renameat(d.as_raw_fd(), cf.as_ptr(), d.as_raw_fd(), ct.as_ptr()) } != 0 { return Err(sys("renameat")); }
        if unsafe { libc::fsync(d.as_raw_fd()) } != 0 { return Err(sys("fsync(dir)")); }
        Ok(())
    })();
    if r.is_err() { if let Ok(c) = cstr(&tmp) { unsafe { libc::unlinkat(d.as_raw_fd(), c.as_ptr(), 0) }; } }
    r
}

pub fn validate_control_socket_dir(dir: &Path) -> Result<(), OpsControlError> {
    if !dir.is_absolute() { return Err(inv("control socket dir must be an absolute path")); }
    let comps: Vec<&[u8]> = dir.as_os_str().as_bytes().split(|&b| b == b'/').filter(|c| !c.is_empty()).collect();
    if comps.is_empty() { return Err(inv("control socket dir must not be the filesystem root")); }
    let (euid, mut fd) = (unsafe { libc::geteuid() }, open_abs(Path::new("/"), DIRF)?);
    for (i, &c) in comps.iter().enumerate() {
        let next = open_dir_at(&fd, c)?; // O_NOFOLLOW: any symlink ancestor or leaf fails closed
        let st = stat_fd(next.as_raw_fd())?;
        if i == comps.len() - 1 {
            if st.st_uid != euid { return Err(bad("control socket dir not owned by euid")); }
            if st.st_mode & 0o777 != 0o700 { return Err(bad("control socket dir mode must be exactly 0700")); }
        } else {
            if st.st_uid != 0 && st.st_uid != euid { return Err(bad("ancestor dir owned by foreign uid")); }
            if st.st_mode & 0o022 != 0 && st.st_mode & 0o1000 == 0 { return Err(bad("ancestor dir group/world writable without sticky bit")); }
        }
        fd = next;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("opsctl-{tag}-{}", nonce()));
        fs::create_dir_all(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        fs::canonicalize(&p).unwrap()
    }
    fn sha(b: &[u8]) -> String { hex(&Sha256::digest(b)) }
    fn lock(p: &str, s: &str) -> SkillsLock { SkillsLock { skills: vec![SkillsLockEntry { path: p.into(), sha256: s.into() }] } }
    fn hold() -> RoutineHold { RoutineHold { routine_id: "r1".into(), reason: "manual".into(), by: "op".into(), held_at_unix: 1_700_000_000 } }
    fn mode(p: &Path, m: u32) { fs::set_permissions(p, fs::Permissions::from_mode(m)).unwrap(); }
    fn mkfifo(p: &Path) { assert_eq!(unsafe { libc::mkfifo(cstr(p.as_os_str().as_bytes()).unwrap().as_ptr(), 0o600) }, 0); }

    #[test]
    fn verify_ok_drift_missing_and_bad_paths() {
        let d = tmp("ver");
        fs::write(d.join("a.txt"), b"hello").unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        fs::write(d.join("sub/b.txt"), b"world").unwrap();
        let l = SkillsLock { skills: vec![SkillsLockEntry { path: "a.txt".into(), sha256: sha(b"hello") }, SkillsLockEntry { path: "sub/b.txt".into(), sha256: sha(b"world") }] };
        let rep = verify_skills_lock(&d, &l).unwrap();
        assert!(rep.ok && rep.checked == 2);
        assert!(matches!(verify_skills_lock(&d, &lock("a.txt", &sha(b"other"))), Err(OpsControlError::Drift { .. })));
        assert!(verify_skills_lock(&d, &lock("gone.txt", &sha(b"x"))).is_err());
        for p in ["../x", "/abs", "a\\b", "a//b", ".", "a/../b", ""] { assert!(verify_skills_lock(&d, &lock(p, &sha(b"x"))).is_err(), "accepted {p:?}"); }
    }

    #[test]
    fn verify_rejects_symlinks_dangling_and_fifo() {
        let d = tmp("lnk");
        fs::write(d.join("real.txt"), b"r").unwrap();
        let h = sha(b"r");
        std::os::unix::fs::symlink(d.join("real.txt"), d.join("leaf.txt")).unwrap();
        std::os::unix::fs::symlink(d.join("missing-target"), d.join("dangle.txt")).unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        fs::write(d.join("sub/x.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(d.join("sub"), d.join("sublink")).unwrap();
        for p in ["leaf.txt", "dangle.txt"] { assert!(verify_skills_lock(&d, &lock(p, &h)).is_err(), "accepted {p}"); }
        assert!(verify_skills_lock(&d, &lock("sublink/x.txt", &sha(b"s"))).is_err());
        mkfifo(&d.join("fifo")); // O_NONBLOCK: must fail closed, not hang
        assert!(verify_skills_lock(&d, &lock("fifo", &h)).is_err());
    }

    #[test]
    fn hold_roundtrip_and_unsafe_state_dir_rejected() {
        let d = tmp("hold");
        assert!(read_routine_hold(&d.join("missing")).unwrap().is_none());
        let sdir = d.join("state");
        write_routine_hold(&sdir, &hold()).unwrap();
        assert_eq!(read_routine_hold(&sdir).unwrap(), Some(hold()));
        assert_eq!(fs::metadata(sdir.join(HOLD_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        let loose = d.join("loose");
        fs::create_dir(&loose).unwrap();
        mode(&loose, 0o755);
        assert!(read_routine_hold(&loose).is_err()); // regression: non-0700 state dir must fail closed
        assert!(write_routine_hold(&loose, &hold()).is_err());
        fs::write(d.join("notdir"), b"x").unwrap();
        assert!(read_routine_hold(&d.join("notdir")).is_err());
    }

    #[test]
    fn socket_dir_preflight_and_ancestor_symlink() {
        let d = tmp("sock");
        let leaf = d.join("sock");
        fs::create_dir(&leaf).unwrap();
        mode(&leaf, 0o700);
        validate_control_socket_dir(&leaf).unwrap();
        mode(&leaf, 0o750);
        assert!(validate_control_socket_dir(&leaf).is_err());
        mode(&leaf, 0o700);
        let mid = d.join("mid");
        fs::create_dir(&mid).unwrap();
        let deep = mid.join("s");
        fs::create_dir(&deep).unwrap();
        mode(&deep, 0o700);
        mode(&mid, 0o775);
        assert!(validate_control_socket_dir(&deep).is_err()); // ancestor group-writable, no sticky
        mode(&mid, 0o1777);
        validate_control_socket_dir(&deep).unwrap(); // sticky world-writable ancestor ok (like /tmp)
        let real = d.join("real");
        fs::create_dir(&real).unwrap();
        mode(&real, 0o700);
        let link = d.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(validate_control_socket_dir(&link.join("x")).is_err()); // regression: ancestor symlink
        assert!(validate_control_socket_dir(&link).is_err()); // leaf symlink
        assert!(validate_control_socket_dir(Path::new("relative/dir")).is_err());
        assert!(validate_control_socket_dir(Path::new("/")).is_err());
    }
}

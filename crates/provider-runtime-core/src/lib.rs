//! provider-runtime-core: dirfd-anchored, fail-closed install + resolution of provider runtimes.
//! Every mutation under <root> goes through a verified OwnedFd directory handle
//! (O_NOFOLLOW|O_DIRECTORY openat + fstat owner/mode checks) so symlink plants,
//! ancestor-directory swaps, or path tricks cannot redirect writes outside the tree.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

fn inv(m: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, m) }
fn sys(op: &'static str) -> io::Error { let e = io::Error::last_os_error(); io::Error::new(e.kind(), format!("{op}: {e}")) }
fn cstr(b: impl AsRef<[u8]>) -> io::Result<std::ffi::CString> { std::ffi::CString::new(b.as_ref()).map_err(|_| inv("NUL byte in name")) }
fn now_unix() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn nonce() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{t}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId { Claude, Codex, Pi, Commandcode, Devin }
impl ProviderId {
    pub fn as_str(self) -> &'static str { match self { Self::Claude => "claude", Self::Codex => "codex", Self::Pi => "pi", Self::Commandcode => "commandcode", Self::Devin => "devin" } }
    pub fn parse(s: &str) -> Option<Self> { Some(match s { "claude" => Self::Claude, "codex" => Self::Codex, "pi" => Self::Pi, "commandcode" => Self::Commandcode, "devin" => Self::Devin, _ => return None }) }
}
impl std::fmt::Display for ProviderId { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.as_str()) } }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPin { pub version: String, pub sha256: String }
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLockfile { #[serde(default)] pub pins: BTreeMap<String, ArtifactPin> }
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocklist { #[serde(default)] pub versions: Vec<String>, #[serde(default)] pub sha256s: Vec<String> }
impl Blocklist {
    pub fn is_empty(&self) -> bool { self.versions.is_empty() && self.sha256s.is_empty() }
    fn hit(v: &str, e: &str) -> bool { e == v || e.strip_suffix('*').is_some_and(|p| v.starts_with(p)) }
    pub fn blocks_version(&self, v: &str) -> bool { self.versions.iter().any(|e| Self::hit(v, e)) }
    pub fn blocks(&self, v: &str, sha256: &str) -> bool { self.blocks_version(v) || self.sha256s.iter().any(|e| e.eq_ignore_ascii_case(sha256)) }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord { pub provider: ProviderId, pub version: String, pub sha256: String, pub leaf: String, pub dir: String, pub nonce: String, pub installed_at_unix: u64 }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentPointer { pub provider: ProviderId, pub version: String, pub sha256: String, pub leaf: String, pub dir: String }
#[derive(Debug)]
pub struct ResolvedRuntime { pub provider: ProviderId, pub version: String, pub binary_path: PathBuf, pub source: RuntimeSource, pub sha256: String }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSource { Managed, SystemPath }

const DIRF: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
fn verify_fd_dir(fd: &OwnedFd) -> io::Result<()> {
    let mut st = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 { return Err(sys("fstat")); }
    if st.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(inv("anchor not a directory")); }
    if st.st_uid != unsafe { libc::geteuid() } { return Err(inv("anchor not owned by euid")); }
    if st.st_mode & 0o022 != 0 { return Err(inv("anchor group/world writable")); }
    Ok(())
}
fn open_root(path: &Path) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::open(cstr(path.as_os_str().as_bytes())?.as_ptr(), DIRF) };
    if fd < 0 { return Err(sys("open(root)")); }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    verify_fd_dir(&fd).map(|_| fd)
}
fn open_dir_at(p: &OwnedFd, name: &str) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::openat(p.as_raw_fd(), cstr(name)?.as_ptr(), DIRF) };
    if fd < 0 { return Err(sys("openat(dir)")); }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    verify_fd_dir(&fd).map(|_| fd)
}
fn open_file_at(d: &OwnedFd, name: &str, write_mode: Option<libc::mode_t>) -> io::Result<File> {
    let flags = if write_mode.is_some() { libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC } else { libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC };
    let fd = unsafe { libc::openat(d.as_raw_fd(), cstr(name)?.as_ptr(), flags, write_mode.unwrap_or(0) as libc::c_uint) };
    if fd < 0 { Err(sys("openat(file)")) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
}
fn ensure_dir(p: &OwnedFd, name: &str) -> io::Result<OwnedFd> {
    match open_dir_at(p, name) {
        Ok(fd) => Ok(fd),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if unsafe { libc::mkdirat(p.as_raw_fd(), cstr(name)?.as_ptr(), 0o700) } != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists { return Err(sys("mkdirat")); }
            open_dir_at(p, name)
        }
        Err(e) => Err(e),
    }
}
fn rename_at(a: &OwnedFd, from: &str, b: &OwnedFd, to: &str) -> io::Result<()> {
    let (cf, ct) = (cstr(from)?, cstr(to)?);
    if unsafe { libc::renameat(a.as_raw_fd(), cf.as_ptr(), b.as_raw_fd(), ct.as_ptr()) } != 0 { Err(sys("renameat")) } else { Ok(()) }
}
fn fsync_dir(fd: &OwnedFd) { unsafe { libc::fsync(fd.as_raw_fd()); } }
fn unlink_at(d: &OwnedFd, name: &str, flag: i32) { if let Ok(c) = cstr(name) { unsafe { libc::unlinkat(d.as_raw_fd(), c.as_ptr(), flag); } } }

fn bad_name(s: &str) -> bool { s.is_empty() || matches!(s, "." | "..") || s.bytes().any(|b| b < 0x20 || b == 0x7f || b == b'/' || b == b'\\') }
pub fn validate_name(s: &str) -> io::Result<()> { if bad_name(s) { Err(inv("illegal name")) } else { Ok(()) } }
pub fn validate_relpath(rel: &str) -> io::Result<()> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.bytes().any(|b| b < 0x20 || b == 0x7f) { return Err(inv("illegal relpath")); }
    if rel.split('/').any(|s| s.is_empty() || matches!(s, "." | "..")) { return Err(inv("relpath escapes root")); }
    Ok(())
}
pub fn sha256_reader(mut r: impl Read) -> io::Result<String> {
    let (mut h, mut buf) = (Sha256::new(), [0u8; 1 << 16]);
    loop { let n = r.read(&mut buf)?; if n == 0 { return Ok(hex::encode(h.finalize())); } h.update(&buf[..n]); }
}
pub fn sha256_file(p: &Path) -> io::Result<String> { sha256_reader(File::open(p)?) }
pub fn verify_sha256(p: &Path, expected: &str) -> io::Result<bool> { Ok(sha256_file(p)?.eq_ignore_ascii_case(expected.trim())) }

pub fn stage_and_activate(root: &Path, provider: ProviderId, version: &str, source: &Path, expected_sha256: &str) -> io::Result<InstallRecord> {
    stage_and_activate_with_hook(root, provider, version, source, expected_sha256, || Ok(()))
}
pub fn stage_and_activate_with_hook(root: &Path, provider: ProviderId, version: &str, source: &Path, expected_sha256: &str, hook: impl FnOnce() -> io::Result<()>) -> io::Result<InstallRecord> {
    validate_name(version)?;
    let leaf = source.file_name().and_then(|s| s.to_str()).ok_or(inv("bad source name"))?.to_string();
    validate_name(&leaf)?;
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(inv("expected_sha256 must be 64 hex chars")); }
    let rootfd = open_root(root)?;
    let prov = ensure_dir(&rootfd, provider.as_str())?;
    let staging = ensure_dir(&prov, ".staging")?;
    let versions = ensure_dir(&prov, "versions")?;
    let n = nonce();
    let sname = format!("{version}-{n}");
    if unsafe { libc::mkdirat(staging.as_raw_fd(), cstr(&sname)?.as_ptr(), 0o700) } != 0 { return Err(sys("mkdirat(stage)")); }
    let sdir = open_dir_at(&staging, &sname)?;
    let pre = (|| -> io::Result<InstallRecord> {
        let mut src = File::open(source)?;
        let mut dst = open_file_at(&sdir, &leaf, Some(0o700))?;
        io::copy(&mut src, &mut dst)?;
        dst.sync_all()?;
        drop(dst);
        let got = sha256_reader(open_file_at(&sdir, &leaf, None)?)?;
        if !got.eq_ignore_ascii_case(&expected) { return Err(inv("staged sha256 mismatch")); }
        let rec = InstallRecord { provider, version: version.into(), sha256: got, leaf: leaf.clone(), dir: sname.clone(), nonce: n.clone(), installed_at_unix: now_unix() };
        let mut ij = open_file_at(&sdir, "install.json", Some(0o600))?;
        ij.write_all(serde_json::to_string(&rec)?.as_bytes())?;
        ij.sync_all()?;
        drop(ij);
        hook()?;
        Ok(rec)
    })().inspect_err(|_| { unlink_at(&sdir, &leaf, 0); unlink_at(&sdir, "install.json", 0); unlink_at(&staging, &sname, libc::AT_REMOVEDIR); })?;
    rename_at(&staging, &sname, &versions, &sname).inspect_err(|_| { unlink_at(&staging, &sname, libc::AT_REMOVEDIR); })?;
    fsync_dir(&versions);
    let tmp = format!(".current.{n}.tmp");
    (|| -> io::Result<()> {
        let mut cf = open_file_at(&prov, &tmp, Some(0o600))?;
        cf.write_all(serde_json::to_string(&CurrentPointer { provider, version: pre.version.clone(), sha256: pre.sha256.clone(), leaf: leaf.clone(), dir: sname.clone() })?.as_bytes())?;
        cf.sync_all()?;
        drop(cf);
        rename_at(&prov, &tmp, &prov, "current.json")?;
        fsync_dir(&prov);
        Ok(())
    })().inspect_err(|_| { unlink_at(&prov, &tmp, 0); unlink_at(&sdir, &leaf, 0); unlink_at(&sdir, "install.json", 0); unlink_at(&versions, &sname, libc::AT_REMOVEDIR); })?;
    Ok(pre)
}
fn read_current(prov: &OwnedFd) -> io::Result<Option<CurrentPointer>> {
    match open_file_at(prov, "current.json", None) {
        Ok(f) => serde_json::from_reader(f).map(Some).map_err(|_| inv("corrupt current.json")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn resolve_runtime(root: &Path, provider: ProviderId, blocklist: &Blocklist, path_dirs: &[PathBuf], probe: impl Fn(&Path) -> Option<String>) -> io::Result<ResolvedRuntime> {
    match open_root(root) {
        Ok(rootfd) => match open_dir_at(&rootfd, provider.as_str()) {
            Ok(prov) => if let Some(cur) = read_current(&prov)? {
                if blocklist.blocks(&cur.version, &cur.sha256) { return Err(inv("managed runtime is blocklisted")); }
                validate_name(&cur.dir)?; validate_name(&cur.leaf)?;
                let ld = open_dir_at(&open_dir_at(&prov, "versions")?, &cur.dir)?;
                open_file_at(&ld, &cur.leaf, None)?;
                return Ok(ResolvedRuntime { provider, version: cur.version, sha256: cur.sha256, source: RuntimeSource::Managed, binary_path: root.join(provider.as_str()).join("versions").join(&cur.dir).join(&cur.leaf) });
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    for d in path_dirs {
        let cand = d.join(provider.as_str());
        if !fs::metadata(&cand).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false) { continue; }
        let version = probe(&cand).unwrap_or_default().trim().to_string();
        if version.is_empty() && !blocklist.is_empty() { return Err(inv("unversioned PATH runtime with non-empty blocklist")); }
        if blocklist.blocks_version(&version) { return Err(inv("PATH runtime version is blocklisted")); }
        return Ok(ResolvedRuntime { provider, version, sha256: String::new(), source: RuntimeSource::SystemPath, binary_path: cand });
    }
    Err(inv("no runtime candidate found"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(tag: &str) -> PathBuf { let p = std::env::temp_dir().join(format!("prtc-{tag}-{}", nonce())); fs::create_dir_all(&p).unwrap(); fs::set_permissions(&p, PermissionsExt::from_mode(0o700)).unwrap(); p }
    fn put(p: &Path, b: &[u8]) { fs::write(p, b).unwrap(); }
    fn sha(b: &[u8]) -> String { hex::encode(Sha256::digest(b)) }
    fn srcbin(d: &Path, name: &str, b: &[u8]) -> PathBuf { let p = d.join(name); put(&p, b); p }
    fn mkroot(d: &Path) -> PathBuf { let r = d.join("root"); fs::create_dir(&r).unwrap(); r }
    fn mode(p: &Path, m: u32) { fs::set_permissions(p, PermissionsExt::from_mode(m)).unwrap(); }
    fn read_cur(root: &Path, prov: &str) -> CurrentPointer { serde_json::from_slice(&fs::read(root.join(prov).join("current.json")).unwrap()).unwrap() }
    fn leaf_bytes(root: &Path, prov: &str, cur: &CurrentPointer) -> Vec<u8> { fs::read(root.join(prov).join("versions").join(&cur.dir).join(&cur.leaf)).unwrap() }

    #[test] fn sha256_pass_and_fail() {
        let d = tmp("sha"); let f = d.join("b"); put(&f, b"data");
        assert!(verify_sha256(&f, &sha(b"data")).unwrap() && verify_sha256(&f, &sha(b"data").to_uppercase()).unwrap());
        assert!(!verify_sha256(&f, &sha(b"other")).unwrap() && !verify_sha256(&f, "zz").unwrap());
    }
    #[test] fn fail_closed_symlink_and_loose_dirs() {
        let d = tmp("dirs"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"v"); let h = sha(b"v");
        let prov = root.join("claude"); fs::create_dir(&prov).unwrap();
        std::os::unix::fs::symlink(&d, prov.join(".staging")).unwrap();
        assert!(stage_and_activate(&root, ProviderId::Claude, "1", &src, &h).is_err());
        fs::remove_file(prov.join(".staging")).unwrap();
        let v = prov.join("versions"); fs::create_dir(&v).unwrap(); mode(&v, 0o777);
        assert!(stage_and_activate(&root, ProviderId::Claude, "1", &src, &h).is_err());
        fs::remove_dir(&v).unwrap(); std::os::unix::fs::symlink(&d, &v).unwrap();
        assert!(stage_and_activate(&root, ProviderId::Claude, "1", &src, &h).is_err());
        let r2 = d.join("alias"); std::os::unix::fs::symlink(&root, &r2).unwrap();
        assert!(stage_and_activate(&r2, ProviderId::Claude, "1", &src, &h).is_err());
        assert!(resolve_runtime(&r2, ProviderId::Claude, &Blocklist::default(), &[], |_| None).is_err());
    }
    #[test] fn path_confinement() {
        for bad in ["..", "/abs", "a/b/../c", "a\\b", "a\nb", "", ".", "a//b", "a\tb"] { assert!(validate_relpath(bad).is_err(), "accept {bad:?}"); }
        assert!(validate_relpath("versions/1.0-x/leaf").is_ok());
        for bad in ["..", "a/b", "v\n", "", "."] { assert!(validate_name(bad).is_err(), "name {bad:?}"); }
        let d = tmp("trav"); let src = srcbin(&d, "b", b"x");
        assert!(stage_and_activate(&d.join("r"), ProviderId::Pi, "../etc", &src, &sha(b"x")).is_err());
    }
    #[test] fn blocklist_managed_and_path() {
        let d = tmp("bl"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"v1");
        stage_and_activate(&root, ProviderId::Codex, "1.0", &src, &sha(b"v1")).unwrap();
        let bl = Blocklist { versions: vec!["1.0".into(), "9.x-*".into()], sha256s: vec![] };
        assert!(resolve_runtime(&root, ProviderId::Codex, &bl, &[], |_| None).is_err());
        let pd = d.join("pb"); fs::create_dir(&pd).unwrap(); let pb = srcbin(&pd, "devin", b"x"); mode(&pb, 0o755);
        assert!(resolve_runtime(&d.join("none"), ProviderId::Devin, &bl, std::slice::from_ref(&pd), |_| Some("9.x-5".into())).is_err());
        let ok = resolve_runtime(&d.join("none"), ProviderId::Devin, &bl, std::slice::from_ref(&pd), |_| Some("2.0".into())).unwrap();
        assert_eq!((ok.source, ok.version.as_str()), (RuntimeSource::SystemPath, "2.0"));
        let bls = Blocklist { versions: vec![], sha256s: vec![sha(b"v1")] };
        assert!(resolve_runtime(&root, ProviderId::Codex, &bls, &[], |_| None).is_err());
    }
    #[test] fn path_fail_closed_when_unversioned() {
        let d = tmp("pv"); let pd = d.join("pb"); fs::create_dir(&pd).unwrap();
        let pb = srcbin(&pd, "pi", b"x"); mode(&pb, 0o755); let dirs = std::slice::from_ref(&pd);
        let bl = Blocklist { versions: vec!["0.0".into()], sha256s: vec![] };
        assert!(resolve_runtime(&d.join("r"), ProviderId::Pi, &bl, dirs, |_| None).is_err());
        assert!(resolve_runtime(&d.join("r"), ProviderId::Pi, &bl, dirs, |_| Some("  ".into())).is_err());
        assert!(resolve_runtime(&d.join("r"), ProviderId::Pi, &Blocklist::default(), dirs, |_| None).is_ok());
    }
    #[test] fn atomic_swap_and_failure_keeps_v1() {
        let d = tmp("swap"); let root = mkroot(&d); let s1 = srcbin(&d, "bin", b"one");
        stage_and_activate(&root, ProviderId::Devin, "1.0", &s1, &sha(b"one")).unwrap();
        let s2 = srcbin(&d, "bin2", b"two");
        stage_and_activate(&root, ProviderId::Devin, "2.0", &s2, &sha(b"two")).unwrap();
        let cur = read_cur(&root, "devin");
        assert_eq!(cur.version, "2.0"); assert_eq!(leaf_bytes(&root, "devin", &cur), b"two");
        assert!(stage_and_activate(&root, ProviderId::Devin, "3.0", &s2, &sha(b"bogus")).is_err());
        let cur2 = read_cur(&root, "devin");
        assert_eq!((cur2.version.as_str(), cur2.dir.as_str()), ("2.0", cur.dir.as_str()));
    }
    #[test] fn concurrent_writers_are_atomic() {
        let d = tmp("conc"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"B"); let h = sha(b"B");
        let hs: Vec<_> = (0..8).map(|i| { let (r, s, hh) = (root.clone(), src.clone(), h.clone()); std::thread::spawn(move || stage_and_activate(&r, ProviderId::Commandcode, &format!("1.{i}"), &s, &hh)) }).collect();
        for h2 in hs { h2.join().unwrap().unwrap(); }
        let cur = read_cur(&root, "commandcode"); let leafp = root.join("commandcode").join("versions").join(&cur.dir).join(&cur.leaf);
        assert_eq!(fs::read(&leafp).unwrap(), b"B"); assert_eq!(sha256_file(&leafp).unwrap(), cur.sha256);
    }
    #[test] fn toctou_source_mutation_keeps_verified_bytes() {
        let d = tmp("toctou"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"original"); let s2 = src.clone();
        let rec = stage_and_activate_with_hook(&root, ProviderId::Codex, "1.0", &src, &sha(b"original"), move || { fs::write(&s2, b"MUTATED").unwrap(); Ok(()) }).unwrap();
        assert_eq!(rec.sha256, sha(b"original"));
        let cur = read_cur(&root, "codex"); assert_eq!(leaf_bytes(&root, "codex", &cur), b"original");
    }
    #[test] fn ancestor_replacement_decoy_gets_nothing() {
        let d = tmp("anc"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"payload");
        let (r2, mv) = (root.clone(), d.join("root.moved")); let mv2 = mv.clone();
        stage_and_activate_with_hook(&root, ProviderId::Devin, "1.0", &src, &sha(b"payload"), move || { fs::rename(&r2, &mv2).unwrap(); fs::create_dir(&r2).unwrap(); Ok(()) }).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let cur = read_cur(&mv, "devin"); assert_eq!(leaf_bytes(&mv, "devin", &cur), b"payload");
    }
    #[test] fn managed_beats_system_path() {
        let d = tmp("prec"); let root = mkroot(&d); let src = srcbin(&d, "bin", b"m"); mode(&src, 0o755);
        stage_and_activate(&root, ProviderId::Claude, "3.0", &src, &sha(b"m")).unwrap();
        let pd = d.join("pb"); fs::create_dir(&pd).unwrap(); let pb = srcbin(&pd, "claude", b"s"); mode(&pb, 0o755);
        let r = resolve_runtime(&root, ProviderId::Claude, &Blocklist::default(), std::slice::from_ref(&pd), |_| Some("9.9".into())).unwrap();
        assert_eq!((r.source, r.version.as_str()), (RuntimeSource::Managed, "3.0")); assert!(r.binary_path.ends_with("bin"));
    }
}

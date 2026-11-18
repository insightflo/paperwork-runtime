use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{
    c_str, fstat_fd, fsync_fd, is_regular_file, lstat_at, open_pinned_root, same_inode,
    stat_metadata_equal, write_all_fd, OwnedFd,
};

const MAX_STDIN_BYTES: usize = 64 * 1024 * 1024;
const TMP_NAME_ATTEMPTS: usize = 32;

#[derive(Deserialize)]
struct WriteRequest {
    node: DirNode,
    dev: i128,
    ino: i128,
}

#[derive(Deserialize)]
struct DirNode {
    name: String,
    #[serde(default)]
    exclusive: bool,
    #[serde(default)]
    readonly: bool,
    #[serde(default)]
    target: bool,
    #[serde(default)]
    directories: Vec<DirNode>,
    #[serde(default)]
    files: Vec<FileEntry>,
}

#[derive(Deserialize)]
struct FileEntry {
    name: String,
    base64: String,
}

#[derive(Serialize)]
struct TargetIds {
    dev: i128,
    ino: i128,
}

fn validate_segment(name: &str) -> Result<CString, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("artifact_path_invalid".to_string());
    }
    c_str(name)
}

fn verify_fd_bytes(fd: libc::c_int, expected: &[u8]) -> Result<(), String> {
    let before = fstat_fd(fd).map_err(|_| "artifact_file_conflict".to_string())?;
    if !is_regular_file(&before)
        || !usize::try_from(before.st_size).is_ok_and(|sz| sz == expected.len())
    {
        return Err("artifact_file_conflict".to_string());
    }
    let mut actual = vec![0_u8; expected.len() + 1];
    let mut offset = 0_usize;
    while offset < actual.len() {
        let off = libc::off_t::try_from(offset).map_err(|_| "artifact_file_conflict".to_string())?;
        let dst = &mut actual[offset..];
        // SAFETY: `fd` is valid and `dst` is uniquely borrowed writable memory.
        let n = unsafe { libc::pread(fd, dst.as_mut_ptr().cast(), dst.len(), off) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err.to_string());
        }
        if n == 0 {
            break;
        }
        offset += usize::try_from(n).map_err(|_| "artifact_file_conflict".to_string())?;
    }
    let after = fstat_fd(fd).map_err(|_| "artifact_file_conflict".to_string())?;
    if !stat_metadata_equal(&before, &after) || offset != expected.len() || actual[..offset] != *expected {
        return Err("artifact_file_conflict".to_string());
    }
    Ok(())
}

fn reuse_existing(dir_fd: libc::c_int, name: &CString, expected: &[u8]) -> Result<bool, String> {
    // SAFETY: `dir_fd` is open and `name` is NUL-terminated; non-creating open without mode.
    let raw = unsafe {
        libc::openat(
            dir_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW,
        )
    };
    if raw < 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ENOENT) {
            return Ok(false);
        }
        return Err(err.to_string());
    }
    let fd = OwnedFd::from_raw(raw);
    verify_fd_bytes(fd.as_raw(), expected)?;
    fsync_fd(fd.as_raw()).map_err(|err| err.to_string())?;
    Ok(true)
}

fn random_tmp_name(rng: &mut File) -> Result<CString, String> {
    let mut raw = [0_u8; 24];
    rng.read_exact(&mut raw).map_err(|err| err.to_string())?;
    let mut name = String::with_capacity(".artifact-".len() + 48 + ".tmp".len());
    name.push_str(".artifact-");
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(&mut name, "{byte:02x}");
    }
    name.push_str(".tmp");
    CString::new(name).map_err(|err| err.to_string())
}

fn open_exclusive_temp(dir_fd: libc::c_int, rng: &mut File) -> Result<(CString, OwnedFd), String> {
    let mode: libc::c_uint = 0o400;
    for _ in 0..TMP_NAME_ATTEMPTS {
        let tmp_name = random_tmp_name(rng)?;
        // SAFETY: `dir_fd` is open, `tmp_name` is NUL-terminated, O_CREAT takes c_uint mode.
        let fd = unsafe {
            libc::openat(
                dir_fd,
                tmp_name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
                mode,
            )
        };
        if fd >= 0 {
            return Ok((tmp_name, OwnedFd::from_raw(fd)));
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EEXIST) {
            return Err(err.to_string());
        }
    }
    Err("artifact_temporary_collision".to_string())
}

fn persist_file(dir_fd: libc::c_int, entry: &FileEntry, rng: &mut File) -> Result<(), String> {
    let target_name = validate_segment(&entry.name)?;
    let bytes = STANDARD
        .decode(entry.base64.as_bytes())
        .map_err(|_| "artifact_base64_invalid".to_string())?;
    if reuse_existing(dir_fd, &target_name, &bytes)? {
        return Ok(());
    }
    let (tmp_name, tmp_fd) = open_exclusive_temp(dir_fd, rng)?;
    let owned = fstat_fd(tmp_fd.as_raw()).map_err(|err| err.to_string())?;
    let mut failure: Option<String> = None;

    let write_res = (|| -> Result<(), String> {
        write_all_fd(tmp_fd.as_raw(), &bytes)?;
        verify_fd_bytes(tmp_fd.as_raw(), &bytes)?;
        fsync_fd(tmp_fd.as_raw()).map_err(|err| err.to_string())?;
        let current = lstat_at(dir_fd, &tmp_name)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "artifact_temporary_replaced".to_string())?;
        if !is_regular_file(&current) || !same_inode(&current, &owned) {
            return Err("artifact_temporary_replaced".to_string());
        }
        // SAFETY: `dir_fd`, `tmp_name`, and `target_name` are valid.
        let rc = unsafe { libc::linkat(dir_fd, tmp_name.as_ptr(), dir_fd, target_name.as_ptr(), 0) };
        if rc != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EEXIST) || !reuse_existing(dir_fd, &target_name, &bytes)? {
                return Err(err.to_string());
            }
        }
        Ok(())
    })();
    if let Err(err) = write_res {
        failure = Some(err);
    }

    drop(tmp_fd);
    match lstat_at(dir_fd, &tmp_name) {
        Ok(None) => {}
        Ok(Some(current)) => {
            if !is_regular_file(&current) || !same_inode(&current, &owned) {
                if failure.is_none() {
                    failure = Some("artifact_temporary_replaced".to_string());
                }
            } else {
                // SAFETY: `dir_fd` is open and `tmp_name` is a validated temporary file.
                let rc = unsafe { libc::unlinkat(dir_fd, tmp_name.as_ptr(), 0) };
                if rc != 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::ENOENT) && failure.is_none() {
                        failure = Some(err.to_string());
                    }
                }
            }
        }
        Err(err) if failure.is_none() => failure = Some(err.to_string()),
        Err(_) => {}
    }
    if let Some(err) = failure {
        return Err(err);
    }
    Ok(())
}

fn write_dir_tree(
    dir_fd: libc::c_int,
    dir_st: &libc::stat,
    node: &DirNode,
    rng: &mut File,
) -> Result<Option<TargetIds>, String> {
    let mut target = if node.target {
        Some(TargetIds {
            dev: i128::from(dir_st.st_dev),
            ino: i128::from(dir_st.st_ino),
        })
    } else {
        None
    };
    let dir_mode: libc::mode_t = 0o700;
    for child in &node.directories {
        let name = validate_segment(&child.name)?;
        // SAFETY: `dir_fd` is open and `name` is NUL-terminated.
        let mk = unsafe { libc::mkdirat(dir_fd, name.as_ptr(), dir_mode) };
        if mk != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EEXIST) || child.exclusive {
                return Err(err.to_string());
            }
        }
        // SAFETY: `dir_fd` is open and `name` is NUL-terminated.
        let cfd_raw = unsafe {
            libc::openat(
                dir_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if cfd_raw < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let cfd = OwnedFd::from_raw(cfd_raw);
        let child_st = fstat_fd(cfd.as_raw()).map_err(|err| err.to_string())?;
        if let Some(found) = write_dir_tree(cfd.as_raw(), &child_st, child, rng)? {
            target = Some(found);
        }
    }
    for file in &node.files {
        persist_file(dir_fd, file, rng)?;
    }
    if node.readonly {
        let ro_mode: libc::mode_t = 0o500;
        // SAFETY: `dir_fd` is an open directory descriptor.
        if unsafe { libc::fchmod(dir_fd, ro_mode) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
    }
    fsync_fd(dir_fd).map_err(|err| err.to_string())?;
    Ok(target)
}

pub(crate) fn run_write(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: paperclip-artifact-io write".to_string());
    }
    let mut input = Vec::new();
    let limit = u64::try_from(MAX_STDIN_BYTES + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(limit)
        .read_to_end(&mut input)
        .map_err(|err| err.to_string())?;
    if input.len() > MAX_STDIN_BYTES {
        return Err("artifact_write_payload_too_large".to_string());
    }
    let req: WriteRequest = serde_json::from_slice(&input).map_err(|err| err.to_string())?;
    if req.node.name != "." {
        return Err("artifact_path_invalid".to_string());
    }
    let root_fd = open_pinned_root(req.dev, req.ino)?;
    let root_st = fstat_fd(root_fd.as_raw()).map_err(|err| err.to_string())?;
    let mut rng = File::open("/dev/urandom").map_err(|err| err.to_string())?;
    let target = write_dir_tree(root_fd.as_raw(), &root_st, &req.node, &mut rng)?;
    let encoded = serde_json::to_string(&target).map_err(|err| err.to_string())?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(encoded.as_bytes()).map_err(|err| err.to_string())?;
    stdout.flush().map_err(|err| err.to_string())
}

mod reader;
mod writer;

use std::ffi::CString;
use std::io;
use std::mem::MaybeUninit;
use std::process;

#[derive(Debug)]
pub(crate) struct OwnedFd(libc::c_int);

impl OwnedFd {
    pub(crate) fn from_raw(fd: libc::c_int) -> Self {
        Self(fd)
    }

    pub(crate) fn as_raw(&self) -> libc::c_int {
        self.0
    }
}

impl Drop for OwnedFd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            // SAFETY: OwnedFd exclusively owns this file descriptor until Drop.
            unsafe {
                libc::close(self.0);
            }
            self.0 = -1;
        }
    }
}

pub(crate) fn c_str(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "artifact_path_invalid".to_string())
}

pub(crate) fn stat_dot() -> io::Result<libc::stat> {
    let dot = CString::new(".").expect("static dot");
    let mut st = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `dot` is NUL-terminated and `st` is valid writable storage.
    let rc = unsafe { libc::stat(dot.as_ptr(), st.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `libc::stat` initialized `st` on success (`rc == 0`).
    Ok(unsafe { st.assume_init() })
}

pub(crate) fn fstat_fd(fd: libc::c_int) -> io::Result<libc::stat> {
    let mut st = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `fd` is a valid open descriptor and `st` is valid writable storage.
    let rc = unsafe { libc::fstat(fd, st.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `libc::fstat` initialized `st` on success (`rc == 0`).
    Ok(unsafe { st.assume_init() })
}

pub(crate) fn open_pinned_root(expected_dev: i128, expected_ino: i128) -> Result<OwnedFd, String> {
    let pre = stat_dot().map_err(|err| format!("artifact_root_stat_failed: {err}"))?;
    if !stat_matches_ids(&pre, expected_dev, expected_ino) {
        return Err("artifact_root_replaced".to_string());
    }
    let dot = CString::new(".").expect("static dot");
    // SAFETY: opening "." with O_RDONLY | O_DIRECTORY | O_NOFOLLOW has no variadic mode.
    let fd = unsafe {
        libc::open(
            dot.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let owned = OwnedFd::from_raw(fd);
    let post = fstat_fd(owned.as_raw()).map_err(|err| err.to_string())?;
    if !stat_matches_ids(&post, expected_dev, expected_ino) {
        return Err("artifact_root_replaced".to_string());
    }
    Ok(owned)
}

pub(crate) fn stat_matches_ids(st: &libc::stat, expected_dev: i128, expected_ino: i128) -> bool {
    i128::from(st.st_dev) == expected_dev && i128::from(st.st_ino) == expected_ino
}

pub(crate) fn same_inode(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}

pub(crate) fn is_regular_file(st: &libc::stat) -> bool {
    (st.st_mode & libc::S_IFMT) == libc::S_IFREG
}

pub(crate) fn stat_metadata_equal(a: &libc::stat, b: &libc::stat) -> bool {
    same_inode(a, b)
        && a.st_size == b.st_size
        && a.st_mtime == b.st_mtime
        && a.st_mtime_nsec == b.st_mtime_nsec
        && a.st_ctime == b.st_ctime
        && a.st_ctime_nsec == b.st_ctime_nsec
}

pub(crate) fn lstat_at(dir_fd: libc::c_int, name: &CString) -> Result<Option<libc::stat>, io::Error> {
    let mut st = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `dir_fd` is open, `name` is NUL-terminated, `st` is valid output storage.
    let rc = unsafe { libc::fstatat(dir_fd, name.as_ptr(), st.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    if rc != 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ENOENT) {
            return Ok(None);
        }
        return Err(err);
    }
    // SAFETY: `fstatat` initialized `st` on success.
    Ok(Some(unsafe { st.assume_init() }))
}

pub(crate) fn write_all_fd(fd: libc::c_int, bytes: &[u8]) -> Result<(), String> {
    let mut written = 0_usize;
    while written < bytes.len() {
        let src = &bytes[written..];
        // SAFETY: `fd` is open for writing and `src` is valid readable memory.
        let n = unsafe { libc::write(fd, src.as_ptr().cast(), src.len()) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err.to_string());
        }
        written += usize::try_from(n).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(crate) fn fsync_fd(fd: libc::c_int) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is a valid open descriptor.
        let rc = unsafe { libc::fsync(fd) };
        if rc == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("read") => reader::run_read(&args[1..]),
        Some("write") => writer::run_write(&args[1..]),
        _ => Err("usage: paperclip-artifact-io <read|write> ...".to_string()),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

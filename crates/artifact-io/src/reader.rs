use std::io::{self, Write};

use crate::{
    c_str, fstat_fd, is_regular_file, open_pinned_root, stat_metadata_equal, OwnedFd,
};

const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn parse_relative_segments(relative: &str) -> Result<Vec<&str>, String> {
    if relative.is_empty() || relative.starts_with('/') || relative.contains('\0') || relative.contains('\\') {
        return Err("artifact_path_invalid".to_string());
    }
    let segments: Vec<&str> = relative.split('/').collect();
    if segments.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Err("artifact_path_invalid".to_string());
    }
    Ok(segments)
}

fn stat_unchanged(before: &libc::stat, after: &libc::stat, read_len: usize) -> bool {
    stat_metadata_equal(before, after)
        && usize::try_from(before.st_size).is_ok_and(|sz| sz == read_len)
}

fn open_dir_nofollow(parent_fd: libc::c_int, segment: &str) -> Result<OwnedFd, String> {
    let name = c_str(segment)?;
    // SAFETY: `parent_fd` is an open directory fd and `name` is NUL-terminated.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(OwnedFd::from_raw(fd))
}

fn open_leaf_nofollow(parent_fd: libc::c_int, segment: &str) -> Result<OwnedFd, String> {
    let name = c_str(segment)?;
    // SAFETY: `parent_fd` is an open directory fd and `name` is NUL-terminated.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(OwnedFd::from_raw(fd))
}

fn read_all_bounded(fd: libc::c_int, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0_u8; max_bytes + 1];
    let mut total = 0_usize;
    while total < buf.len() {
        let rest = &mut buf[total..];
        // SAFETY: `fd` is open and `rest` points to valid mutable byte storage.
        let n = unsafe { libc::read(fd, rest.as_mut_ptr().cast(), rest.len()) };
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
        total += n as usize;
        if total > max_bytes {
            return Err("artifact_oversize".to_string());
        }
    }
    buf.truncate(total);
    Ok(buf)
}

pub(crate) fn read_pinned_bytes(
    relative: &str,
    expected_dev: i128,
    expected_ino: i128,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if max_bytes == 0 || max_bytes > MAX_ARTIFACT_BYTES {
        return Err("artifact_path_invalid".to_string());
    }
    let segments = parse_relative_segments(relative)?;
    let mut current_dir = open_pinned_root(expected_dev, expected_ino)?;
    for segment in &segments[..segments.len() - 1] {
        current_dir = open_dir_nofollow(current_dir.as_raw(), segment)?;
    }
    let leaf = open_leaf_nofollow(current_dir.as_raw(), segments[segments.len() - 1])?;
    let before = fstat_fd(leaf.as_raw()).map_err(|err| err.to_string())?;
    if !is_regular_file(&before)
        || !usize::try_from(before.st_size).is_ok_and(|sz| sz <= max_bytes)
    {
        return Err("artifact_file_invalid".to_string());
    }
    let bytes = read_all_bounded(leaf.as_raw(), max_bytes)?;
    let after = fstat_fd(leaf.as_raw()).map_err(|err| err.to_string())?;
    if !stat_unchanged(&before, &after, bytes.len()) {
        return Err("artifact_changed".to_string());
    }
    Ok(bytes)
}

pub(crate) fn run_read(args: &[String]) -> Result<(), String> {
    if args.len() != 4 {
        return Err("usage: paperclip-artifact-io read <relative> <dev> <ino> <max_bytes>".to_string());
    }
    let dev = args[1]
        .parse::<i128>()
        .map_err(|_| "artifact_path_invalid".to_string())?;
    let ino = args[2]
        .parse::<i128>()
        .map_err(|_| "artifact_path_invalid".to_string())?;
    let max_bytes = args[3]
        .parse::<usize>()
        .map_err(|_| "artifact_path_invalid".to_string())?;
    let bytes = read_pinned_bytes(&args[0], dev, ino, max_bytes)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes).map_err(|err| err.to_string())?;
    stdout.flush().map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_relative_segments;

    #[test]
    fn rejects_invalid_and_traversal_paths() {
        for bad in ["", "/", ".", "..", "a/../b", "a//b", "a/./b", r"a\b", "a\0b"] {
            assert_eq!(parse_relative_segments(bad), Err("artifact_path_invalid".to_string()));
        }
        assert_eq!(parse_relative_segments("a/b/c.json"), Ok(vec!["a", "b", "c.json"]));
    }
}

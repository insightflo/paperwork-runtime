use std::fmt::{self, Write as _};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use sha2::{Digest, Sha256};

const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const MAX_READ_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const TEMP_ATTEMPTS: u128 = 16;

#[derive(Debug)]
pub(crate) enum RunLogError {
    InvalidInput(String),
    NotFound,
    Io(io::Error),
}

impl fmt::Display for RunLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(msg) => f.write_str(msg),
            Self::NotFound => f.write_str(r#"{"error":"not_found"}"#),
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl From<io::Error> for RunLogError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalizeResponse {
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
    pub(crate) compressed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadRangeResponse {
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) next_offset: Option<u64>,
}

struct TempGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

enum LogFile {
    Plain(File),
    Gz(File),
}

/// Validate that `p` is a non-empty, NUL-free, absolute file path.
pub(crate) fn validate_abs_path(p: &str) -> Result<&Path, RunLogError> {
    if p.is_empty() || p.contains('\0') {
        return Err(RunLogError::InvalidInput("invalid_log_path".to_string()));
    }
    let path = Path::new(p);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(RunLogError::InvalidInput("log_path_must_be_absolute".to_string()));
    }
    Ok(path)
}

fn open_regular(path: &Path) -> Result<Option<File>, RunLogError> {
    // Pre-open check keeps FIFOs and symlinked non-files from blocking File::open;
    // symlink_metadata inspects only the final path component.
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(RunLogError::Io(err)),
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(RunLogError::InvalidInput("log_path_not_regular_file".to_string()));
        }
        Ok(_) => {}
    }
    match File::open(path) {
        Ok(file) => {
            if !file.metadata()?.is_file() {
                return Err(RunLogError::InvalidInput("log_path_not_regular_file".to_string()));
            }
            Ok(Some(file))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(RunLogError::Io(err)),
    }
}

fn open_log_file(path: &str) -> Result<LogFile, RunLogError> {
    let abs = validate_abs_path(path)?;
    if path.ends_with(".gz") {
        return open_regular(abs)?.map(LogFile::Gz).ok_or(RunLogError::NotFound);
    }
    if let Some(file) = open_regular(abs)? {
        return Ok(LogFile::Plain(file));
    }
    let gz_path = format!("{path}.gz");
    open_regular(Path::new(&gz_path))?
        .map(LogFile::Gz)
        .ok_or(RunLogError::NotFound)
}

fn format_sha256(hasher: Sha256) -> String {
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn create_unique_temp(gz_path_str: &str) -> Result<(PathBuf, File), RunLogError> {
    let pid = std::process::id();
    let base_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..TEMP_ATTEMPTS {
        let candidate = PathBuf::from(format!("{gz_path_str}.{pid}.{}.tmp", base_nanos + attempt));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(RunLogError::Io(err)),
        }
    }
    Err(RunLogError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed_to_allocate_unique_temp_file",
    )))
}

fn stream_and_hash<R: Read, F: FnMut(&[u8]) -> io::Result<()>>(
    reader: &mut R,
    mut on_chunk: F,
) -> io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buf = [0_u8; STREAM_CHUNK_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                hasher.update(chunk);
                bytes += n as u64;
                on_chunk(chunk)?;
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok((bytes, format_sha256(hasher)))
}

fn finalize_existing_gz(gz_file: File) -> Result<FinalizeResponse, RunLogError> {
    let mut decoder = MultiGzDecoder::new(BufReader::with_capacity(STREAM_CHUNK_BYTES, gz_file));
    let (bytes, sha256) = stream_and_hash(&mut decoder, |_| Ok(()))?;
    Ok(FinalizeResponse { bytes, sha256, compressed: true })
}

fn compress_and_replace(
    src_path: &Path,
    gz_path_str: &str,
    src_file: File,
) -> Result<FinalizeResponse, RunLogError> {
    let gz_path = Path::new(gz_path_str);
    let (tmp_path, tmp_file) = create_unique_temp(gz_path_str)?;
    let src_mode = src_file.metadata().ok().map(|m| m.permissions());
    // Guard declared before encoder so encoder/file drops before cleanup on error.
    let mut guard = TempGuard { path: tmp_path.clone(), armed: true };

    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, src_file);
    let mut encoder = GzEncoder::new(
        BufWriter::with_capacity(STREAM_CHUNK_BYTES, tmp_file),
        Compression::fast(),
    );
    let (bytes, sha256) = stream_and_hash(&mut reader, |chunk| encoder.write_all(chunk))?;

    let mut buf_writer = encoder.finish()?;
    buf_writer.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Never widen beyond the source: src 0o600 → gz 0o600, src 0o644 → gz 0o600.
        let capped = src_mode.map(|m| m.mode() & 0o600).unwrap_or(0o600);
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(capped))?;
    }
    let synced_file = buf_writer.into_inner().map_err(io::Error::from)?;
    synced_file.sync_all()?;
    drop(synced_file);

    fs::rename(&tmp_path, gz_path)?;
    guard.armed = false;

    if let Some(parent) = gz_path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    match fs::remove_file(src_path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(RunLogError::Io(err)),
    }

    Ok(FinalizeResponse { bytes, sha256, compressed: true })
}

/// Compress `<path>` to `<path>.gz` atomically and return uncompressed stats, or stream `<path>.gz` idempotently.
pub(crate) fn finalize_file(path: &str) -> Result<FinalizeResponse, RunLogError> {
    match open_log_file(path)? {
        LogFile::Gz(gz_file) => finalize_existing_gz(gz_file),
        LogFile::Plain(src_file) => {
            let gz_path_str = format!("{path}.gz");
            compress_and_replace(Path::new(path), &gz_path_str, src_file)
        }
    }
}

fn read_up_to<R: Read>(reader: &mut R, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(max_bytes.min(STREAM_CHUNK_BYTES));
    let mut chunk = [0_u8; STREAM_CHUNK_BYTES];
    while out.len() < max_bytes {
        let want = (max_bytes - out.len()).min(chunk.len());
        match reader.read(&mut chunk[..want]) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(out)
}

fn build_read_response(mut buf: Vec<u8>, offset: u64, limit: usize) -> ReadRangeResponse {
    let has_more = buf.len() > limit;
    if has_more {
        buf.truncate(limit);
    }
    ReadRangeResponse {
        content: String::from_utf8_lossy(&buf).into_owned(),
        next_offset: has_more.then(|| offset.saturating_add(limit as u64)),
    }
}

/// Read up to `limit_bytes` (clamped to `[1, 16 MiB]`) starting at byte `offset` from `<path>` or `<path>.gz`.
pub(crate) fn read_range(
    path: &str,
    offset: u64,
    limit_bytes: usize,
) -> Result<ReadRangeResponse, RunLogError> {
    let limit = limit_bytes.clamp(1, MAX_READ_LIMIT_BYTES);
    match open_log_file(path)? {
        LogFile::Plain(mut file) => {
            file.seek(SeekFrom::Start(offset))?;
            let buf = read_up_to(&mut file, limit + 1)?;
            Ok(build_read_response(buf, offset, limit))
        }
        LogFile::Gz(file) => {
            let mut decoder = MultiGzDecoder::new(BufReader::with_capacity(STREAM_CHUNK_BYTES, file));
            if offset > 0 {
                io::copy(&mut decoder.by_ref().take(offset), &mut io::sink())?;
            }
            let buf = read_up_to(&mut decoder, limit + 1)?;
            Ok(build_read_response(buf, offset, limit))
        }
    }
}

// crates/qa-file-owner/src/protocol.rs
//
// [purpose] v=1 JSON-lines protocol surface — shared constants, refusal/internal error
//   types, process state, stdio framing (read_line/send), and the Python-shaped message
//   formatting helpers used across the crate.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::os::unix::io::RawFd;
use std::process::exit;

pub(crate) const V: i64 = 1;
pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: usize = 2 * 1024 * 1024; // QA_REMEDIATION_MAX_FILE_BYTES 와 동일
pub(crate) const MAX_ID_BYTES: usize = 256;

/// Refusal — typed protocol rejection (error reply + exit 2), mirrors Python `Refusal`.
/// Internal — unexpected OS/IO failure (code "internal" reply + exit 3), mirrors a generic
/// Python exception escaping `main()`.
pub(crate) enum Denied {
    Refusal(&'static str, String),
    Internal(String),
}

impl std::fmt::Debug for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Denied::Refusal(c, m) => write!(f, "Refusal({c}: {m})"),
            Denied::Internal(m) => write!(f, "Internal({m})"),
        }
    }
}

pub(crate) fn refuse(code: &'static str, message: impl Into<String>) -> Denied {
    Denied::Refusal(code, message.into())
}

/// Frame-level failure — a Refusal carries the reply id (rid when valid, else null).
pub(crate) enum FrameErr {
    Refusal { code: &'static str, message: String, id: Value },
    Internal(String),
}

pub(crate) enum Outcome {
    Continue,
    Done(i32),
}

pub(crate) struct State {
    pub(crate) guards: HashMap<String, RawFd>,
    pub(crate) begun: bool,
}

// ---------------------------------------------------------------------------
// stdio framing
// ---------------------------------------------------------------------------

/// Write one JSON frame + '\n' to fd 1. BrokenPipe → silent exit 0 (parent vanished; locks die
/// with the process). Any other write failure → best-effort internal frame, exit 3.
pub(crate) fn send(frame: &Value) {
    let mut payload = serde_json::to_string(frame).expect("frame serialization cannot fail");
    payload.push('\n');
    write_fd1(payload.as_bytes());
}

fn write_fd1(mut bytes: &[u8]) {
    while !bytes.is_empty() {
        let n = unsafe { libc::write(1, bytes.as_ptr() as *const libc::c_void, bytes.len()) };
        if n > 0 {
            bytes = &bytes[n as usize..];
            continue;
        }
        let error = if n == 0 {
            io::Error::new(io::ErrorKind::WriteZero, "write returned 0")
        } else {
            io::Error::last_os_error()
        };
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::EPIPE) => exit(0),
            _ => {
                let fallback = format!(
                    "{}\n",
                    json!({"v": V, "id": Value::Null, "type": "error", "code": "internal",
                           "message": format!("OSError: {error}")})
                );
                unsafe {
                    libc::write(1, fallback.as_ptr() as *const libc::c_void, fallback.len());
                }
                exit(3);
            }
        }
    }
}

fn read_fd0(chunk: &mut [u8]) -> Result<usize, Denied> {
    loop {
        let n = unsafe { libc::read(0, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue; // PEP 475 parity — restartable syscalls retry transparently
        }
        return Err(Denied::Internal(py_err(&error)));
    }
}

/// Read exactly one '\n'-terminated frame. Carries leftover bytes between calls (like the
/// Python `_BUF`). Cap is enforced while accumulating and again after the split.
pub(crate) fn read_line(buf: &mut Vec<u8>) -> Result<Option<String>, Denied> {
    loop {
        if let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            if pos > MAX_LINE_BYTES {
                return Err(refuse("line_too_long", "input line exceeds frame cap"));
            }
            let raw: Vec<u8> = buf.drain(..=pos).collect();
            return String::from_utf8(raw[..pos].to_vec())
                .map(Some)
                .map_err(|_| refuse("bad_json", "line is not JSON"));
        }
        if buf.len() > MAX_LINE_BYTES {
            return Err(refuse("line_too_long", "input line exceeds frame cap"));
        }
        let mut chunk = [0u8; 65536];
        let n = read_fd0(&mut chunk)?;
        if n == 0 {
            if buf.iter().any(|b| !is_py_whitespace(*b)) {
                return Err(refuse("bad_json", "eof mid-line"));
            }
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Python `bytes.strip()` whitespace set (includes \x0b unlike `is_ascii_whitespace`).
fn is_py_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/// Approximate Python's `f"{type(e).__name__}: {e}"` for io::Error so internal/preflight
/// messages keep the Python helper's shape.
pub(crate) fn py_err(e: &io::Error) -> String {
    let name = match e.raw_os_error() {
        Some(libc::ENOENT) => "FileNotFoundError",
        Some(libc::EACCES) | Some(libc::EPERM) => "PermissionError",
        Some(libc::EEXIST) => "FileExistsError",
        Some(libc::ENOTDIR) => "NotADirectoryError",
        Some(libc::EISDIR) => "IsADirectoryError",
        _ => "OSError",
    };
    format!("{name}: {e}")
}

fn hex_lower(data: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(data.len() * 2);
    for b in data {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex_lower(&Sha256::digest(data))
}

/// Approximation of Python `repr()` for the values that appear in refusal messages.
pub(crate) fn py_repr(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".to_string(),
        Some(Value::Bool(b)) => if *b { "True" } else { "False" }.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => py_repr_str(s),
        Some(other) => other.to_string(),
    }
}

fn py_repr_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

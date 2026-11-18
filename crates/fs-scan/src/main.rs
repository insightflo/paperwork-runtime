mod machine_checks;
mod session_count;

use std::fmt::Write as _;
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::process;

use sha2::{Digest, Sha256};

const STREAM_CHUNK_BYTES: usize = 64 * 1024;

pub(crate) fn sha256_file_hex(path: &str) -> io::Result<String> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, file);
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; STREAM_CHUNK_BYTES];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

pub(crate) fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("session-count") => session_count::run_session_count(&args[1..]),
        Some("file-hashes") => session_count::run_file_hashes(&args[1..]),
        Some("machine-checks") => machine_checks::run_machine_checks(&args[1..]),
        _ => Err("usage: paperclip-fs-scan <session-count|file-hashes|machine-checks> ...".to_string()),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

mod ops;

use std::io::{self, IsTerminal, Read, Write};
use std::process;

use serde::{Deserialize, Serialize};

use ops::RunLogError;

const MAX_STDIN_BYTES: usize = 64 * 1024;
const DEFAULT_LIMIT_BYTES: usize = 256_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeRequest {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRangeRequest {
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default = "default_limit_bytes")]
    limit_bytes: usize,
}

fn default_limit_bytes() -> usize {
    DEFAULT_LIMIT_BYTES
}

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, RunLogError> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(RunLogError::Io)?;
    if buf.len() > max_bytes {
        return Err(RunLogError::InvalidInput(
            "stdin_payload_too_large".to_string(),
        ));
    }
    Ok(buf)
}

fn write_json_stdout<T: Serialize>(value: &T) -> Result<(), RunLogError> {
    let encoded =
        serde_json::to_string(value).map_err(|err| RunLogError::Io(io::Error::other(err.to_string())))?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{encoded}")?;
    stdout.flush()?;
    Ok(())
}

fn run() -> Result<(), RunLogError> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 1 || !matches!(args[0].as_str(), "finalize" | "read-range") {
        // Drain up to MAX_STDIN_BYTES of piped stdin so small payloads don't EPIPE the writer; larger payloads still see EPIPE.
        if !io::stdin().is_terminal() {
            let _ = read_stdin_bounded(MAX_STDIN_BYTES);
        }
        return Err(RunLogError::InvalidInput(
            "usage: paperclip-run-log <finalize|read-range>".to_string(),
        ));
    }
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    match args[0].as_str() {
        "finalize" => {
            let req: FinalizeRequest = serde_json::from_slice(&raw)
                .map_err(|err| RunLogError::InvalidInput(err.to_string()))?;
            let resp = ops::finalize_file(&req.path)?;
            write_json_stdout(&resp)
        }
        "read-range" => {
            let req: ReadRangeRequest = serde_json::from_slice(&raw)
                .map_err(|err| RunLogError::InvalidInput(err.to_string()))?;
            let resp = ops::read_range(&req.path, req.offset, req.limit_bytes)?;
            write_json_stdout(&resp)
        }
        // Unreachable: validated above.
        _ => Err(RunLogError::InvalidInput(
            "usage: paperclip-run-log <finalize|read-range>".to_string(),
        )),
    }
}

fn main() {
    match run() {
        Ok(()) => {}
        Err(RunLogError::NotFound) => {
            let _ = writeln!(io::stderr(), r#"{{"error":"not_found"}}"#);
            process::exit(2);
        }
        Err(err) => {
            let _ = writeln!(io::stderr(), "{err}");
            process::exit(1);
        }
    }
}

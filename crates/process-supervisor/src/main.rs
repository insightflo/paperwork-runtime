use serde_json::json;
use std::process::ExitCode;

fn fail(code: u8, error: &str, unreaped_pids: &[i32]) -> ExitCode {
    eprintln!(
        "{}",
        json!({"ok": false, "error": error, "unreaped_pids": unreaped_pids})
    );
    ExitCode::from(code)
}

fn main() -> ExitCode {
    let mut help = false;
    for arg in std::env::args_os().skip(1) {
        match arg.to_str() {
            Some("--help" | "-h") => help = true,
            _ => {
                return fail(
                    2,
                    &format!("unknown_argument:{}", arg.to_string_lossy()),
                    &[],
                )
            }
        }
    }
    if help {
        println!("Usage: paperclip-process-supervisor [--help|-h]\nReads one JSON spawn spec (up to 64 KiB) from stdin and writes a JSON outcome.");
        return ExitCode::SUCCESS;
    }
    run()
}

#[cfg(unix)]
fn normalize_sigchld() -> std::io::Result<()> {
    // SAFETY: Initialize the action and its mask before passing it to sigaction.
    // Zero flags clear SA_NOCLDWAIT so we retain exclusive wait ownership.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        if libc::sigemptyset(&mut action.sa_mask) != 0
            || libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn run() -> ExitCode {
    use paperclip_process_supervisor::{run_supervised, take_unreaped_pids, SupervisedSpawnSpec};
    use std::io::{self, Read, Write};

    if let Err(err) = normalize_sigchld() {
        return fail(1, &format!("sigchld_normalization_failed:{err}"), &[]);
    }
    let mut buf = Vec::new();
    if let Err(err) = io::stdin().take(65_537).read_to_end(&mut buf) {
        return fail(1, &format!("stdin_read_failed:{err}"), &[]);
    }
    if buf.len() > 65_536 {
        return fail(1, "stdin_too_large", &[]);
    }
    let spec: SupervisedSpawnSpec = match serde_json::from_slice(&buf) {
        Ok(spec) => spec,
        Err(err) => return fail(1, &format!("invalid_json:{err}"), &[]),
    };
    let outcome = match run_supervised(&spec) {
        Ok(outcome) => outcome,
        Err(err) => return fail(1, &format!("{err:?}"), &take_unreaped_pids()),
    };
    let line = match serde_json::to_string(&outcome) {
        Ok(line) => line,
        Err(err) => return fail(1, &format!("outcome_serialization_failed:{err}"), &[]),
    };
    if let Err(err) = writeln!(io::stdout().lock(), "{line}") {
        return fail(1, &format!("stdout_write_failed:{err}"), &[]);
    }
    ExitCode::SUCCESS
}

#[cfg(not(unix))]
fn run() -> ExitCode {
    fail(1, "unsupported_platform", &[])
}

#[cfg(unix)]
use paperclip_claude_quota_pty::*;
use std::process::ExitCode;

fn fail(code: u8, error: &str) -> ExitCode {
    eprintln!("paperclip-claude-quota-pty: {error}");
    code.into()
}

#[cfg(unix)]
fn probe_spec() -> Result<PtyProbeSpec, String> {
    let mut args = std::env::args_os().skip(1);
    let timeout_ms = match args.next() {
        None => 12000,
        Some(flag) if flag == "--timeout-ms" => args
            .next()
            .and_then(|value| value.to_str()?.parse::<u64>().ok())
            .ok_or("--timeout-ms needs an unsigned integer")?
            .clamp(1000, 60000),
        Some(flag) => return Err(format!("unknown flag: {flag:?}")),
    };
    if let Some(flag) = args.next() {
        return Err(format!("unexpected argument: {flag:?}"));
    }
    let program = match std::env::var("CLAUDE_CLI_PATH") {
        Ok(path) if std::path::Path::new(&path).is_absolute() => path,
        Err(std::env::VarError::NotPresent) => "claude".into(),
        _ => return Err("CLAUDE_CLI_PATH must be a non-empty absolute UTF-8 path".into()),
    };
    Ok(PtyProbeSpec {
        program,
        args: vec!["--tools".into(), "".into()],
        timeout_ms,
        strip_anthropic_env: true,
        inputs: [(2000, &b"/usage\r"[..]), (8000, b"\x1b"), (9000, b"\x03")]
            .into_iter()
            .map(|(delay_ms, bytes)| ScheduledInput { delay_ms, bytes: bytes.to_vec() })
            .collect(),
    })
}

#[cfg(unix)]
fn main() -> ExitCode {
    if let Err(e) = reset_sigchld_default().and_then(|()| install_cancel_signal_handlers()) {
        return fail(1, &e);
    }
    let spec = match probe_spec() {
        Ok(spec) => spec,
        Err(e) => return fail(2, &e),
    };
    use std::io::Write;
    match run_pty_probe(&spec).and_then(|report| serde_json::to_string(&report).map_err(|e| e.to_string())) {
        Ok(json) => match writeln!(std::io::stdout().lock(), "{json}") {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(1, &e.to_string()),
        },
        Err(e) => fail(1, &e),
    }
}

#[cfg(not(unix))]
fn main() -> ExitCode {
    fail(1, "PTY probes require Unix")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::{fs::File, io::Read, os::fd::{AsRawFd, FromRawFd}, process::Command, sync::Mutex, time::{Duration, Instant}};

    // Keep the intentional FD inheritance isolated from other probes.
    static TEST: Mutex<()> = Mutex::new(());
    fn shell(script: &str) -> PtyProbeSpec {
        PtyProbeSpec {
            program: "/bin/sh".into(), args: vec!["-c".into(), script.into()],
            timeout_ms: 3000, strip_anthropic_env: true, inputs: vec![],
        }
    }
    #[test]
    fn scheduled_echo() {
        let _lock = TEST.lock().unwrap();
        let mut spec = shell("stty -echo; IFS= read -r line && printf '<%s>\\n' \"$line\"");
        spec.inputs.push(ScheduledInput { delay_ms: 150, bytes: b"hello\r".to_vec() });
        let got = run_pty_probe(&spec).unwrap();
        assert_eq!((got.exit_code, got.schema_version, got.timed_out), (Some(0), 1, false));
        assert_eq!(got.output, "<hello>\r\n");
    }

    fn sentinel(block_leader: bool) -> (PtyProbeSpec, File, File) {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (reader, writer) = unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
        let tail = if block_leader { "IFS= read -r unused" } else { "exit 0" };
        let spec = shell(&format!(
            "trap '' TERM HUP; (printf x > /dev/fd/{}; exec /bin/sleep 10) & {tail}",
            writer.as_raw_fd(),
        ));
        (spec, reader, writer)
    }
    fn pipe_ready(reader: &File, ms: i32) {
        let mut pfd = libc::pollfd { fd: reader.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        assert_eq!(unsafe { libc::poll(&mut pfd, 1, ms) }, 1, "sentinel pipe not ready");
    }
    #[test]
    fn leader_exits_before_descendant() {
        let _lock = TEST.lock().unwrap();
        let (spec, mut reader, writer) = sentinel(false);
        let got = run_pty_probe(&spec).unwrap();
        drop(writer);
        assert_eq!(got.exit_code, Some(0));
        assert!(!got.timed_out);
        pipe_ready(&reader, 500);
        let mut marker = [0];
        reader.read_exact(&mut marker).unwrap();
        assert_eq!(&marker, b"x");
        pipe_ready(&reader, 500);
        assert_eq!(reader.read(&mut marker).unwrap(), 0, "descendant still owns sentinel");
    }
    #[test]
    fn outer_cancel() { check_cancel("tests::outer_cancel", false); }
    #[test]
    fn inherited_sigterm_mask() { check_cancel("tests::inherited_sigterm_mask", true); }

    #[cfg(target_os = "macos")]
    #[test]
    fn shipped_binary_cancels_yes_with_blocked_sigterm() {
        use std::process::Stdio;
        let _lock = TEST.lock().unwrap();
        // Unit-test targets don't get CARGO_BIN_EXE; locate the actual build artifact.
        let build = Command::new(env!("CARGO"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args(["build", "--locked", "--bin", env!("CARGO_PKG_NAME"), "--message-format=json"])
            .output().unwrap();
        assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
        let binary = String::from_utf8(build.stdout).unwrap().lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find_map(|event| event["executable"].as_str().map(str::to_owned)).unwrap();
        let mut command = Command::new(binary);
        command.env("CLAUDE_CLI_PATH", "/usr/bin/yes").args(["--timeout-ms", "5000"])
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        unsafe { command.pre_exec(block_sigterm); }
        let child = command.spawn().unwrap();
        let pid = child.id().to_string();
        let start = Instant::now();
        // Wait for yes to exec, not merely for the helper to spawn.
        let ready = loop {
            let ps = Command::new("/bin/ps").args(["-axo", "ppid=,comm="]).output().unwrap();
            assert!(ps.status.success());
            if String::from_utf8_lossy(&ps.stdout).lines().any(|line| {
                let mut fields = line.split_whitespace();
                fields.next() == Some(pid.as_str()) && fields.next() == Some("/usr/bin/yes")
            }) { break true; }
            if start.elapsed() >= Duration::from_secs(2) { break false; }
            std::thread::sleep(Duration::from_millis(5));
        };
        let sent = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let got = child.wait_with_output().unwrap();
        assert!(ready, "yes did not start");
        assert_eq!(sent, 0);
        assert_eq!(got.status.code(), Some(0), "{}", String::from_utf8_lossy(&got.stderr));
        let report: serde_json::Value = serde_json::from_slice(&got.stdout).unwrap();
        assert_eq!(report["timed_out"].as_bool(), Some(false));
        assert_eq!(report["signal"].as_i64(), Some(i64::from(libc::SIGTERM)));
    }

    fn block_sigterm() -> std::io::Result<()> {
        unsafe {
            let mut set = std::mem::zeroed();
            if libc::sigemptyset(&mut set) != 0 || libc::sigaddset(&mut set, libc::SIGTERM) != 0
                || libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn check_cancel(test: &str, inherited_mask: bool) {
        const ISOLATE: &str = "PAPERCLIP_PTY_TEST_CANCEL_CHILD";
        if std::env::var_os(ISOLATE).is_none() {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", test]).env(ISOLATE, "1");
            if inherited_mask {
                unsafe { command.pre_exec(block_sigterm); }
            }
            assert!(command.status().unwrap().success());
            return;
        }
        if inherited_mask { install_cancel_signal_handlers().unwrap(); }
        let (spec, mut reader, writer) = sentinel(true);
        let start = Instant::now();
        let trigger = std::thread::spawn(move || {
            pipe_ready(&reader, 2000);
            let mut marker = [0];
            reader.read_exact(&mut marker).unwrap();
            assert_eq!(&marker, b"x");
            if inherited_mask {
                assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGTERM) }, 0);
            } else {
                request_cancel();
            }
            reader
        });
        let got = run_pty_probe(&spec).unwrap();
        drop(writer);
        let mut reader = trigger.join().unwrap();
        assert_eq!(got.signal, Some(libc::SIGKILL));
        assert!(!got.timed_out);
        assert!(start.elapsed() < Duration::from_secs(2));
        pipe_ready(&reader, 500);
        assert_eq!(reader.read(&mut [0]).unwrap(), 0);
    }
    #[test]
    fn capture_limit_and_deadline() {
        let _lock = TEST.lock().unwrap();
        let mut spec = shell("trap '' TERM; exec /usr/bin/yes x");
        spec.timeout_ms = 500;
        let start = Instant::now();
        let got = run_pty_probe(&spec).unwrap();
        assert!(got.timed_out && got.truncated);
        assert_eq!(got.output.len(), MAX_CAPTURE_BYTES);
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn leader_exits_during_term_grace() {
        let _lock = TEST.lock().unwrap();
        let mut spec = shell("exec /bin/sleep 10");
        spec.timeout_ms = 500;
        let got = run_pty_probe(&spec).unwrap();
        assert_eq!((got.timed_out, got.signal), (true, Some(libc::SIGTERM)));
    }
    #[test]
    fn spawn_error_does_not_leak_fds() {
        let _lock = TEST.lock().unwrap();
        let mut spec = shell("");
        spec.program = "/dev/null/nonexistent-pty-probe".into();
        let fd_count = || std::fs::read_dir("/dev/fd").unwrap().count();
        let before = fd_count();
        let check = File::open("/dev/null").unwrap();
        assert_eq!(fd_count(), before + 1);
        drop(check);
        for _ in 0..8 {
            assert!(run_pty_probe(&spec).unwrap_err().starts_with("spawn:"));
        }
        assert_eq!(fd_count(), before);
    }
    #[test]
    fn normal_exit() {
        let _lock = TEST.lock().unwrap();
        let got = run_pty_probe(&shell("exit 0")).expect("expected Ok");
        assert_eq!(got.exit_code, Some(0));
        assert!(!got.timed_out);
    }
}

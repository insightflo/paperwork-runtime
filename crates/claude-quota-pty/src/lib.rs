//! Bounded PTY capture for a helper that exclusively owns its child's wait status.
//! Linux PR_SET_PDEATHSIG and a PPID check cover the direct child on helper SIGKILL.
//! Group signals cover same-group descendants on normal exit, timeout, SIGTERM and
//! errors. Descendants that escape via setsid(), and helper SIGKILL on macOS, are
//! outside the guarantees of a single helper. macOS can return EPERM from
//! killpg for a group containing only zombies; this is reported as a cleanup error.

pub struct ScheduledInput {
    pub delay_ms: u64,
    pub bytes: Vec<u8>,
}
pub struct PtyProbeSpec {
    pub program: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub strip_anthropic_env: bool,
    pub inputs: Vec<ScheduledInput>,
}
#[derive(Debug, serde::Serialize)]
pub struct PtyProbeResult {
    pub schema_version: u32,
    pub output: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_CAPTURE_BYTES: usize = 256 * 1024;
pub const MAX_READ_PER_TICK: usize = 16 * 1024;
pub const TERM_GRACE_MS: u64 = 300;
pub const REAP_TIMEOUT_MS: u64 = 1000;
pub const EXIT_DRAIN_MS: u64 = 150;

use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
static CANCELLED: AtomicBool = AtomicBool::new(false);
pub fn is_cancelled() -> bool {
    CANCELLED.load(Relaxed)
}
/// Cancels probes in this helper for the remainder of its lifetime.
pub fn request_cancel() {
    CANCELLED.store(true, Relaxed);
}

#[cfg(unix)]
mod unix {
    use super::*;
    use libc::*;
    use std::io;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::ptr::{null, null_mut};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    fn cvt(ret: c_int) -> io::Result<c_int> {
        if ret < 0 { Err(io::Error::last_os_error()) } else { Ok(ret) }
    }
    fn set_signal(sig: c_int, handler: sighandler_t) -> Result<(), String> {
        let mut action: sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = handler;
        cvt(unsafe { sigemptyset(&mut action.sa_mask) }).map_err(|e| e.to_string())?;
        cvt(unsafe { sigaction(sig, &action, null_mut()) }).map(|_| ()).map_err(|e| e.to_string())
    }
    extern "C" fn cancel(_: c_int) { request_cancel(); }
    pub fn install_cancel_signal_handlers() -> Result<(), String> {
        for sig in [SIGTERM, SIGINT] {
            set_signal(sig, cancel as *const () as sighandler_t)?;
        }
        Ok(())
    }
    pub fn reset_sigchld_default() -> Result<(), String> {
        set_signal(SIGCHLD, SIG_DFL)
    }

    struct PtyChildGuard {
        owned_pid: Option<pid_t>,
        master: Option<OwnedFd>,
    }
    impl PtyChildGuard {
        fn exited(&mut self, pid: pid_t) -> Result<bool, String> {
            let mut si: siginfo_t = unsafe { std::mem::zeroed() };
            match cvt(unsafe { waitid(P_PID, pid as id_t, &mut si, WEXITED | WNOHANG | WNOWAIT) }) {
                Ok(_) => Ok(unsafe { si.si_pid() } != 0
                    && matches!(si.si_code, CLD_EXITED | CLD_KILLED | CLD_DUMPED)),
                Err(e) if e.raw_os_error() == Some(ECHILD) => {
                    self.owned_pid = None;
                    Err("unexpected_echild".into())
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => Ok(false),
                Err(e) => Err(format!("waitid: {e}")),
            }
        }
        fn cleanup(&mut self) -> Result<c_int, String> {
            let Some(pid) = self.owned_pid.take() else {
                self.master.take();
                return Ok(0);
            };
            // The unreaped leader reserves its PID/PGID throughout escalation.
            let mut errors = Vec::new();
            let mut signal = |name, ret| {
                if let Err(e) = cvt(ret) {
                    if e.raw_os_error() != Some(ESRCH) {
                        errors.push(format!("{name}: {e}"));
                    }
                }
            };
            signal("killpg SIGTERM", unsafe { killpg(pid, SIGTERM) });
            sleep(Duration::from_millis(TERM_GRACE_MS));
            signal("killpg SIGKILL", unsafe { killpg(pid, SIGKILL) });
            signal("kill SIGKILL", unsafe { kill(pid, SIGKILL) });
            self.master.take();
            let deadline = Instant::now() + Duration::from_millis(REAP_TIMEOUT_MS);
            let mut status = 0;
            loop {
                match cvt(unsafe { waitpid(pid, &mut status, WNOHANG) }) {
                    Ok(n) if n == pid && (WIFEXITED(status) || WIFSIGNALED(status)) => break,
                    Err(e) if e.kind() != io::ErrorKind::Interrupted => {
                        errors.push(format!("waitpid: {e}"));
                        break;
                    }
                    _ => {}
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    errors.push("waitpid: reap timeout".into());
                    break;
                }
                sleep(remaining.min(Duration::from_millis(10)));
            }
            if errors.is_empty() { Ok(status) } else { Err(errors.join("; ")) }
        }
    }
    impl Drop for PtyChildGuard {
        fn drop(&mut self) { let _ = self.cleanup(); }
    }

    pub fn run_pty_probe(spec: &PtyProbeSpec) -> Result<PtyProbeResult, String> {
        let mut old: sigaction = unsafe { std::mem::zeroed() };
        cvt(unsafe { sigaction(SIGCHLD, null(), &mut old) }).map_err(|e| e.to_string())?;
        if old.sa_sigaction == SIG_IGN || old.sa_flags & SA_NOCLDWAIT != 0 {
            return Err("SIGCHLD auto-reaping is enabled".into());
        }
        let (mut m, mut s) = (-1, -1);
        let mut size = winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
        cvt(unsafe { openpty(&mut m, &mut s, null_mut(), null_mut(), &raw mut size) })
            .map_err(|e| format!("openpty: {e}"))?;
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        for fd in [m, s] {
            cvt(unsafe { fcntl(fd, F_SETFD, FD_CLOEXEC) }).map_err(|e| format!("FD_CLOEXEC: {e}"))?;
        }
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        if spec.strip_anthropic_env {
            for (key, _) in std::env::vars_os() {
                if key.as_encoded_bytes().starts_with(b"ANTHROPIC_") { command.env_remove(key); }
            }
        }
        #[cfg(target_os = "linux")]
        let parent_pid = unsafe { getpid() };
        unsafe {
            command.pre_exec(move || {
                cvt(setsid())?;
                cvt(ioctl(s, TIOCSCTTY as _, 0))?;
                for fd in 0..=2 {
                    cvt(dup2(s, fd))?;
                    cvt(fcntl(fd, F_SETFD, 0))?;
                }
                if s > 2 { cvt(close(s))?; }
                #[cfg(target_os = "linux")]
                {
                    cvt(prctl(PR_SET_PDEATHSIG, SIGKILL as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong))?;
                    if getppid() != parent_pid { _exit(127); }
                }
                Ok(())
            });
        }
        let start = Instant::now();
        let child = command.spawn().map_err(|e| format!("spawn: {e}"))?;
        let pid = child.id() as pid_t;
        let mut guard = PtyChildGuard { owned_pid: Some(pid), master: Some(master) };
        drop(slave);
        let capture = collect(&mut guard, pid, m, start, spec);
        let status = guard.cleanup()?;
        let mut result = capture?;
        result.exit_code = WIFEXITED(status).then(|| WEXITSTATUS(status));
        result.signal = WIFSIGNALED(status).then(|| WTERMSIG(status));
        Ok(result)
    }

    fn collect(
        guard: &mut PtyChildGuard, pid: pid_t, master: c_int, start: Instant, spec: &PtyProbeSpec,
    ) -> Result<PtyProbeResult, String> {
        cvt(unsafe { fcntl(master, F_SETFL, O_NONBLOCK) }).map_err(|e| format!("O_NONBLOCK: {e}"))?;
        let mut inputs: Vec<_> = spec.inputs.iter().filter(|i| !i.bytes.is_empty()).collect();
        inputs.sort_by_key(|i| i.delay_ms);
        let mut inputs = inputs.into_iter().peekable();
        let (mut offset, mut eof, mut can_write) = (0, false, true);
        let mut drain_until = None;
        let mut captured = Vec::new();
        let mut buf = [0; MAX_READ_PER_TICK];
        let mut truncated = false;
        let timeout = Duration::from_millis(spec.timeout_ms);
        let timed_out = loop {
            if drain_until.is_none() && guard.exited(pid)? {
                drain_until = Some(Instant::now() + Duration::from_millis(EXIT_DRAIN_MS));
            }
            let now = Instant::now();
            if drain_until.is_some_and(|end| eof || now >= end) || is_cancelled() { break false; }
            let remaining = timeout.saturating_sub(now - start);
            if remaining.is_zero() { break true; }
            let mut wait = remaining.min(Duration::from_millis(50));
            let mut events = POLLIN;
            if let Some(end) = drain_until {
                wait = wait.min(end - now);
            } else if let Some(input) = inputs.peek().filter(|_| !eof && can_write) {
                let until = Duration::from_millis(input.delay_ms).saturating_sub(now - start);
                if until.is_zero() { events |= POLLOUT; } else { wait = wait.min(until); }
            }
            let mut pollfd = pollfd { fd: if eof { -1 } else { master }, events, revents: 0 };
            match cvt(unsafe { poll(&mut pollfd, 1, wait.as_millis().max(1) as c_int) }) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("poll: {e}")),
                Ok(_) => {}
            }
            let flags = pollfd.revents;
            if flags & POLLNVAL != 0 { return Err("poll: invalid PTY descriptor".into()); }
            if flags & (POLLIN | POLLHUP | POLLERR) != 0 {
                let mut budget = MAX_READ_PER_TICK;
                while budget > 0 {
                    let n = unsafe { read(master, buf.as_mut_ptr().cast(), budget) };
                    if n > 0 {
                        let n = n as usize;
                        let keep = n.min(MAX_CAPTURE_BYTES - captured.len());
                        captured.extend_from_slice(&buf[..keep]);
                        truncated |= n > keep;
                        budget -= n;
                        continue;
                    }
                    let code = io::Error::last_os_error();
                    eof = n == 0 || code.raw_os_error() == Some(EIO)
                        || (flags & (POLLHUP | POLLIN) == POLLHUP && code.kind() == io::ErrorKind::WouldBlock);
                    if !eof && !matches!(code.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                        return Err(format!("PTY read: {code}"));
                    }
                    break;
                }
            }
            if !eof && events & flags & POLLOUT != 0 {
                let bytes = &inputs.peek().expect("POLLOUT requires an input").bytes[offset..];
                let n = unsafe { write(master, bytes.as_ptr().cast(), bytes.len()) };
                if n >= 0 {
                    offset += n as usize;
                    if n as usize == bytes.len() { inputs.next(); offset = 0; }
                } else {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() == Some(EIO) { can_write = false; }
                    else if !matches!(e.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                        return Err(format!("PTY write: {e}"));
                    }
                }
            }
        };
        Ok(PtyProbeResult {
            schema_version: SCHEMA_VERSION,
            output: String::from_utf8_lossy(&captured).into_owned(),
            exit_code: None,
            signal: None,
            timed_out,
            truncated,
        })
    }
}
#[cfg(unix)]
pub use unix::{install_cancel_signal_handlers, reset_sigchld_default, run_pty_probe};

//! Unix process supervision. This is not a sandbox.
#![cfg(unix)]
use libc::*;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::{self, Read}, os::{fd::AsRawFd, unix::process::CommandExt},
    path::PathBuf, process::{Command, Stdio}, sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock,
    atomic::{AtomicBool, Ordering::{Acquire, Release}}}, thread::{self, JoinHandle}, time::{Duration, Instant}};
/// Clears inherited environment variables; does not confine filesystem access.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IsolatedEnvSpec { pub vars: BTreeMap<String, String> }
#[derive(Debug, Serialize, Deserialize)]
pub struct SupervisedSpawnSpec {
    pub command: String,
    #[serde(default)] pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)] pub env: IsolatedEnvSpec,
    pub timeout_ms: u64,
    #[serde(default)] pub grace_ms: u64,
    /// Defaults to 250 ms after process cleanup.
    pub drain_deadline_ms: Option<u64>,
    /// Defaults to 1000 ms after escalation.
    pub reap_timeout_ms: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SupervisedOutcome {
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
#[derive(Debug)]
pub struct SupervisionError {
    pub errors: Vec<String>,
    /// Reaped status and captured output, if available despite cleanup errors.
    pub outcome: Option<SupervisedOutcome>,
    /// The caller must keep exclusive wait ownership and reap this child; do not signal it.
    pub unreaped_pid: Option<i32>,
}
impl std::fmt::Display for SupervisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.errors.join("; "))?;
        if let Some(pid) = self.unreaped_pid { write!(f, "; reap handoff: {pid}")?; }
        Ok(())
    }
}
impl std::error::Error for SupervisionError {}
impl From<io::Error> for SupervisionError {
    fn from(e: io::Error) -> Self { Self { errors: vec![e.to_string()], unreaped_pid: None, outcome: None } } }
/// Consecutive crashes trip at `trip_after`; each subsequent delay doubles up to the cap.
#[derive(Debug, Clone)]
pub struct CrashLoopTracker { trip_after: u32, crashes: u32, initial_ms: u64, max_ms: u64, next_ms: u64 }
impl CrashLoopTracker {
    pub fn new(trip_after: u32, initial_ms: u64, max_ms: u64) -> Self {
        let initial_ms = initial_ms.min(max_ms);
        Self { trip_after: trip_after.max(1), crashes: 0, initial_ms, max_ms, next_ms: initial_ms }
    }
    pub fn record_crash(&mut self) -> Option<u64> {
        self.crashes = self.crashes.saturating_add(1);
        if self.crashes < self.trip_after { return None; }
        let delay = self.next_ms;
        self.next_ms = delay.saturating_mul(2).min(self.max_ms);
        Some(delay)
    }
    pub fn reset(&mut self) { self.crashes = 0; self.next_ms = self.initial_ms; }
}
const SLICE: Duration = Duration::from_millis(25);
const CAP: usize = 256 * 1024;
static UNREAPED: Mutex<Vec<i32>> = Mutex::new(Vec::new());
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }
/// Drain unwind handoffs once. Only one designated process-wide recipient may call this;
/// it takes over exclusive waits until each child is reaped (no further signaling).
pub fn take_unreaped_pids() -> Vec<i32> { std::mem::take(&mut *lock(&UNREAPED)) }
#[derive(Default)]
struct Readers {
    cancel_now: AtomicBool,
    failed: (Mutex<bool>, Condvar),
    drain: OnceLock<(Instant, Duration)>,
}
impl Readers {
    fn pause(&self, duration: Duration) -> bool {
        let (failed, cv) = &self.failed;
        let failed = lock(failed);
        if *failed { return true; }
        *cv.wait_timeout(failed, duration).unwrap_or_else(|p| p.into_inner()).0
    }
}
struct ReaderAlarm<'a>(&'a Readers, bool);
impl Drop for ReaderAlarm<'_> {
    fn drop(&mut self) {
        if self.1 {
            self.0.cancel_now.store(true, Release);
            *lock(&self.0.failed.0) = true;
            self.0.failed.1.notify_all();
        }
    }
}
type Reader = JoinHandle<io::Result<Vec<u8>>>;
fn start_reader(pipe: impl Read + AsRawFd + Send + 'static, shared: Arc<Readers>) -> io::Result<Reader> {
    thread::Builder::new().spawn(move || {
        let mut alarm = ReaderAlarm(&shared, true);
        let result = drain_pipe(pipe, &shared);
        alarm.1 = result.is_err();
        result
    })
}
fn drain_pipe(mut pipe: impl Read + AsRawFd, shared: &Readers) -> io::Result<Vec<u8>> {
    let fd = pipe.as_raw_fd();
    let flags = sys(unsafe { fcntl(fd, F_GETFL) })?;
    sys(unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) })?;
    let (mut out, mut buf) = (Vec::new(), [0; 8192]);
    let mut poll_fd = pollfd { fd, events: POLLIN, revents: 0 };
    let budget = || shared.drain.get().map_or(SLICE, |(t, d)| SLICE.min(d.saturating_sub(t.elapsed())));
    while !shared.cancel_now.load(Acquire) && !budget().is_zero() {
        match sys(unsafe { poll(&mut poll_fd, 1, budget().as_millis() as i32) }) {
            Ok(0) => continue,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            result => { result?; }
        }
        if shared.cancel_now.load(Acquire) || budget().is_zero() { break; }
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n.min(CAP - out.len())]),
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => (),
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}
fn sys(ret: i32) -> io::Result<i32> { if ret == -1 { Err(io::Error::last_os_error()) } else { Ok(ret) } }
fn send(pid: i32, sig: i32, group: bool) -> io::Result<i32> { sys(unsafe { if group { killpg(pid, sig) } else { kill(pid, sig) } }) }
fn reap(pid: i32, status: &mut i32) -> io::Result<i32> { sys(unsafe { waitpid(pid, status, WNOHANG) }) }
fn terminal(pid: i32, code: i32) -> bool { pid != 0 && matches!(code, CLD_EXITED | CLD_KILLED | CLD_DUMPED) }
fn peek_exit(pid: i32) -> io::Result<bool> {
    let mut info: siginfo_t = unsafe { std::mem::zeroed() };
    sys(unsafe { waitid(P_PID, pid as id_t, &mut info, WEXITED | WNOHANG | WNOWAIT) })?;
    Ok(terminal(unsafe { info.si_pid() }, info.si_code))
}
struct SupervisedChildGuard {
    owned_pid: Option<i32>,
    pending_handoff_pid: Option<i32>,
    leader_exited: bool,
    readers: [Option<Reader>; 2],
    shared: Arc<Readers>,
    grace: Duration,
    drain: Duration,
    reap_timeout: Duration,
    send: fn(i32, i32, bool) -> io::Result<i32>,
    reap: fn(i32, &mut i32) -> io::Result<i32>,
    peek_exit: fn(i32) -> io::Result<bool>,
}
impl SupervisedChildGuard {
    fn observe_exit(&mut self, pid: i32) -> io::Result<bool> {
        let exited = (self.peek_exit)(pid).inspect_err(|e| { if e.raw_os_error() == Some(ECHILD) { self.owned_pid = None; } })?;
        self.leader_exited |= exited;
        Ok(self.leader_exited)
    }
    fn terminate(&mut self, errors: &mut Vec<String>) -> Option<i32> {
        let pid = self.owned_pid?;
        // The unreaped leader pins the PID used for both group and direct signals.
        for (sig, group) in [(SIGTERM, true), (SIGKILL, true), (SIGKILL, false)] {
            if let Err(e) = (self.send)(pid, sig, group) {
                let errno = e.raw_os_error();
                let benign_eperm = cfg!(target_os = "macos") && group && self.leader_exited && errno == Some(EPERM);
                if errno != Some(ESRCH) && !benign_eperm { errors.push(format!("signal {sig} (group={group}): {e}")); }
            }
            if sig == SIGTERM {
                thread::sleep(self.grace);
                // The leader may have exited during grace; check before group SIGKILL.
                if let Err(e) = self.observe_exit(pid) {
                    errors.push(format!("waitid: {e}"));
                    self.owned_pid?;
                }
            }
        }
        let (start, mut status) = (Instant::now(), 0);
        loop {
            match (self.reap)(pid, &mut status) {
                Ok(n) if n == pid && (WIFEXITED(status) || WIFSIGNALED(status)) => {
                    self.owned_pid = None;
                    return Some(status);
                }
                Err(e) if e.kind() != io::ErrorKind::Interrupted => {
                    errors.push(format!("waitpid: {e}"));
                    if e.raw_os_error() == Some(ECHILD) { self.owned_pid = None; return None; }
                    break;
                }
                _ => (),
            }
            let left = self.reap_timeout.saturating_sub(start.elapsed());
            if left.is_zero() { errors.push("waitpid deadline expired".into()); break; }
            thread::sleep(SLICE.min(left));
        }
        self.pending_handoff_pid = self.owned_pid.take();
        None
    }
    fn cleanup(&mut self, primary: io::Result<bool>, before_join: impl Fn(usize)) -> Result<SupervisedOutcome, SupervisionError> {
        let mut errors: Vec<_> = primary.as_ref().err().map(ToString::to_string).into_iter().collect();
        if primary.is_err() { self.shared.cancel_now.store(true, Release); }
        let status = self.terminate(&mut errors);
        let _ = self.shared.drain.set((Instant::now(), self.drain));
        let [mut stdout, mut stderr] = [Vec::new(), Vec::new()];
        for (i, out) in [&mut stdout, &mut stderr].into_iter().enumerate() {
            before_join(i);
            match self.readers[i].take().map(JoinHandle::join) {
                Some(Ok(Ok(bytes))) => *out = bytes,
                Some(Ok(Err(e))) => errors.push(format!("reader {i}: {e}")),
                Some(Err(p)) => {
                    let message = p.downcast_ref::<String>().map(String::as_str)
                        .or_else(|| p.downcast_ref::<&str>().copied()).unwrap_or("non-string payload").to_owned();
                    std::mem::forget(p);
                    errors.push(format!("reader {i} panicked: {message}"));
                }
                None => (),
            }
        }
        let outcome = primary.ok().zip(status).map(|(timed_out, status)| SupervisedOutcome {
            timed_out, stdout, stderr,
            exit_code: WIFEXITED(status).then(|| WEXITSTATUS(status)),
            signal: WIFSIGNALED(status).then(|| WTERMSIG(status)),
        });
        if errors.is_empty() { Ok(outcome.expect("successful cleanup reaped the child")) }
        else { Err(SupervisionError { errors, unreaped_pid: self.pending_handoff_pid.take(), outcome }) }
    }
}
impl Drop for SupervisedChildGuard {
    fn drop(&mut self) {
        self.terminate(&mut Vec::new());
        if let Some(pid) = self.pending_handoff_pid.take() { lock(&UNREAPED).push(pid); }
        self.shared.cancel_now.store(true, Release);
        for h in self.readers.iter_mut().filter_map(Option::take) {
            if let Err(p) = h.join() { std::mem::forget(p); }
        }
    }
}
/// The caller must exclusively reap the leader: keep SIGCHLD out of SIG_IGN/SA_NOCLDWAIT
/// and issue no competing waits from before spawn through any handoff until reaped.
/// Calling-process exit is an exception: no reaping is guaranteed then.
/// `timeout_ms` starts after `Command::spawn()` returns. Group signaling is best-effort,
/// not universal descendant termination: descendants can leave the process group.
/// On macOS, group EPERM is tolerated only after observing the leader exit without reaping it.
pub fn run_supervised(spec: &SupervisedSpawnSpec) -> Result<SupervisedOutcome, SupervisionError> {
    let mut cmd = Command::new(&spec.command);
    cmd.args(&spec.args).env_clear().envs(&spec.env.vars).stdin(Stdio::null());
    if let Some(cwd) = &spec.cwd { cmd.current_dir(cwd); }
    supervise(cmd, spec, |_| {})
}
fn supervise(mut cmd: Command, spec: &SupervisedSpawnSpec, after_exit: impl FnOnce(&mut SupervisedChildGuard)) -> Result<SupervisedOutcome, SupervisionError> {
    let mut action: sigaction = unsafe { std::mem::zeroed() };
    sys(unsafe { sigaction(SIGCHLD, std::ptr::null(), &mut action) })?;
    if action.sa_sigaction == SIG_IGN || action.sa_flags & SA_NOCLDWAIT != 0 {
        return Err(io::Error::other("SIGCHLD auto-reaping violates exclusive ownership").into());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Only the async-signal-safe setpgid syscall and errno retrieval run before exec.
    unsafe { cmd.pre_exec(|| sys(setpgid(0, 0)).map(|_| ())); }
    let mut child = cmd.spawn()?;
    let (start, pid) = (Instant::now(), child.id() as i32);
    let mut guard = SupervisedChildGuard { owned_pid: Some(pid), pending_handoff_pid: None,
        leader_exited: false, readers: [None, None], shared: Arc::default(), grace: Duration::from_millis(spec.grace_ms),
        drain: Duration::from_millis(spec.drain_deadline_ms.unwrap_or(250)), send, reap, peek_exit,
        reap_timeout: Duration::from_millis(spec.reap_timeout_ms.unwrap_or(1000)) };
    let primary = (|| {
        guard.readers[0] = Some(start_reader(child.stdout.take().unwrap(), guard.shared.clone())?);
        guard.readers[1] = Some(start_reader(child.stderr.take().unwrap(), guard.shared.clone())?);
        let timeout = Duration::from_millis(spec.timeout_ms);
        loop {
            match guard.observe_exit(pid) {
                Ok(true) => { after_exit(&mut guard); return Ok(false); }
                Err(e) if e.kind() != io::ErrorKind::Interrupted => return Err(e),
                _ => (),
            }
            let left = timeout.saturating_sub(start.elapsed());
            if guard.shared.pause(SLICE.min(left)) { return Err(io::Error::other("output reader failed")); }
            if left.is_zero() { return Ok(true); }
        }
    })();
    guard.cleanup(primary, |_| {})
}
#[cfg(test)] mod tests;

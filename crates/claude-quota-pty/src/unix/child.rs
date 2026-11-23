use super::{cvt, REAP_TIMEOUT_MS, TERM_GRACE_MS};
use libc::*;
use std::io;
use std::os::fd::OwnedFd;
use std::thread::sleep;
use std::time::{Duration, Instant};

pub(super) struct PtyChildGuard {
    pub(super) owned_pid: Option<pid_t>,
    pub(super) master: Option<OwnedFd>,
    pub(super) leader_exited: bool,
}

impl PtyChildGuard {
    pub(super) fn exited(&mut self, pid: pid_t) -> Result<bool, String> {
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

    pub(super) fn cleanup(&mut self) -> Result<c_int, String> {
        let Some(pid) = self.owned_pid else {
            self.master.take();
            return Ok(0);
        };
        // The unreaped leader reserves its PID/PGID throughout escalation.
        let mut errors = Vec::new();
        record_signal(&mut errors, "killpg SIGTERM", unsafe { killpg(pid, SIGTERM) }, self.leader_exited);
        sleep(Duration::from_millis(TERM_GRACE_MS));
        if !self.leader_exited {
            match self.exited(pid) {
                Ok(exited) => self.leader_exited = exited,
                Err(e) => errors.push(e),
            }
        }
        if self.owned_pid.take().is_none() {
            // ECHILD means the PID is no longer reserved; don't signal it again.
            self.master.take();
            return Err(errors.join("; "));
        }
        record_signal(&mut errors, "killpg SIGKILL", unsafe { killpg(pid, SIGKILL) }, self.leader_exited);
        record_signal(&mut errors, "kill SIGKILL", unsafe { kill(pid, SIGKILL) }, false);
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

fn record_signal(errors: &mut Vec<String>, name: &str, ret: c_int, _group_leader_exited: bool) {
    match cvt(ret) {
        Ok(_) => (),
        Err(e) if e.raw_os_error() == Some(ESRCH) => (),
        #[cfg(target_os = "macos")]
        Err(e) if _group_leader_exited && e.raw_os_error() == Some(EPERM) => (),
        Err(e) => errors.push(format!("{name}: {e}")),
    }
}

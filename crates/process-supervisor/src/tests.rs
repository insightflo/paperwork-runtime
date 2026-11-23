use super::*;
use std::{io::Write, net::Shutdown, os::{fd::OwnedFd, unix::net::UnixStream},
    panic::{catch_unwind, panic_any}, sync::{Barrier, atomic::{AtomicUsize, Ordering::Relaxed}}};

fn spec(script: &str) -> SupervisedSpawnSpec {
    SupervisedSpawnSpec { command: "/bin/sh".into(), args: vec!["-c".into(), script.into()], cwd: None,
        env: IsolatedEnvSpec::default(), timeout_ms: 4000, grace_ms: 0,
        drain_deadline_ms: None, reap_timeout_ms: None }
}

// macOS reports EPERM when no live group member remains; preserve and verify it.
fn observed(result: Result<SupervisedOutcome, SupervisionError>) -> SupervisedOutcome {
    match result {
        #[cfg(target_os = "macos")]
        Err(e) if !e.errors.is_empty() && e.errors.iter().all(|error| {
            error.ends_with(&format!("(group=true): {}", io::Error::from_raw_os_error(EPERM)))
        }) => {
            assert_eq!(e.unreaped_pid, None);
            e.outcome.expect("cleanup must still reap and capture output")
        }
        other => other.unwrap(),
    }
}

#[test]
fn captures_fast_exit_and_discards_after_cap() {
    for len in [128 * 1024, 512 * 1024] {
        let out = observed(run_supervised(&spec(&format!("/usr/bin/head -c {len} /dev/zero; rc=$?; printf done >&2; exit $rc"))));
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert_eq!(out.stdout, vec![0; len.min(CAP)]);
        assert_eq!(out.stderr, b"done");
    }
}

fn fixture(mode: &str) -> Command {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", "tests::fixture_child", "--nocapture"]).env("SUPERVISOR_FIXTURE", mode);
    cmd
}

// Shutting down the write half sends EOF even if the observation socket is cloned.
struct Sentinel(UnixStream);
impl Drop for Sentinel {
    fn drop(&mut self) { let _ = self.0.shutdown(Shutdown::Write); }
}
fn fixture_pipe(mode: &str) -> (Command, Sentinel, UnixStream) {
    let (parent, child) = UnixStream::pair().unwrap();
    parent.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut cmd = fixture(mode);
    cmd.stdin(Stdio::from(OwnedFd::from(child)));
    (cmd, Sentinel(parent.try_clone().unwrap()), parent)
}
fn mark(byte: u8) { assert_eq!(unsafe { write(STDIN_FILENO, (&byte as *const u8).cast(), 1) }, 1); }
extern "C" fn on_term(_: i32) {
    unsafe { write(STDIN_FILENO, b"T".as_ptr().cast(), 1); _exit(0); }
}
fn wait_for_sentinel() { assert_eq!(io::stdin().read(&mut [0]).unwrap(), 0); }

#[test]
#[allow(clippy::zombie_processes)] // The fixture deliberately orphans grandchildren.
fn fixture_child() {
    let Ok(mode) = std::env::var("SUPERVISOR_FIXTURE") else { return; };
    match mode.as_str() {
        "group-exit" | "group-timeout" | "escape-exit" => {
            let mode_child = if mode == "escape-exit" { "escaped" } else { "group" };
            let mut child = fixture(mode_child).stderr(Stdio::piped()).spawn().unwrap();
            let mut ready = [0];
            child.stderr.take().unwrap().read_exact(&mut ready).unwrap();
            assert_eq!(ready, *b"R");
            // Intentionally leave the grandchild running when the leader exits.
            if mode == "group-timeout" { wait_for_sentinel(); let _ = child.wait(); }
        }
        "group" => {
            let mut action: sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = on_term as *const () as sighandler_t;
            sys(unsafe { sigaction(SIGTERM, &action, std::ptr::null_mut()) }).unwrap();
            mark(b'G');
            io::stderr().write_all(b"R").unwrap();
            wait_for_sentinel();
        }
        "escaped" => {
            sys(unsafe { setsid() }).unwrap();
            mark(b'S');
            thread::spawn(|| { wait_for_sentinel(); mark(b'E'); std::process::exit(0); });
            io::stdout().write_all(&[b'W'; 8192]).unwrap();
            io::stderr().write_all(b"R").unwrap();
            // Keep trying after the read end closes; only sentinel EOF shuts us down.
            loop {
                if io::stdout().write_all(&[b'W'; 8192]).is_err() { thread::sleep(SLICE); }
            }
        }
        "moved" => {
            let pgid = unsafe { getpgid(getppid()) };
            assert!(pgid > 0);
            sys(unsafe { setpgid(0, pgid) }).unwrap();
            assert_ne!(unsafe { getpgrp() }, unsafe { getpid() });
            mark(b'M');
            wait_for_sentinel();
        }
        _ => panic!("unknown fixture"),
    }
}

#[test]
fn normal_exit_and_timeout_signal_same_group_grandchild() {
    for (mode, timed_out) in [("group-exit", false), ("group-timeout", true)] {
        let (cmd, _sentinel, mut observe) = fixture_pipe(mode);
        let mut cfg = spec("");
        cfg.timeout_ms = 750;
        cfg.grace_ms = 100;
        let out = observed(supervise(cmd, &cfg, |_| {}));
        assert_eq!(out.timed_out, timed_out);
        if timed_out { assert_eq!(out.signal, Some(SIGTERM)); } else { assert_eq!(out.exit_code, Some(0)); }
        let mut marks = Vec::new();
        observe.read_to_end(&mut marks).unwrap();
        assert_eq!(marks, b"GT");
    }
}

#[test]
fn moved_leader_requires_direct_sigkill() {
    let (cmd, _sentinel, mut observe) = fixture_pipe("moved");
    let mut cfg = spec("");
    cfg.timeout_ms = 500;
    let out = supervise(cmd, &cfg, |_| {}).unwrap();
    assert!(out.timed_out);
    assert_eq!(out.signal, Some(SIGKILL));
    let mut marks = Vec::new();
    observe.read_to_end(&mut marks).unwrap();
    assert_eq!(marks, b"M");
}

#[test]
fn escaped_writer_drain_is_bounded_and_sentinel_stops_it() {
    let (cmd, sentinel, mut observe) = fixture_pipe("escape-exit");
    let mut cfg = spec("");
    cfg.drain_deadline_ms = Some(75);
    let start = Instant::now();
    let out = observed(supervise(cmd, &cfg, |_| {}));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(out.exit_code, Some(0));
    assert!(out.stdout.contains(&b'W'));
    drop(sentinel);
    let mut marks = Vec::new();
    observe.read_to_end(&mut marks).unwrap();
    assert_eq!(marks, b"SE");
}

#[test]
fn stopped_leader_waits_for_timeout() {
    assert!(!terminal(42, CLD_STOPPED));
    assert!(!terminal(42, CLD_TRAPPED));
    assert!(!terminal(0, CLD_EXITED));
    let mut cfg = spec("printf stopping; kill -STOP $$; exit 42");
    cfg.timeout_ms = 200;
    let start = Instant::now();
    let out = observed(run_supervised(&cfg));
    assert!(out.timed_out);
    assert_eq!(out.stdout, b"stopping");
    assert!(start.elapsed() >= Duration::from_millis(200));
    assert!(matches!(out.signal, Some(SIGKILL | SIGTERM)));
}

static HANDOFF_TEST_LOCK: Mutex<()> = Mutex::new(());
static SIGNALS: AtomicUsize = AtomicUsize::new(0);
fn fake_guard(pid: i32, reaps: bool) -> SupervisedChildGuard {
    SupervisedChildGuard { owned_pid: Some(pid), pending_handoff_pid: None, readers: [None, None],
        shared: Arc::default(), grace: Duration::ZERO, drain: Duration::ZERO, reap_timeout: Duration::ZERO,
        send: |_, _, _| { SIGNALS.fetch_add(1, Relaxed); Ok(0) },
        reap: if reaps { |pid, _| Ok(pid) } else { |_, _| Ok(0) } }
}
fn unwind(action: impl FnOnce() + std::panic::UnwindSafe) {
    assert!(catch_unwind(action).is_err());
}

#[test]
fn unwind_before_reap_hands_off_once_including_concurrent_unwinds() {
    let _serial = lock(&HANDOFF_TEST_LOCK);
    SIGNALS.store(0, Relaxed);
    unwind(|| { let _guard = fake_guard(101, false); panic!("before reap"); });
    assert_eq!(take_unreaped_pids(), [101]);
    assert!(take_unreaped_pids().is_empty());
    let barrier = Barrier::new(2);
    thread::scope(|scope| {
        for pid in [102, 103] {
            let barrier = &barrier;
            scope.spawn(move || unwind(|| { let _guard = fake_guard(pid, false); barrier.wait(); panic!("concurrent"); }));
        }
    });
    let mut pids = take_unreaped_pids();
    pids.sort_unstable();
    assert_eq!(pids, [102, 103]);
    assert!(take_unreaped_pids().is_empty());
    assert_eq!(SIGNALS.load(Relaxed), 9);
}

#[test]
fn joining_unwind_publishes_only_pending_pid_and_never_resignals() {
    let _serial = lock(&HANDOFF_TEST_LOCK);
    for reaps in [true, false] {
        SIGNALS.store(0, Relaxed);
        unwind(|| {
            let mut guard = fake_guard(201, reaps);
            guard.readers[0] = Some(thread::spawn(|| Ok(Vec::new())));
            let _ = guard.cleanup(Ok(false), |i| { if i == 1 { panic!("between reader joins"); } });
        });
        assert_eq!(SIGNALS.load(Relaxed), 3);
        assert_eq!(take_unreaped_pids(), if reaps { vec![] } else { vec![201] });
        assert!(take_unreaped_pids().is_empty());
    }
}

#[test]
fn drop_forgets_panicking_payload_and_joins_second_reader() {
    struct Bomb;
    impl Drop for Bomb { fn drop(&mut self) { panic!("payload destructor"); } }
    let _serial = lock(&HANDOFF_TEST_LOCK);
    let second_joined = Arc::new(AtomicBool::new(false));
    unwind(|| {
        let mut guard = fake_guard(301, false);
        guard.readers[0] = Some(thread::spawn(|| panic_any(Bomb)));
        let (second, shared) = (second_joined.clone(), guard.shared.clone());
        guard.readers[1] = Some(thread::spawn(move || {
            while !shared.cancel_now.load(Acquire) { thread::yield_now(); }
            assert!(lock(&UNREAPED).contains(&301));
            second.store(true, Relaxed);
            Ok(Vec::new())
        }));
        panic!("outer unwind");
    });
    assert!(second_joined.load(Relaxed));
    assert_eq!(take_unreaped_pids(), [301]);
    assert!(take_unreaped_pids().is_empty());
}

#[test]
fn reader_failure_at_normal_exit_and_pre_wait_notification_are_not_lost() {
    let err = supervise(Command::new("/usr/bin/true"), &spec(""), |guard| {
        guard.readers[0].take().unwrap().join().unwrap().unwrap();
        guard.readers[0] = Some(start_reader(std::fs::File::open("/").unwrap(), guard.shared.clone()).unwrap());
        let (failed, cv) = &guard.shared.failed;
        let (failed, _) = cv.wait_timeout_while(lock(failed), Duration::from_secs(2), |f| !*f).unwrap();
        assert!(*failed);
        drop(failed);
        // Failure has already notified before pause takes the lock: it must not sleep.
        let start = Instant::now();
        assert!(guard.shared.pause(Duration::from_secs(3)));
        assert!(start.elapsed() < Duration::from_secs(1));
        guard.send = |pid, sig, group| {
            let result = send(pid, sig, group);
            if sig == SIGTERM { Err(io::Error::from_raw_os_error(EPERM)) } else { result }
        };
    }).unwrap_err();
    assert!(err.errors.iter().any(|e| e.starts_with("reader 0:")), "{err}");
    assert!(err.errors.iter().any(|e| e.contains(&io::Error::from_raw_os_error(EPERM).to_string())), "{err}");
    assert_eq!(err.unreaped_pid, None);
}

#[test]
fn bounded_reap_hands_off_in_error_without_publishing_again() {
    let _serial = lock(&HANDOFF_TEST_LOCK);
    let mut guard = fake_guard(401, false);
    let err = guard.cleanup(Err(io::Error::other("primary")), |_| {}).unwrap_err();
    assert_eq!(err.errors, ["primary", "waitpid deadline expired"]);
    assert_eq!(err.unreaped_pid, Some(401));
    drop(guard);
    assert!(take_unreaped_pids().is_empty());
}

#[test]
fn crash_loop_trips_saturates_and_resets_deterministically() {
    let mut tracker = CrashLoopTracker::new(2, 10, 25);
    for _ in 0..2 {
        assert_eq!((0..5).map(|_| tracker.record_crash()).collect::<Vec<_>>(),
            [None, Some(10), Some(20), Some(25), Some(25)]);
        tracker.reset();
    }
}

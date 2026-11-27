//! TDD tests for the transport-agnostic endpoint daemon tick orchestrator.
//! Included by path so this suite exercises the exact `src/endpoint_daemon.rs`
//! source without any `lib.rs` registration.
#[path = "../src/endpoint_daemon.rs"]
mod endpoint_daemon;

use endpoint_daemon::{DaemonConfig, DaemonTask, DaemonTaskResult, EndpointDaemon, TickReport};

fn cfg() -> DaemonConfig {
    DaemonConfig { poll_batch_size: 4, heartbeat_interval_ms: 5_000, max_outbox_entries: 8 }
}

fn task(id: &str) -> DaemonTask {
    DaemonTask { task_id: id.to_string(), kind: "read_file".into(), payload: String::new() }
}

struct MockTransport {
    heartbeat_result: Result<(), String>,
    heartbeat_calls: Vec<(usize, u64)>,
    polls: Vec<Result<Vec<DaemonTask>, String>>,
    ack_outcomes: Vec<Result<(), String>>,
    log: Vec<String>,
}

impl MockTransport {
    fn ok(polls: Vec<Result<Vec<DaemonTask>, String>>) -> Self {
        Self { heartbeat_result: Ok(()), heartbeat_calls: Vec::new(), polls, ack_outcomes: Vec::new(), log: Vec::new() }
    }

    /// Index of `entry` inside `self.log[from..]`; panics with context if absent.
    fn position_of(&self, from: usize, entry: &str) -> usize {
        self.log[from..].iter().position(|e| *e == entry)
            .unwrap_or_else(|| panic!("log entry {entry:?} not found after index {from}"))
    }
}

impl endpoint_daemon::DaemonTransport for MockTransport {
    fn send_heartbeat(&mut self, pending_outbox: usize, now_ms: u64) -> Result<(), String> {
        self.log.push("hb".into());
        self.heartbeat_calls.push((pending_outbox, now_ms));
        self.heartbeat_result.clone()
    }

    fn poll_tasks(&mut self, _max_batch: usize) -> Result<Vec<DaemonTask>, String> {
        self.log.push("poll".into());
        if self.polls.is_empty() { Ok(Vec::new()) } else { self.polls.remove(0) }
    }

    fn ack_result(&mut self, result: &DaemonTaskResult) -> Result<(), String> {
        self.log.push(format!("ack:{}", result.task_id));
        if self.ack_outcomes.is_empty() { Ok(()) } else { self.ack_outcomes.remove(0) }
    }
}

struct EchoExecutor;

impl endpoint_daemon::DaemonExecutor for EchoExecutor {
    fn execute(&mut self, t: &DaemonTask) -> DaemonTaskResult {
        DaemonTaskResult { task_id: t.task_id.clone(), ok: true, output: t.kind.clone(), error: None }
    }
}

fn run(d: &mut EndpointDaemon, now_ms: u64, t: &mut MockTransport) -> TickReport {
    d.tick(now_ms, t, &mut EchoExecutor)
}

#[test]
fn healthy_tick_heartbeats_polls_executes_and_acks() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![task("t1"), task("t2")])]);
    let r = run(&mut d, 1_000, &mut t);
    assert!(r.heartbeat_sent && r.transport_errors.is_empty());
    assert_eq!((r.flushed_count, r.executed_count, r.acked_count, r.buffered_count), (0, 2, 2, 0));
    assert_eq!(t.heartbeat_calls, vec![(0, 1_000)]);
}

#[test]
fn heartbeat_throttled_inside_interval_and_sent_at_boundary() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![]), Ok(vec![]), Ok(vec![])]);
    assert!(run(&mut d, 0, &mut t).heartbeat_sent);
    assert!(!run(&mut d, 4_999, &mut t).heartbeat_sent, "throttled inside the interval");
    assert_eq!(t.heartbeat_calls, vec![(0, 0)]);
    assert!(run(&mut d, 5_000, &mut t).heartbeat_sent);
    assert_eq!(t.heartbeat_calls, vec![(0, 0), (0, 5_000)]);
}

#[test]
fn ack_failure_buffers_result_and_reports_transport_error() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![task("t1")])]);
    t.ack_outcomes.push(Err("server_down".into()));
    let r = run(&mut d, 0, &mut t);
    assert_eq!((r.executed_count, r.acked_count, r.buffered_count, r.transport_errors.len()), (1, 0, 1, 1));
    assert!(r.transport_errors[0].contains("server_down"));
}

#[test]
fn next_healthy_tick_flushes_outbox_fifo_before_polling() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![task("t1")]), Ok(vec![task("t2")])]);
    t.ack_outcomes.push(Err("offline".into()));
    run(&mut d, 0, &mut t);
    let base = t.log.len();
    let r = run(&mut d, 10_000, &mut t);
    assert_eq!((r.flushed_count, r.acked_count, r.buffered_count), (1, 1, 0));
    let (ack_t1, poll2, ack_t2) =
        (t.position_of(base, "ack:t1"), t.position_of(base, "poll"), t.position_of(base, "ack:t2"));
    assert!(ack_t1 < poll2 && poll2 < ack_t2, "flush FIFO precedes polling and new-task acks");
    assert_eq!(t.heartbeat_calls.len(), 2, "heartbeat still fires on schedule in tick 2");
}

#[test]
fn partial_flush_failure_preserves_remaining_items_in_order() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![task("a"), task("b")]), Ok(vec![]), Ok(vec![])]);
    t.ack_outcomes.push(Err("down1".into()));
    t.ack_outcomes.push(Err("down2".into()));
    run(&mut d, 0, &mut t);
    t.ack_outcomes.push(Err("down3".into()));
    let base = t.log.len();
    let r = run(&mut d, 10_000, &mut t);
    assert_eq!(r.flushed_count, 0);
    assert_eq!(r.buffered_count, 2, "failed flush keeps every buffered result");
    let base3 = t.log.len();
    let acks_in_tick = t.log[base..base3].iter().filter(|e| e.starts_with("ack:")).count();
    assert_eq!(acks_in_tick, 1, "flush stops at the first transport error");
    let r = run(&mut d, 20_000, &mut t);
    assert_eq!((r.flushed_count, r.buffered_count), (2, 0));
    assert!(t.position_of(base3, "ack:a") < t.position_of(base3, "ack:b"), "FIFO preserved across failure");
}

#[test]
fn outbox_cap_drops_oldest_and_tracks_dropped_count() {
    let mut d =
        EndpointDaemon::new(DaemonConfig { poll_batch_size: 4, heartbeat_interval_ms: 5_000, max_outbox_entries: 2 });
    let mut t = MockTransport::ok(vec![Ok(vec![task("t1"), task("t2"), task("t3")]), Ok(vec![])]);
    for err in ["e1", "e2", "e3"] {
        t.ack_outcomes.push(Err(err.into()));
    }
    let r = run(&mut d, 0, &mut t);
    assert_eq!((r.buffered_count, d.dropped_count()), (2, 1), "oldest (t1) dropped past the cap");
    t.ack_outcomes.push(Ok(()));
    t.ack_outcomes.push(Ok(()));
    let base = t.log.len();
    let r = run(&mut d, 10_000, &mut t);
    assert_eq!((r.flushed_count, d.dropped_count()), (2, 1));
    assert!(t.position_of(base, "ack:t2") < t.position_of(base, "ack:t3"), "oldest survivor flushed first");
}

#[test]
fn empty_poll_tick_reports_zero_work_and_no_errors() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![])]);
    let r = run(&mut d, 0, &mut t);
    assert!(r.heartbeat_sent && r.transport_errors.is_empty());
    assert_eq!((r.flushed_count, r.executed_count, r.acked_count, r.buffered_count), (0, 0, 0, 0));
    assert_eq!(t.log, vec!["hb", "poll"]);
}

#[test]
fn heartbeat_failure_is_reported_and_tick_still_polls() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Ok(vec![task("t1")])]);
    t.heartbeat_result = Err("hb_unreachable".into());
    let r = run(&mut d, 0, &mut t);
    assert!(!r.heartbeat_sent);
    assert_eq!((r.executed_count, r.acked_count, r.transport_errors.len()), (1, 1, 1));
    assert!(r.transport_errors[0].contains("hb_unreachable"));
}

#[test]
fn poll_failure_is_reported_without_touching_outbox() {
    let mut d = EndpointDaemon::new(cfg());
    let mut t = MockTransport::ok(vec![Err("poll_down".into())]);
    let r = run(&mut d, 0, &mut t);
    assert_eq!((r.executed_count, r.buffered_count, r.transport_errors.len()), (0, 0, 1));
    assert!(r.transport_errors[0].contains("poll_down"));
    assert!(!t.log.iter().any(|e| e.starts_with("ack:")));
}

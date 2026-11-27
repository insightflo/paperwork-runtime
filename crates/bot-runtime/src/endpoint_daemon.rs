//! Transport-agnostic daemon tick orchestrator for the personal endpoint bot.
//!
//! [`EndpointDaemon::tick`] ties together the endpoint bot's periodic duties in one
//! caller-driven step: flushing the buffered offline outbox FIFO first, posting a
//! throttled heartbeat, then polling the server, executing tasks locally (execution
//! and audit logging live behind [`DaemonExecutor`] in the real wiring) and acking
//! results. The daemon itself never performs I/O: all server contact goes through
//! [`DaemonTransport`] and all local execution through [`DaemonExecutor`], so both
//! sides can be mocked deterministically in tests.
//!
//! Concepts align with the endpoint runtime modules: heartbeats carry the post-flush
//! `pending_outbox` size (mirroring `EndpointHeartbeat::pending_outbox_count`), results
//! mirror `EndpointTaskResult` (`task_id`/`ok`/`output`/`error`), and the bounded
//! offline outbox mirrors `OfflineResultQueue` FIFO semantics. This module is
//! self-contained on purpose: it defines its own wire-neutral types so it compiles
//! standalone (including via `#[path]` test includes) without touching `lib.rs`.

use std::collections::VecDeque;

/// One task polled from the server, opaque to the daemon: `kind`/`payload` are
/// interpreted only by the [`DaemonExecutor`] implementation (e.g. mapped onto
/// `EndpointTaskRequest` variants before local dispatch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTask {
    pub task_id: String,
    pub kind: String,
    pub payload: String,
}

/// Outcome of one locally executed task; shape mirrors `EndpointTaskResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTaskResult {
    pub task_id: String,
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
}

/// Server-facing surface of the daemon: heartbeat, task polling, result ack.
pub trait DaemonTransport {
    /// Posts presence for this endpoint. `pending_outbox` is the number of results
    /// still buffered locally after outbox flushing; `now_ms` is the caller's clock.
    fn send_heartbeat(&mut self, pending_outbox: usize, now_ms: u64) -> Result<(), String>;
    /// Fetches up to `max_batch` tasks assigned to this endpoint.
    fn poll_tasks(&mut self, max_batch: usize) -> Result<Vec<DaemonTask>, String>;
    /// Confirms one delivered result so the server never redelivers it.
    fn ack_result(&mut self, result: &DaemonTaskResult) -> Result<(), String>;
}

/// Local execution surface: runs one task on this machine (fail-closed local tools
/// plus audit logging live behind this trait in the real wiring) and returns the
/// result that should be acked — or buffered offline if the ack fails.
pub trait DaemonExecutor {
    fn execute(&mut self, task: &DaemonTask) -> DaemonTaskResult;
}

/// Tunables for one daemon instance.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Maximum tasks requested per `poll_tasks` call.
    pub poll_batch_size: usize,
    /// Minimum gap between heartbeat attempts, in milliseconds.
    pub heartbeat_interval_ms: u64,
    /// Hard cap on buffered offline results; the oldest is dropped beyond this.
    pub max_outbox_entries: usize,
}

/// Per-tick summary for status surfacing and tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickReport {
    /// Whether a heartbeat attempt succeeded this tick.
    pub heartbeat_sent: bool,
    /// Buffered results successfully acked (flushed) from the offline outbox.
    pub flushed_count: usize,
    /// Tasks executed locally this tick.
    pub executed_count: usize,
    /// Newly executed results acked on the first attempt.
    pub acked_count: usize,
    /// Results still buffered in the offline outbox at the end of the tick.
    pub buffered_count: usize,
    /// Every transport error hit this tick, in order; the tick keeps going.
    pub transport_errors: Vec<String>,
}

/// Orchestrates heartbeat, polling, execution, acking and offline buffering for one
/// personal endpoint. Owns no I/O: construct with [`EndpointDaemon::new`] and drive
/// `tick` from the caller's loop and clock.
pub struct EndpointDaemon {
    config: DaemonConfig,
    last_heartbeat_ms: Option<u64>,
    outbox: VecDeque<DaemonTaskResult>,
    dropped: usize,
}

impl EndpointDaemon {
    /// Creates a daemon with an empty offline outbox and no heartbeat history, so the
    /// first `tick` always attempts a heartbeat.
    pub fn new(config: DaemonConfig) -> Self {
        Self { config, last_heartbeat_ms: None, outbox: VecDeque::new(), dropped: 0 }
    }

    /// Number of offline results dropped oldest-first after outbox overflows.
    pub fn dropped_count(&self) -> usize {
        self.dropped
    }

    /// Runs one orchestration step at caller time `now_ms`: flush the offline outbox
    /// FIFO first (stopping at the first transport error, keeping every remaining
    /// result buffered), heartbeat when the configured interval has elapsed since the
    /// last successful one (or on the first tick), then poll, execute and ack new
    /// tasks. Results whose ack fails are buffered in the bounded offline outbox.
    /// Every transport error is recorded in the report; the tick never aborts.
    pub fn tick(
        &mut self,
        now_ms: u64,
        transport: &mut dyn DaemonTransport,
        executor: &mut dyn DaemonExecutor,
    ) -> TickReport {
        let mut report = TickReport::default();
        self.flush_outbox(transport, &mut report);
        self.send_heartbeat_if_due(now_ms, transport, &mut report);
        self.poll_execute_ack(transport, executor, &mut report);
        report.buffered_count = self.outbox.len();
        report
    }

    /// Acks buffered results oldest-first; on the first error the flush stops and the
    /// failed result stays at the head, so FIFO order and data are both preserved.
    fn flush_outbox(&mut self, transport: &mut dyn DaemonTransport, report: &mut TickReport) {
        while let Some(front) = self.outbox.front().cloned() {
            match transport.ack_result(&front) {
                Ok(()) => {
                    self.outbox.pop_front();
                    report.flushed_count += 1;
                }
                Err(e) => {
                    report.transport_errors.push(format!("outbox_flush_failed: {e}"));
                    break;
                }
            }
        }
    }

    /// Heartbeat gate: first tick always sends; afterwards only when
    /// `now_ms - last_heartbeat_ms >= heartbeat_interval_ms` (saturating, so a clock
    /// stepping backwards simply delays the next heartbeat). `last_heartbeat_ms` only
    /// advances on success, so failed heartbeats retry on the next tick.
    fn send_heartbeat_if_due(
        &mut self,
        now_ms: u64,
        transport: &mut dyn DaemonTransport,
        report: &mut TickReport,
    ) {
        let due = match self.last_heartbeat_ms {
            None => true,
            Some(last) => now_ms.saturating_sub(last) >= self.config.heartbeat_interval_ms,
        };
        if !due {
            return;
        }
        match transport.send_heartbeat(self.outbox.len(), now_ms) {
            Ok(()) => {
                self.last_heartbeat_ms = Some(now_ms);
                report.heartbeat_sent = true;
            }
            Err(e) => report.transport_errors.push(format!("heartbeat_failed: {e}")),
        }
    }

    /// Polls up to `poll_batch_size` tasks, executes each locally, and acks each
    /// result; failed acks are buffered offline (with cap + drop accounting). A poll
    /// error skips execution entirely but never touches the outbox.
    fn poll_execute_ack(
        &mut self,
        transport: &mut dyn DaemonTransport,
        executor: &mut dyn DaemonExecutor,
        report: &mut TickReport,
    ) {
        match transport.poll_tasks(self.config.poll_batch_size) {
            Ok(tasks) => {
                for task in tasks {
                    let result = executor.execute(&task);
                    report.executed_count += 1;
                    match transport.ack_result(&result) {
                        Ok(()) => report.acked_count += 1,
                        Err(e) => {
                            report.transport_errors.push(format!("ack_failed: {e}"));
                            self.buffer_result(result);
                        }
                    }
                }
            }
            Err(e) => report.transport_errors.push(format!("poll_failed: {e}")),
        }
    }

    /// Buffers one result FIFO, dropping the oldest only past `max_outbox_entries`
    /// and counting each drop, so the outbox is bounded without losing newer data.
    fn buffer_result(&mut self, result: DaemonTaskResult) {
        self.outbox.push_back(result);
        while self.outbox.len() > self.config.max_outbox_entries {
            self.outbox.pop_front();
            self.dropped += 1;
        }
    }
}

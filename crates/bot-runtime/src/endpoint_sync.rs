//! Pure endpoint sync & reconnect state machine for the personal endpoint bot.
//!
//! Purpose: keep the bot's view of its central-server connection honest without
//! doing any I/O itself. The runtime loop feeds wall-clock times, session ids,
//! errors and pending outbox ids in; this module answers "what state are we in?",
//! "when may we retry?", "what heartbeat should we post?" and "which outbox ids
//! go into the next drain batch?".
//!
//! Contract notes:
//! - Deterministic: identical inputs always produce identical outputs. No
//!   clocks, no randomness, no threads, no I/O.
//! - All arithmetic saturates: huge attempt counters, `max_ms` values and
//!   large jitter percentages never panic.
//! - [`BackoffPolicy::next_delay_ms`] treats `attempt` as the number of waiting
//!   steps after a failure (0-based): attempt 0 returns `base_ms`, attempt 1
//!   returns `2 * base_ms`, and so on, capped at `max_ms`. The deterministic
//!   jitter is keyed on `attempt`, so the same attempt always yields the same
//!   delay while consecutive attempts still vary within `±jitter_pct%`.
//! - [`SyncController`] counts consecutive failures; a successful
//!   [`SyncController::on_connected`] resets them to zero, so a healthy
//!   session always restarts the backoff ladder from `base_ms`.

use serde::{Deserialize, Serialize};

/// Exponential reconnect delay policy with deterministic attempt-keyed jitter.
#[derive(Debug, Clone, PartialEq)]
pub struct BackoffPolicy {
    /// Delay for the first retry (attempt 0), in milliseconds.
    pub base_ms: u64,
    /// Upper bound for any computed delay, in milliseconds.
    pub max_ms: u64,
    /// Deterministic jitter as a percentage (`0..=100` typical) of the capped delay.
    pub jitter_pct: u64,
}

impl BackoffPolicy {
    /// Exponential delay for `attempt` (0-based), capped at `max_ms`, then
    /// adjusted by deterministic jitter within `±jitter_pct%` of that delay.
    pub fn next_delay_ms(&self, attempt: u32) -> u64 {
        let mut delay = self.base_ms;
        let doublings = u64::from(attempt).min(64);
        for _ in 0..doublings {
            delay = delay.saturating_mul(2);
        }
        let delay = delay.min(self.max_ms);
        let span = delay.saturating_mul(self.jitter_pct) / 100;
        if span == 0 {
            return delay;
        }
        let window = span.saturating_mul(2) + 1;
        let offset = u64::from(attempt)
            .wrapping_mul(2_654_435_761)
            .wrapping_add(0x9E37_79B9_7F4A_7C15)
            % window;
        delay
            .saturating_add(span)
            .saturating_sub(offset)
            .min(self.max_ms)
    }
}

/// Connection lifecycle of the personal endpoint towards the central server.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncState {
    /// No session yet, and no dial in flight.
    Disconnected,
    /// A connect attempt is in flight.
    Connecting,
    /// Connected under `session_id` since `since_ms` (caller-supplied clock).
    Connected { session_id: String, since_ms: u64 },
    /// Waiting after `attempt` consecutive failures; dialing is allowed again
    /// once the caller's clock reaches `retry_at_ms`.
    Backoff {
        attempt: u32,
        retry_at_ms: u64,
        last_error: String,
    },
}

/// Periodic presence payload the endpoint posts to the central server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EndpointHeartbeat {
    pub bot_name: String,
    pub os: String,
    pub arch: String,
    pub detected_clis: Vec<String>,
    pub allowed_folders: Vec<String>,
    pub pending_outbox_count: u64,
    pub timestamp_ms: u64,
}

/// Drives the endpoint connection state machine and offline outbox planning.
///
/// All transitions are explicit caller-fed events; nothing here dials, spawns
/// or sleeps. `plan_outbox_drain` never mutates state so the caller stays the
/// single owner of the durable outbox queue.
pub struct SyncController {
    policy: BackoffPolicy,
    state: SyncState,
    consecutive_failures: u32,
}

impl SyncController {
    /// Start `Disconnected` with no recorded failures.
    pub fn new(policy: BackoffPolicy) -> Self {
        Self {
            policy,
            state: SyncState::Disconnected,
            consecutive_failures: 0,
        }
    }

    /// Read-only view of the current state for status surfacing.
    pub fn state(&self) -> &SyncState {
        &self.state
    }

    /// Mark a dial as in flight. No-op while already `Connected`.
    pub fn on_connect_attempt(&mut self) {
        if !matches!(self.state, SyncState::Connected { .. }) {
            self.state = SyncState::Connecting;
        }
    }

    /// Record a successful session; resets the backoff ladder to attempt 0.
    pub fn on_connected(&mut self, session_id: impl Into<String>, now_ms: u64) {
        self.state = SyncState::Connected {
            session_id: session_id.into(),
            since_ms: now_ms,
        };
        self.consecutive_failures = 0;
    }

    /// Record a dropped or failed connection; schedules the next retry at
    /// `now_ms + next_delay_ms(consecutive_failures - 1)`.
    pub fn on_disconnect(&mut self, error: impl Into<String>, now_ms: u64) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let delay = self
            .policy
            .next_delay_ms(self.consecutive_failures - 1);
        self.state = SyncState::Backoff {
            attempt: self.consecutive_failures,
            retry_at_ms: now_ms.saturating_add(delay),
            last_error: error.into(),
        };
    }

    /// Retry gate: true only while `Backoff` and the caller's clock has reached
    /// `retry_at_ms`. Every other state answers false (nothing to retry).
    pub fn should_retry(&self, now_ms: u64) -> bool {
        matches!(
            self.state,
            SyncState::Backoff { retry_at_ms, .. } if now_ms >= retry_at_ms
        )
    }

    /// Assemble the heartbeat payload from caller-supplied environment facts.
    /// The 7 flat params map 1:1 onto the wire fields, so a context struct
    /// would only add a second name for each value.
    #[allow(clippy::too_many_arguments)]
    pub fn build_heartbeat(
        &self,
        bot_name: &str,
        os: &str,
        arch: &str,
        detected_clis: &[String],
        allowed_folders: &[String],
        pending_outbox_count: u64,
        timestamp_ms: u64,
    ) -> EndpointHeartbeat {
        EndpointHeartbeat {
            bot_name: bot_name.to_string(),
            os: os.to_string(),
            arch: arch.to_string(),
            detected_clis: detected_clis.to_vec(),
            allowed_folders: allowed_folders.to_vec(),
            pending_outbox_count,
            timestamp_ms,
        }
    }

    /// Next FIFO drain batch: at most `max_batch` ids, input order preserved.
    pub fn plan_outbox_drain(&self, pending_ids: &[String], max_batch: usize) -> Vec<String> {
        pending_ids.iter().take(max_batch).cloned().collect()
    }
}

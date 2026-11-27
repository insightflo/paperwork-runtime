//! TDD tests for the pure endpoint sync & reconnect backoff state machine.
//!
//! The module is included by path so this suite exercises the exact
//! `src/endpoint_sync.rs` source without any `lib.rs` registration.
#[path = "../src/endpoint_sync.rs"]
mod endpoint_sync;

use endpoint_sync::{BackoffPolicy, SyncController, SyncState};

fn pol(base_ms: u64, max_ms: u64, jitter_pct: u64) -> BackoffPolicy {
    BackoffPolicy { base_ms, max_ms, jitter_pct }
}

fn policy() -> BackoffPolicy {
    pol(500, 4000, 0)
}

fn jitter_policy() -> BackoffPolicy {
    pol(1000, 10_000, 25)
}

fn controller() -> SyncController {
    SyncController::new(policy())
}

fn backoff(attempt: u32, retry_at_ms: u64, last_error: &str) -> SyncState {
    SyncState::Backoff { attempt, retry_at_ms, last_error: last_error.to_string() }
}

fn ids(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn backoff_doubles_then_caps_at_max() {
    let p = policy();
    let delays: Vec<u64> = (0..=5).map(|a| p.next_delay_ms(a)).collect();
    assert_eq!(delays, [500, 1000, 2000, 4000, 4000, 4000]);
}

#[test]
fn backoff_saturates_without_panicking_on_extreme_attempt() {
    let p = policy();
    assert_eq!(p.next_delay_ms(u32::MAX), 4000);
    let huge = pol(u64::MAX, u64::MAX, 100);
    let d = huge.next_delay_ms(u32::MAX);
    // With delay+span saturated, the deterministic jitter can dip at most 2*span.
    assert_eq!(d, huge.next_delay_ms(u32::MAX), "must be deterministic");
    let span = u64::MAX / 100;
    assert!(d >= u64::MAX.saturating_sub(span.saturating_mul(2)), "bounded below");
}

#[test]
fn jitter_is_deterministic_and_stays_within_policy_bounds() {
    let p = jitter_policy();
    for attempt in 0..8u32 {
        let first = p.next_delay_ms(attempt);
        assert_eq!(first, p.next_delay_ms(attempt), "must be deterministic");
        let pure = 1000u64
            .saturating_mul(1u64 << u64::from(attempt).min(63))
            .min(p.max_ms);
        let span = pure * 25 / 100;
        assert!(
            (pure.saturating_sub(span)..=pure.saturating_add(span).min(p.max_ms)).contains(&first),
            "attempt {attempt} delay {first} outside [{}, {}]",
            pure.saturating_sub(span),
            pure.saturating_add(span).min(p.max_ms)
        );
    }
}

#[test]
fn connect_attempt_then_connected_transitions_to_connected() {
    let mut c = controller();
    c.on_connect_attempt();
    assert_eq!(c.state(), &SyncState::Connecting);
    c.on_connected("sess-1", 1_500);
    assert_eq!(
        c.state(),
        &SyncState::Connected { session_id: "sess-1".to_string(), since_ms: 1_500 }
    );
}

#[test]
fn disconnect_enters_backoff_with_incrementing_attempt_and_error() {
    let mut c = controller();
    c.on_connect_attempt();
    c.on_connected("s", 1_100);
    c.on_disconnect("boom", 2_000);
    assert_eq!(c.state(), &backoff(1, 2_500, "boom"));
    c.on_disconnect("still down", 2_600);
    assert_eq!(c.state(), &backoff(2, 2_600 + 1_000, "still down"));
}

#[test]
fn should_retry_gates_strictly_on_retry_at_ms() {
    let mut c = controller();
    c.on_connect_attempt();
    c.on_connected("s", 0);
    c.on_disconnect("boom", 2_000);
    assert!(!c.should_retry(2_499), "before retry_at_ms must block");
    assert!(c.should_retry(2_500), "at retry_at_ms must allow");
    assert!(c.should_retry(9_999), "after retry_at_ms must allow");
}

#[test]
fn should_retry_is_false_outside_backoff_state() {
    let mut c = controller();
    assert!(!c.should_retry(10_000), "Disconnected must not retry");
    c.on_connect_attempt();
    assert!(!c.should_retry(10_000), "Connecting must not retry");
    c.on_connected("s", 0);
    assert!(!c.should_retry(10_000), "Connected must not retry");
}

#[test]
fn successful_connect_resets_consecutive_failure_count() {
    let mut c = controller();
    c.on_disconnect("a", 0);
    c.on_disconnect("b", 10_000);
    assert_eq!(c.state(), &backoff(2, 10_000 + 1_000, "b"));
    c.on_connected("fresh", 20_000);
    c.on_disconnect("again", 21_000);
    assert_eq!(c.state(), &backoff(1, 21_000 + 500, "again"));
}

#[test]
fn heartbeat_serializes_all_contract_fields_as_json() {
    let c = controller();
    let hb = c.build_heartbeat(
        "paper-bot",
        "macos",
        "arm64",
        &ids(&["claude", "codex"]),
        &ids(&["/srv/projects"]),
        7,
        1_234,
    );
    let v: serde_json::Value = serde_json::to_value(&hb).expect("fixture json");
    assert_eq!(v["bot_name"], "paper-bot");
    assert_eq!(v["os"], "macos");
    assert_eq!(v["arch"], "arm64");
    assert_eq!(v["detected_clis"][0], "claude");
    assert_eq!(v["detected_clis"][1], "codex");
    assert_eq!(v["allowed_folders"][0], "/srv/projects");
    assert_eq!(v["pending_outbox_count"], 7);
    assert_eq!(v["timestamp_ms"], 1_234);
}

#[test]
fn heartbeat_roundtrips_through_deserialize() {
    let c = controller();
    let hb = c.build_heartbeat("b", "linux", "x86_64", &[], &[], 0, 5);
    let text = serde_json::to_string(&hb).expect("fixture json");
    let back: endpoint_sync::EndpointHeartbeat = serde_json::from_str(&text).expect("fixture json");
    assert_eq!(back, hb);
}

#[test]
fn drain_caps_batch_size_and_preserves_fifo_order() {
    let c = controller();
    let all = ids(&["a", "b", "c", "d", "e"]);
    assert_eq!(c.plan_outbox_drain(&all, 3), ["a", "b", "c"]);
}

#[test]
fn drain_handles_empty_queue_and_undersized_batch() {
    let c = controller();
    assert!(c.plan_outbox_drain(&[], 4).is_empty());
    let one = ids(&["x"]);
    assert_eq!(c.plan_outbox_drain(&one, 5), ["x"]);
}

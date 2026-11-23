//! paperclip-quota-router: deterministic provider/model failover over observed
//! quota snapshots.
//!
//! Candidates are `[primary] + backup_order`, deduplicated on first occurrence;
//! evaluation stops at the first eligible candidate and every verdict is
//! appended to `tried`. For duplicate snapshots of one `(provider, model)` the
//! highest `observed_at_epoch_ms` wins, ties resolved toward the later slice
//! entry. Per-candidate verdict precedence is fixed: unknown_quota ->
//! future_timestamp -> stale -> invalid_remaining_pct -> hard_limited ->
//! below_threshold -> eligible. The top-level `reason` is the verdict of the
//! last tried candidate (`invalid_threshold` when `min_remaining_pct` itself
//! is out of range); `earliest_reset_epoch_ms` is the minimum future
//! `resets_at_epoch_ms` contributed by hard_limited/below_threshold rejections.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Closed verdict vocabulary shared by `tried` entries and the top-level reason.
pub const V_UNKNOWN: &str = "unknown_quota";
pub const V_FUTURE: &str = "future_timestamp";
pub const V_STALE: &str = "stale";
pub const V_INVALID_PCT: &str = "invalid_remaining_pct";
pub const V_HARD: &str = "hard_limited";
pub const V_BELOW: &str = "below_threshold";
pub const V_ELIGIBLE: &str = "eligible";
pub const V_INVALID_THRESHOLD: &str = "invalid_threshold";

/// A routable `(provider, model)` candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

/// One observed quota window for a `(provider, model)` pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaSnapshot {
    pub provider: String,
    pub model: String,
    pub observed_at_epoch_ms: i64,
    pub stale_after_ms: i64,
    pub remaining_pct: f64,
    #[serde(default)]
    pub hard_limited: bool,
    pub resets_at_epoch_ms: Option<i64>,
}

/// Failover routing input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRequest {
    pub primary: ModelRef,
    pub backup_order: Vec<ModelRef>,
    pub quotas: Vec<QuotaSnapshot>,
    pub now_epoch_ms: i64,
    pub min_remaining_pct: f64,
    #[serde(default)]
    pub allow_unknown_quota: bool,
}

/// One evaluated candidate plus the verdict that ended its evaluation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriedCandidate {
    pub provider: String,
    pub model: String,
    pub reason: &'static str,
}

/// Routing outcome: first eligible candidate plus the evaluation audit trail.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteResponse {
    pub selected: Option<ModelRef>,
    pub reason: &'static str,
    pub tried: Vec<TriedCandidate>,
    pub earliest_reset_epoch_ms: Option<i64>,
}

/// Route to the first eligible candidate; see module docs for the contract.
pub fn route(req: &RouteRequest) -> RouteResponse {
    let min = req.min_remaining_pct;
    if !min.is_finite() || !(0.0..=100.0).contains(&min) {
        return RouteResponse {
            selected: None,
            reason: V_INVALID_THRESHOLD,
            tried: Vec::new(),
            earliest_reset_epoch_ms: None,
        };
    }
    let mut latest: HashMap<(&str, &str), &QuotaSnapshot> = HashMap::with_capacity(req.quotas.len());
    for snap in &req.quotas {
        let key = (snap.provider.as_str(), snap.model.as_str());
        if latest.get(&key).is_none_or(|cur| snap.observed_at_epoch_ms >= cur.observed_at_epoch_ms) {
            latest.insert(key, snap);
        }
    }
    let mut seen = HashSet::new();
    let mut candidates = Vec::with_capacity(req.backup_order.len() + 1);
    for c in std::iter::once(&req.primary).chain(&req.backup_order) {
        if seen.insert((c.provider.as_str(), c.model.as_str())) {
            candidates.push(c);
        }
    }
    let mut tried = Vec::with_capacity(candidates.len());
    let mut earliest_reset: Option<i64> = None;
    let mut selected = None;
    for c in candidates {
        let key = (c.provider.as_str(), c.model.as_str());
        let (verdict, reset) = evaluate(latest.get(&key).copied(), req.now_epoch_ms, min, req.allow_unknown_quota);
        if let Some(r) = reset {
            earliest_reset = Some(earliest_reset.map_or(r, |e| e.min(r)));
        }
        tried.push(TriedCandidate { provider: c.provider.clone(), model: c.model.clone(), reason: verdict });
        if verdict == V_ELIGIBLE {
            selected = Some(c.clone());
            break;
        }
    }
    RouteResponse {
        selected,
        reason: tried.last().map_or(V_INVALID_THRESHOLD, |t| t.reason),
        tried,
        earliest_reset_epoch_ms: earliest_reset,
    }
}

/// Evaluate one candidate against its freshest snapshot; returns the verdict
/// and any future `resets_at_epoch_ms` it contributes toward the earliest reset.
fn evaluate(snap: Option<&QuotaSnapshot>, now: i64, min: f64, allow_unknown: bool) -> (&'static str, Option<i64>) {
    let Some(s) = snap else {
        return (if allow_unknown { V_ELIGIBLE } else { V_UNKNOWN }, None);
    };
    if s.observed_at_epoch_ms > now {
        return (V_FUTURE, None);
    }
    if now.saturating_sub(s.observed_at_epoch_ms) > s.stale_after_ms {
        return (V_STALE, None);
    }
    if !s.remaining_pct.is_finite() || !(0.0..=100.0).contains(&s.remaining_pct) {
        return (V_INVALID_PCT, None);
    }
    let future_reset = s.resets_at_epoch_ms.filter(|&r| r > now);
    if s.hard_limited && s.resets_at_epoch_ms.is_none_or(|r| r > now) {
        return (V_HARD, future_reset);
    }
    if s.remaining_pct < min {
        return (V_BELOW, future_reset);
    }
    (V_ELIGIBLE, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mr(model: &str) -> ModelRef {
        ModelRef { provider: "p".into(), model: model.into() }
    }
    fn snap(obs: i64, pct: f64, hard: bool, reset: Option<i64>) -> QuotaSnapshot {
        QuotaSnapshot { provider: "p".into(), model: "m".into(), observed_at_epoch_ms: obs, stale_after_ms: 100, remaining_pct: pct, hard_limited: hard, resets_at_epoch_ms: reset }
    }
    fn req(min: f64, quotas: Vec<QuotaSnapshot>) -> RouteRequest {
        RouteRequest { primary: mr("m"), backup_order: vec![], quotas, now_epoch_ms: 1000, min_remaining_pct: min, allow_unknown_quota: false }
    }
    fn reasons(r: &RouteResponse) -> Vec<&'static str> {
        r.tried.iter().map(|t| t.reason).collect()
    }

    #[test]
    fn invalid_threshold_short_circuits() {
        for pct in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.5, 100.5] {
            let r = route(&req(pct, vec![snap(999, 80.0, false, None)]));
            assert!(r.selected.is_none(), "{pct}");
            assert_eq!(r.reason, "invalid_threshold", "{pct}");
            assert!(r.tried.is_empty(), "{pct}");
            assert!(r.earliest_reset_epoch_ms.is_none(), "{pct}");
        }
        assert_eq!(route(&req(0.0, vec![snap(999, 80.0, false, None)])).reason, "eligible");
        assert_eq!(route(&req(100.0, vec![snap(999, 100.0, false, None)])).reason, "eligible");
    }

    #[test]
    fn candidates_deduped_and_short_circuit() {
        let quotas = vec![
            QuotaSnapshot { model: "a".into(), ..snap(999, 10.0, false, None) },
            QuotaSnapshot { model: "b".into(), ..snap(999, 90.0, false, None) },
        ];
        let r = RouteRequest { primary: mr("a"), backup_order: vec![mr("a"), mr("b"), mr("a"), mr("c")], ..req(50.0, quotas) };
        let out = route(&r);
        assert_eq!(out.selected, Some(mr("b")));
        assert_eq!(reasons(&out), vec!["below_threshold", "eligible"]);
    }

    #[test]
    fn duplicate_snapshots_latest_wins_tie_prefers_later_slice() {
        let older = QuotaSnapshot { observed_at_epoch_ms: 500, remaining_pct: 10.0, ..snap(0, 0.0, false, None) };
        let newer = QuotaSnapshot { observed_at_epoch_ms: 900, remaining_pct: 90.0, ..snap(0, 0.0, false, None) };
        assert_eq!(route(&req(50.0, vec![older.clone(), newer.clone()])).reason, "eligible");
        assert_eq!(route(&req(50.0, vec![newer.clone(), older])).reason, "eligible");
        let high = QuotaSnapshot { remaining_pct: 90.0, ..newer.clone() };
        let low = QuotaSnapshot { remaining_pct: 10.0, ..newer };
        assert_eq!(route(&req(50.0, vec![high.clone(), low.clone()])).reason, "below_threshold");
        assert_eq!(route(&req(50.0, vec![low, high])).reason, "eligible");
    }

    #[test]
    fn missing_snapshot_gated_by_allow_unknown() {
        assert_eq!(route(&req(50.0, vec![])).tried[0].reason, "unknown_quota");
        let out = route(&RouteRequest { allow_unknown_quota: true, ..req(50.0, vec![]) });
        assert_eq!(out.selected, Some(mr("m")));
        assert_eq!(reasons(&out), vec!["eligible"]);
    }

    #[test]
    fn freshness_verdicts_and_boundaries() {
        assert_eq!(route(&req(50.0, vec![snap(1001, 80.0, false, None)])).reason, "future_timestamp");
        assert_eq!(route(&req(50.0, vec![snap(899, 80.0, false, None)])).reason, "stale"); // age 101 > 100
        assert_eq!(route(&req(50.0, vec![snap(900, 80.0, false, None)])).reason, "eligible"); // age == stale_after is fresh
    }

    #[test]
    fn invalid_pct_precedes_hard_limited_and_suppresses_reset() {
        for pct in [f64::NAN, f64::INFINITY, -1.0, 100.1] {
            let out = route(&req(50.0, vec![snap(999, pct, true, Some(5000))]));
            assert_eq!(out.reason, "invalid_remaining_pct", "{pct}");
            assert!(out.earliest_reset_epoch_ms.is_none(), "{pct}");
        }
    }

    #[test]
    fn hard_limited_window_and_reset_contribution() {
        let out = route(&req(50.0, vec![snap(999, 90.0, true, None)]));
        assert_eq!(out.reason, "hard_limited");
        assert!(out.earliest_reset_epoch_ms.is_none());
        let out = route(&req(50.0, vec![snap(999, 90.0, true, Some(1500))]));
        assert_eq!(out.reason, "hard_limited");
        assert_eq!(out.earliest_reset_epoch_ms, Some(1500));
        assert_eq!(route(&req(50.0, vec![snap(999, 90.0, true, Some(1000))])).reason, "eligible"); // resets_at == now expired
        assert_eq!(route(&req(50.0, vec![snap(999, 10.0, true, Some(1000))])).reason, "below_threshold");
    }

    #[test]
    fn below_threshold_contributes_only_future_reset() {
        let out = route(&req(50.0, vec![snap(999, 10.0, false, Some(1500))]));
        assert_eq!(out.reason, "below_threshold");
        assert_eq!(out.earliest_reset_epoch_ms, Some(1500));
        assert!(route(&req(50.0, vec![snap(999, 10.0, false, Some(500))])).earliest_reset_epoch_ms.is_none());
        assert_eq!(route(&req(50.0, vec![snap(999, 50.0, false, None)])).reason, "eligible"); // boundary ==
    }

    #[test]
    fn earliest_reset_is_min_across_rejected_candidates() {
        let quotas = vec![
            QuotaSnapshot { model: "a".into(), ..snap(999, 10.0, false, Some(2000)) },
            QuotaSnapshot { model: "b".into(), ..snap(999, 90.0, true, Some(1500)) },
            QuotaSnapshot { model: "c".into(), ..snap(999, 90.0, false, None) },
        ];
        let r = RouteRequest { primary: mr("a"), backup_order: vec![mr("b"), mr("c")], ..req(50.0, quotas) };
        let out = route(&r);
        assert_eq!(out.selected, Some(mr("c")));
        assert_eq!(reasons(&out), vec!["below_threshold", "hard_limited", "eligible"]);
        assert_eq!(out.earliest_reset_epoch_ms, Some(1500));
        let out = route(&req(50.0, vec![snap(999, 10.0, false, None)]));
        assert!(out.selected.is_none());
        assert_eq!(out.reason, "below_threshold"); // exhausted: last verdict survives
    }
}

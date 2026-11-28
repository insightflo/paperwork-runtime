//! Deterministic provider fallback-chain selection over observed health states.
//!
//! Candidates are evaluated in input order. Excluded, rate-limited, and
//! unavailable providers are skipped with an ordered audit trail; healthy,
//! degraded, and unobserved providers are selectable. Later duplicate health
//! entries win.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Health state attached to a fallback candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealthStatus {
    Healthy,
    RateLimited,
    Degraded,
    Unavailable,
}

/// Latest health observation for one provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthEntry {
    pub provider: String,
    pub status: ProviderHealthStatus,
    pub reason: Option<String>,
}

/// One candidate skipped during fallback selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedCandidate {
    pub provider: String,
    pub reason: String,
}

/// Fallback-chain selection result and its ordered skip audit trail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FallbackChainDecision {
    pub selected: Option<String>,
    pub skipped: Vec<SkippedCandidate>,
}

/// Select the first usable candidate; see module docs for the contract.
pub fn select_fallback_provider(
    candidates: &[String],
    health_states: &[ProviderHealthEntry],
    excluded: &[String],
) -> FallbackChainDecision {
    let mut health_by_provider: HashMap<String, &ProviderHealthEntry> = HashMap::with_capacity(health_states.len());
    for entry in health_states {
        health_by_provider.insert(entry.provider.clone(), entry);
    }
    let excluded_set: HashSet<&str> = excluded.iter().map(String::as_str).collect();
    let mut skipped = Vec::new();

    for candidate in candidates {
        if excluded_set.contains(candidate.as_str()) {
            skipped.push(SkippedCandidate { provider: candidate.clone(), reason: "excluded".into() });
            continue;
        }
        if let Some(entry) = health_by_provider.get(candidate.as_str()) {
            let skip_reason = match entry.status {
                ProviderHealthStatus::RateLimited => Some(entry.reason.clone().unwrap_or_else(|| "rate_limited".into())),
                ProviderHealthStatus::Unavailable => Some(entry.reason.clone().unwrap_or_else(|| "unavailable".into())),
                ProviderHealthStatus::Healthy | ProviderHealthStatus::Degraded => None,
            };
            if let Some(reason) = skip_reason {
                skipped.push(SkippedCandidate { provider: candidate.clone(), reason });
                continue;
            }
        }
        return FallbackChainDecision { selected: Some(candidate.clone()), skipped };
    }

    FallbackChainDecision { selected: None, skipped }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(value: &str) -> String {
        value.into()
    }

    fn entry(provider: &str, status: ProviderHealthStatus, reason: Option<&str>) -> ProviderHealthEntry {
        ProviderHealthEntry { provider: s(provider), status, reason: reason.map(s) }
    }

    fn skip(provider: &str, reason: &str) -> SkippedCandidate {
        SkippedCandidate { provider: s(provider), reason: s(reason) }
    }

    #[test]
    fn empty_candidates_selects_none() {
        assert_eq!(select_fallback_provider(&[], &[], &[]), FallbackChainDecision { selected: None, skipped: vec![] });
    }

    #[test]
    fn all_blocked_or_excluded_preserves_ordered_skip_audit() {
        let candidates = vec![s("anthropic"), s("openai"), s("gemini")];
        let health = vec![
            entry("openai", ProviderHealthStatus::RateLimited, None),
            entry("gemini", ProviderHealthStatus::Unavailable, Some("region outage")),
        ];
        let decision = select_fallback_provider(&candidates, &health, &[s("anthropic")]);
        assert_eq!(decision.selected, None);
        assert_eq!(decision.skipped, vec![skip("anthropic", "excluded"), skip("openai", "rate_limited"), skip("gemini", "region outage")]);
    }

    #[test]
    fn first_healthy_candidate_after_skips_is_selected() {
        let candidates = vec![s("anthropic"), s("openai"), s("gemini")];
        let health = vec![
            entry("anthropic", ProviderHealthStatus::RateLimited, Some("429")),
            entry("openai", ProviderHealthStatus::Healthy, None),
            entry("gemini", ProviderHealthStatus::Unavailable, Some("must not be evaluated")),
        ];
        let decision = select_fallback_provider(&candidates, &health, &[]);
        assert_eq!(decision.selected, Some(s("openai")));
        assert_eq!(decision.skipped, vec![skip("anthropic", "429")]);
    }

    #[test]
    fn duplicate_health_states_use_last_entry() {
        let candidates = vec![s("openai")];
        let unavailable_then_healthy = vec![
            entry("openai", ProviderHealthStatus::Unavailable, Some("old outage")),
            entry("openai", ProviderHealthStatus::Healthy, None),
        ];
        assert_eq!(select_fallback_provider(&candidates, &unavailable_then_healthy, &[]).selected, Some(s("openai")));

        let healthy_then_unavailable = vec![
            entry("openai", ProviderHealthStatus::Healthy, None),
            entry("openai", ProviderHealthStatus::Unavailable, None),
        ];
        let decision = select_fallback_provider(&candidates, &healthy_then_unavailable, &[]);
        assert_eq!(decision.selected, None);
        assert_eq!(decision.skipped, vec![skip("openai", "unavailable")]);
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let status_json = serde_json::to_string(&ProviderHealthStatus::RateLimited).unwrap();
        assert_eq!(status_json, "\"rate_limited\"");
        assert_eq!(serde_json::from_str::<ProviderHealthStatus>(&status_json).unwrap(), ProviderHealthStatus::RateLimited);

        let entry = entry("openai", ProviderHealthStatus::Degraded, Some("elevated latency"));
        let decoded: ProviderHealthEntry = serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert_eq!(decoded.provider, entry.provider);
        assert_eq!(decoded.status, entry.status);
        assert_eq!(decoded.reason, entry.reason);

        let decision = FallbackChainDecision { selected: Some(s("gemini")), skipped: vec![skip("openai", "excluded")] };
        let decoded: FallbackChainDecision = serde_json::from_str(&serde_json::to_string(&decision).unwrap()).unwrap();
        assert_eq!(decoded, decision);
    }
}

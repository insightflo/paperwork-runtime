//! Deterministic failover and free-tier hit telemetry for route outcomes.
//!
//! The reducer is intentionally pure: callers own event collection, while this
//! module only converts an ordered-or-unordered event slice into exact
//! percentage summaries without rounding, time dependence, or I/O.

use serde::{Deserialize, Serialize};

/// One recorded route outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteOutcomeEvent {
    pub used_primary: bool,
    pub used_free_tier: bool,
    pub exhausted_all_candidates: bool,
}

/// Aggregate hit rates for a batch of route outcomes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteTelemetrySummary {
    pub total_routes: usize,
    pub primary_hit_pct: f64,
    pub free_tier_pct: f64,
    pub exhaustion_rate_pct: f64,
}

/// Summarize route outcomes as exact percentages in the inclusive range 0..=100.
pub fn summarize_route_telemetry(events: &[RouteOutcomeEvent]) -> RouteTelemetrySummary {
    let total = events.len();
    if total == 0 {
        return RouteTelemetrySummary {
            total_routes: 0,
            primary_hit_pct: 0.0,
            free_tier_pct: 0.0,
            exhaustion_rate_pct: 0.0,
        };
    }

    let primary_hits = events.iter().filter(|event| event.used_primary).count();
    let free_tier_hits = events.iter().filter(|event| event.used_free_tier).count();
    let exhaustions = events.iter().filter(|event| event.exhausted_all_candidates).count();

    RouteTelemetrySummary {
        total_routes: total,
        primary_hit_pct: pct(primary_hits, total),
        free_tier_pct: pct(free_tier_hits, total),
        exhaustion_rate_pct: pct(exhaustions, total),
    }
}

fn pct(count: usize, total: usize) -> f64 {
    (count as f64 / total as f64) * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(used_primary: bool, used_free_tier: bool, exhausted_all_candidates: bool) -> RouteOutcomeEvent {
        RouteOutcomeEvent { used_primary, used_free_tier, exhausted_all_candidates }
    }

    #[test]
    fn empty_events_produce_zeroed_summary() {
        assert_eq!(
            summarize_route_telemetry(&[]),
            RouteTelemetrySummary {
                total_routes: 0,
                primary_hit_pct: 0.0,
                free_tier_pct: 0.0,
                exhaustion_rate_pct: 0.0,
            }
        );
    }

    #[test]
    fn all_primary_free_tier_hits_are_100_percent() {
        let events = vec![event(true, true, false), event(true, true, false), event(true, true, false)];
        assert_eq!(
            summarize_route_telemetry(&events),
            RouteTelemetrySummary {
                total_routes: 3,
                primary_hit_pct: 100.0,
                free_tier_pct: 100.0,
                exhaustion_rate_pct: 0.0,
            }
        );
    }

    #[test]
    fn mixed_fallback_and_exhaustion_rates_are_exact() {
        let events = vec![
            event(true, false, false),
            event(false, true, false),
            event(false, false, false),
            event(false, false, true),
        ];
        assert_eq!(
            summarize_route_telemetry(&events),
            RouteTelemetrySummary {
                total_routes: 4,
                primary_hit_pct: 25.0,
                free_tier_pct: 25.0,
                exhaustion_rate_pct: 25.0,
            }
        );
    }

    #[test]
    fn serde_round_trip_preserves_events_and_summary() {
        let event = event(false, true, true);
        let decoded_event: RouteOutcomeEvent = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        assert!(!decoded_event.used_primary);
        assert!(decoded_event.used_free_tier);
        assert!(decoded_event.exhausted_all_candidates);

        let summary = summarize_route_telemetry(&[event]);
        let decoded_summary: RouteTelemetrySummary =
            serde_json::from_str(&serde_json::to_string(&summary).unwrap()).unwrap();
        assert_eq!(decoded_summary, summary);
    }
}

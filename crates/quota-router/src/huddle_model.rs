//! Advisory gate and huddle model routing.
//!
//! High-risk gates and second-round huddles always use the caller-provided
//! frontier route. Lightweight advisory contexts prefer the free local Devin
//! route when it is available and otherwise fall back to the same frontier route.

use serde::{Deserialize, Serialize};

/// Advisory execution context that determines whether frontier quality is mandatory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisoryContextKind {
    RoutineVerify,
    G1PlanReview,
    G2RepeatFailure,
    G3HighRiskSubmit,
    HuddleRound1,
    HuddleRound2,
}

/// Model routing input for one advisory gate or huddle invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorModelRouteInput {
    pub context: AdvisoryContextKind,
    pub devin_local_available: bool,
    pub frontier_adapter: String,
    pub frontier_model: String,
}

/// Selected adapter/model pair plus the machine-readable routing reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvisorModelRouteDecision {
    pub adapter: String,
    pub model: String,
    pub uses_frontier: bool,
    pub reason: String,
}

/// Select the advisory model route; see module docs for the routing contract.
pub fn select_advisory_model(input: &AdvisorModelRouteInput) -> AdvisorModelRouteDecision {
    let frontier_required = matches!(
        input.context,
        AdvisoryContextKind::G2RepeatFailure | AdvisoryContextKind::G3HighRiskSubmit | AdvisoryContextKind::HuddleRound2
    );
    if frontier_required || !input.devin_local_available {
        return AdvisorModelRouteDecision {
            adapter: input.frontier_adapter.clone(),
            model: input.frontier_model.clone(),
            uses_frontier: true,
            reason: if frontier_required { "frontier_required_for_gate" } else { "devin_local_unavailable_fallback" }.into(),
        };
    }
    AdvisorModelRouteDecision {
        adapter: "devin_local".into(),
        model: "swe-2-flash-medium".into(),
        uses_frontier: false,
        reason: "free_tier_advisory_fast_path".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route_input(context: AdvisoryContextKind, devin_local_available: bool) -> AdvisorModelRouteInput {
        AdvisorModelRouteInput {
            context,
            devin_local_available,
            frontier_adapter: "frontier_adapter".into(),
            frontier_model: "frontier_model".into(),
        }
    }

    fn frontier_decision(reason: &str) -> AdvisorModelRouteDecision {
        AdvisorModelRouteDecision {
            adapter: "frontier_adapter".into(),
            model: "frontier_model".into(),
            uses_frontier: true,
            reason: reason.into(),
        }
    }

    #[test]
    fn lightweight_contexts_use_free_devin_local_when_available() {
        for context in [AdvisoryContextKind::RoutineVerify, AdvisoryContextKind::G1PlanReview, AdvisoryContextKind::HuddleRound1] {
            let decision = select_advisory_model(&route_input(context, true));
            assert_eq!(decision.adapter, "devin_local", "{context:?}");
            assert_eq!(decision.model, "swe-2-flash-medium", "{context:?}");
            assert!(!decision.uses_frontier, "{context:?}");
            assert_eq!(decision.reason, "free_tier_advisory_fast_path", "{context:?}");
        }
    }

    #[test]
    fn frontier_required_contexts_ignore_devin_local_availability() {
        for context in [AdvisoryContextKind::G2RepeatFailure, AdvisoryContextKind::G3HighRiskSubmit, AdvisoryContextKind::HuddleRound2] {
            assert_eq!(select_advisory_model(&route_input(context, true)), frontier_decision("frontier_required_for_gate"), "{context:?}");
        }
    }

    #[test]
    fn lightweight_contexts_fall_back_to_frontier_when_devin_local_is_unavailable() {
        for context in [AdvisoryContextKind::RoutineVerify, AdvisoryContextKind::G1PlanReview, AdvisoryContextKind::HuddleRound1] {
            assert_eq!(select_advisory_model(&route_input(context, false)), frontier_decision("devin_local_unavailable_fallback"), "{context:?}");
        }
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let input = route_input(AdvisoryContextKind::HuddleRound2, true);
        let decoded: AdvisorModelRouteInput = serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
        assert_eq!(decoded.context, input.context);
        assert!(decoded.devin_local_available);
        assert_eq!(decoded.frontier_adapter, input.frontier_adapter);
        assert_eq!(decoded.frontier_model, input.frontier_model);

        let decision = frontier_decision("frontier_required_for_gate");
        let decoded: AdvisorModelRouteDecision = serde_json::from_str(&serde_json::to_string(&decision).unwrap()).unwrap();
        assert_eq!(decoded, decision);
    }
}

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HybridDispatchRoute { DirectFastOneShot, DirectFrontierWithVerify, SplitFanoutWithG3, HoldQueueFull }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridDispatchPolicyInput {
    pub active_workers: u32,
    pub max_workers: u32,
    pub is_high_risk: bool,
    pub subtask_count: u32,
    pub identical_error_streak: u32,
    pub split_saves_tokens: bool,
    pub fast_adapter_demoted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HybridDispatchPolicyDecision {
    pub route: HybridDispatchRoute,
    pub allocated_workers: u32,
    pub require_g1: bool,
    pub require_g3: bool,
    pub reason: String,
}

fn decision(
    route: HybridDispatchRoute, allocated_workers: u32, require_g1: bool, require_g3: bool, reason: &str,
) -> HybridDispatchPolicyDecision {
    HybridDispatchPolicyDecision { route, allocated_workers, require_g1, require_g3, reason: reason.into() }
}

pub fn evaluate_hybrid_dispatch_policy(input: &HybridDispatchPolicyInput) -> HybridDispatchPolicyDecision {
    use HybridDispatchRoute::*;

    let cap = if input.max_workers == 0 { 4 } else { input.max_workers };
    let free_slots = cap.saturating_sub(input.active_workers);

    if free_slots == 0 {
        return decision(HoldQueueFull, 0, false, false, "worker_cap_reached");
    }

    if input.subtask_count >= 2
        && free_slots >= 2
        && (input.is_high_risk || input.split_saves_tokens)
    {
        return decision(
            SplitFanoutWithG3, input.subtask_count.min(free_slots), input.is_high_risk, true,
            "split_fanout_approved",
        );
    }

    if input.is_high_risk || input.identical_error_streak >= 2 || input.fast_adapter_demoted {
        return decision(
            DirectFrontierWithVerify, 1, input.is_high_risk, input.is_high_risk, "frontier_promoted",
        );
    }

    decision(DirectFastOneShot, 1, false, false, "fast_one_shot")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> HybridDispatchPolicyInput {
        HybridDispatchPolicyInput {
            active_workers: 0, max_workers: 4, is_high_risk: false, subtask_count: 1,
            identical_error_streak: 0, split_saves_tokens: false, fast_adapter_demoted: false,
        }
    }

    #[test]
    fn queue_full_holds_dispatch() {
        let mut full = input();
        full.active_workers = 4;
        let decision = evaluate_hybrid_dispatch_policy(&full);
        assert_eq!(decision.route, HybridDispatchRoute::HoldQueueFull);
        assert_eq!(decision.allocated_workers, 0);
        assert!(!decision.require_g1 && !decision.require_g3);
        assert_eq!(decision.reason, "worker_cap_reached");
    }

    #[test]
    fn fast_one_shot_is_default_and_zero_max_defaults_to_four() {
        let decision = evaluate_hybrid_dispatch_policy(&input());
        assert_eq!(decision.route, HybridDispatchRoute::DirectFastOneShot);
        assert_eq!(decision.allocated_workers, 1);
        assert!(!decision.require_g1 && !decision.require_g3);
        assert_eq!(decision.reason, "fast_one_shot");

        let mut zero_max = input();
        zero_max.active_workers = 3;
        zero_max.max_workers = 0;
        assert_eq!(evaluate_hybrid_dispatch_policy(&zero_max).route, HybridDispatchRoute::DirectFastOneShot);
    }

    #[test]
    fn error_streak_or_demoted_adapter_promotes_frontier() {
        let mut streak = input();
        streak.identical_error_streak = 2;
        let by_streak = evaluate_hybrid_dispatch_policy(&streak);
        assert_eq!(by_streak.route, HybridDispatchRoute::DirectFrontierWithVerify);
        assert_eq!(by_streak.reason, "frontier_promoted");
        assert!(!by_streak.require_g1 && !by_streak.require_g3);

        let mut demoted = input();
        demoted.fast_adapter_demoted = true;
        let by_demotion = evaluate_hybrid_dispatch_policy(&demoted);
        assert_eq!(by_demotion.route, HybridDispatchRoute::DirectFrontierWithVerify);
        assert_eq!(by_demotion.allocated_workers, 1);
    }

    #[test]
    fn high_risk_and_roi_splits_are_capped_by_free_slots() {
        let mut high_risk = input();
        high_risk.active_workers = 2;
        high_risk.is_high_risk = true;
        high_risk.subtask_count = 5;
        let high_risk_decision = evaluate_hybrid_dispatch_policy(&high_risk);
        assert_eq!(high_risk_decision.route, HybridDispatchRoute::SplitFanoutWithG3);
        assert_eq!(high_risk_decision.allocated_workers, 2);
        assert!(high_risk_decision.require_g1 && high_risk_decision.require_g3);

        let mut roi = input();
        roi.subtask_count = 3;
        roi.split_saves_tokens = true;
        let roi_decision = evaluate_hybrid_dispatch_policy(&roi);
        assert_eq!(roi_decision.route, HybridDispatchRoute::SplitFanoutWithG3);
        assert_eq!(roi_decision.allocated_workers, 3);
        assert!(!roi_decision.require_g1 && roi_decision.require_g3);

        roi.active_workers = 3;
        assert_eq!(evaluate_hybrid_dispatch_policy(&roi).route, HybridDispatchRoute::DirectFastOneShot);
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let mut original = input();
        original.subtask_count = 3;
        original.split_saves_tokens = true;
        let input_json = serde_json::to_string(&original).unwrap();
        let decoded_input: HybridDispatchPolicyInput = serde_json::from_str(&input_json).unwrap();
        assert_eq!(serde_json::to_value(&decoded_input).unwrap(), serde_json::to_value(&original).unwrap());

        let decision = evaluate_hybrid_dispatch_policy(&decoded_input);
        assert_eq!(serde_json::to_value(decision.route).unwrap(), serde_json::json!("split_fanout_with_g3"));
        let decision_json = serde_json::to_string(&decision).unwrap();
        let decoded_decision: HybridDispatchPolicyDecision = serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decoded_decision, decision);
    }
}

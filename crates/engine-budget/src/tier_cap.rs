use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierShareCapInput {
    pub frontier_spend_cents: u64,
    pub total_spend_cents: u64,
    pub max_frontier_share_pct: u32,
    pub min_total_cents_for_enforcement: u64,
    pub is_mandatory_gate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TierShareCapDecision {
    pub allow_frontier: bool,
    pub frontier_share_pct: u32,
    pub reason: String,
}

pub fn evaluate_frontier_share_cap(input: &TierShareCapInput) -> TierShareCapDecision {
    let cap_pct = if input.max_frontier_share_pct == 0 {
        50
    } else {
        input.max_frontier_share_pct.clamp(1, 100)
    };
    let min_total = if input.min_total_cents_for_enforcement == 0 {
        500
    } else {
        input.min_total_cents_for_enforcement
    };
    let share_pct = if input.total_spend_cents == 0 {
        0
    } else {
        ((input.frontier_spend_cents as u128 * 100) / input.total_spend_cents as u128)
            .min(100) as u32
    };

    let (allow_frontier, reason) = if input.is_mandatory_gate {
        (true, "mandatory_gate_exempt")
    } else if input.total_spend_cents < min_total {
        (true, "below_min_spend_grace")
    } else if share_pct >= cap_pct {
        (false, "frontier_share_cap_reached")
    } else {
        (true, "within_frontier_share")
    };

    TierShareCapDecision {
        allow_frontier,
        frontier_share_pct: share_pct,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(frontier_spend_cents: u64, total_spend_cents: u64) -> TierShareCapInput {
        TierShareCapInput {
            frontier_spend_cents,
            total_spend_cents,
            max_frontier_share_pct: 0,
            min_total_cents_for_enforcement: 0,
            is_mandatory_gate: false,
        }
    }

    #[test]
    fn below_min_spend_grace_allows_even_at_full_share() {
        let decision = evaluate_frontier_share_cap(&input(499, 499));
        assert!(decision.allow_frontier);
        assert_eq!(decision.frontier_share_pct, 100);
        assert_eq!(decision.reason, "below_min_spend_grace");
    }

    #[test]
    fn within_share_allows_frontier() {
        let decision = evaluate_frontier_share_cap(&input(400, 1_000));
        assert!(decision.allow_frontier);
        assert_eq!(decision.frontier_share_pct, 40);
        assert_eq!(decision.reason, "within_frontier_share");
    }

    #[test]
    fn share_at_or_above_cap_blocks_frontier() {
        let decision = evaluate_frontier_share_cap(&input(500, 1_000));
        assert!(!decision.allow_frontier);
        assert_eq!(decision.frontier_share_pct, 50);
        assert_eq!(decision.reason, "frontier_share_cap_reached");

        let mut custom = input(750, 1_000);
        custom.max_frontier_share_pct = 75;
        let decision = evaluate_frontier_share_cap(&custom);
        assert!(!decision.allow_frontier);
        assert_eq!(decision.reason, "frontier_share_cap_reached");
    }

    #[test]
    fn mandatory_gate_is_exempt_even_at_full_share() {
        let mut mandatory = input(1_000, 1_000);
        mandatory.is_mandatory_gate = true;
        let decision = evaluate_frontier_share_cap(&mandatory);
        assert!(decision.allow_frontier);
        assert_eq!(decision.frontier_share_pct, 100);
        assert_eq!(decision.reason, "mandatory_gate_exempt");
    }

    #[test]
    fn zero_total_spend_is_safe() {
        let decision = evaluate_frontier_share_cap(&input(1, 0));
        assert!(decision.allow_frontier);
        assert_eq!(decision.frontier_share_pct, 0);
        assert_eq!(decision.reason, "below_min_spend_grace");
    }

    #[test]
    fn serde_round_trip_preserves_input_and_decision() {
        let cap_input = TierShareCapInput {
            frontier_spend_cents: 250,
            total_spend_cents: 1_000,
            max_frontier_share_pct: 75,
            min_total_cents_for_enforcement: 1_000,
            is_mandatory_gate: true,
        };
        let input_json = serde_json::to_string(&cap_input).unwrap();
        let decoded_input: TierShareCapInput = serde_json::from_str(&input_json).unwrap();
        assert_eq!(
            serde_json::to_value(decoded_input).unwrap(),
            serde_json::to_value(&cap_input).unwrap()
        );

        let decision = evaluate_frontier_share_cap(&cap_input);
        let decision_json = serde_json::to_string(&decision).unwrap();
        let decoded_decision: TierShareCapDecision =
            serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decoded_decision, decision);
    }
}

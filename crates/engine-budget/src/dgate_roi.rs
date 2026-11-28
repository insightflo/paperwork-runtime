use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchRoiInput {
    pub single_agent_expected_tokens: u64,
    pub single_agent_expected_retries: u32,
    pub split_worker_count: u32,
    pub per_worker_tokens: u64,
    pub advisor_gate_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchRoiDecision {
    pub single_agent_total_tokens: u64,
    pub split_total_tokens: u64,
    pub recommend_split: bool,
    pub estimated_saved_tokens: u64,
}

pub fn evaluate_split_token_roi(input: &DispatchRoiInput) -> DispatchRoiDecision {
    let attempts = u64::from(input.single_agent_expected_retries).saturating_add(1);
    let single_agent_total_tokens = input
        .single_agent_expected_tokens
        .saturating_mul(attempts);
    let workers = u64::from(input.split_worker_count.max(1));
    let split_total_tokens = input
        .per_worker_tokens
        .saturating_mul(workers)
        .saturating_add(input.advisor_gate_tokens);

    DispatchRoiDecision {
        single_agent_total_tokens,
        split_total_tokens,
        recommend_split: split_total_tokens < single_agent_total_tokens,
        estimated_saved_tokens: single_agent_total_tokens.saturating_sub(split_total_tokens),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        single_agent_expected_tokens: u64,
        single_agent_expected_retries: u32,
        split_worker_count: u32,
        per_worker_tokens: u64,
        advisor_gate_tokens: u64,
    ) -> DispatchRoiInput {
        DispatchRoiInput {
            single_agent_expected_tokens,
            single_agent_expected_retries,
            split_worker_count,
            per_worker_tokens,
            advisor_gate_tokens,
        }
    }

    #[test]
    fn one_shot_simple_issue_prefers_single_agent() {
        let decision = evaluate_split_token_roi(&input(2_000, 0, 2, 1_500, 500));

        assert_eq!(decision.single_agent_total_tokens, 2_000);
        assert_eq!(decision.split_total_tokens, 3_500);
        assert!(!decision.recommend_split);
        assert_eq!(decision.estimated_saved_tokens, 0);
    }

    #[test]
    fn high_retry_complex_issue_prefers_split_with_exact_savings() {
        let decision = evaluate_split_token_roi(&input(3_000, 3, 3, 2_000, 1_000));

        assert_eq!(decision.single_agent_total_tokens, 12_000);
        assert_eq!(decision.split_total_tokens, 7_000);
        assert!(decision.recommend_split);
        assert_eq!(decision.estimated_saved_tokens, 5_000);
    }

    #[test]
    fn exact_token_tie_prefers_single_agent() {
        let decision = evaluate_split_token_roi(&input(2_000, 1, 2, 1_500, 1_000));

        assert_eq!(decision.single_agent_total_tokens, 4_000);
        assert_eq!(decision.split_total_tokens, 4_000);
        assert!(!decision.recommend_split);
        assert_eq!(decision.estimated_saved_tokens, 0);
    }

    #[test]
    fn saturating_math_avoids_overflow_and_zero_worker_means_one_worker() {
        let decision = evaluate_split_token_roi(&input(u64::MAX, 1, 0, u64::MAX, 10));

        assert_eq!(decision.single_agent_total_tokens, u64::MAX);
        assert_eq!(decision.split_total_tokens, u64::MAX);
        assert!(!decision.recommend_split);
        assert_eq!(decision.estimated_saved_tokens, 0);
    }

    #[test]
    fn serde_round_trip_preserves_input_and_decision() {
        let roi_input = input(4_000, 2, 3, 2_500, 800);
        let input_json = serde_json::to_value(&roi_input).unwrap();
        let decoded_input: DispatchRoiInput = serde_json::from_value(input_json.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded_input).unwrap(), input_json);

        let decision = evaluate_split_token_roi(&roi_input);
        let decision_json = serde_json::to_string(&decision).unwrap();
        let decoded_decision: DispatchRoiDecision = serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decoded_decision, decision);
    }
}

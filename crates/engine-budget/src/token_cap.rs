use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenOverheadVerdict {
    Healthy,
    OverheadWarning,
    BlockNonProduction,
    HardTokenCapReached,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTokenUsageInput {
    pub production_tokens: u64,
    pub overhead_tokens: u64,
    pub hard_token_cap: u64,
    pub max_overhead_ratio: Option<f64>,
    pub min_total_tokens_for_ratio: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenOverheadDecision {
    pub verdict: TokenOverheadVerdict,
    pub total_tokens: u64,
    pub overhead_ratio: f64,
    pub allow_overhead_wakeup: bool,
    pub reason: String,
}

pub fn evaluate_workflow_token_overhead(
    input: &WorkflowTokenUsageInput,
) -> TokenOverheadDecision {
    let total = input.production_tokens.saturating_add(input.overhead_tokens);
    let overhead_ratio = if total == 0 {
        0.0
    } else {
        input.overhead_tokens as f64 / total as f64
    };
    let max_ratio = input
        .max_overhead_ratio
        .filter(|v| v.is_finite())
        .unwrap_or(0.40)
        .clamp(0.05, 0.95);
    let min_total = if input.min_total_tokens_for_ratio == 0 {
        100_000
    } else {
        input.min_total_tokens_for_ratio
    };

    let (verdict, allow_overhead_wakeup, reason) = if input.hard_token_cap > 0
        && total >= input.hard_token_cap
    {
        (TokenOverheadVerdict::HardTokenCapReached, false, "hard_token_cap_reached")
    } else if total >= min_total && overhead_ratio >= max_ratio {
        (TokenOverheadVerdict::BlockNonProduction, false, "overhead_ratio_exceeded")
    } else if total >= min_total && overhead_ratio >= max_ratio * 0.75 {
        (TokenOverheadVerdict::OverheadWarning, true, "overhead_ratio_warning")
    } else {
        (TokenOverheadVerdict::Healthy, true, "within_token_policy")
    };

    TokenOverheadDecision {
        verdict,
        total_tokens: total,
        overhead_ratio,
        allow_overhead_wakeup,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(production_tokens: u64, overhead_tokens: u64) -> WorkflowTokenUsageInput {
        WorkflowTokenUsageInput {
            production_tokens,
            overhead_tokens,
            hard_token_cap: 0,
            max_overhead_ratio: None,
            min_total_tokens_for_ratio: 0,
        }
    }

    #[test]
    fn healthy_within_default_policy() {
        let decision = evaluate_workflow_token_overhead(&input(90_000, 10_000));
        assert_eq!(decision.verdict, TokenOverheadVerdict::Healthy);
        assert_eq!(decision.total_tokens, 100_000);
        assert!((decision.overhead_ratio - 0.10).abs() < 1e-12);
        assert!(decision.allow_overhead_wakeup);
        assert_eq!(decision.reason, "within_token_policy");
    }

    #[test]
    fn low_token_grace_period_skips_ratio_controls() {
        let decision = evaluate_workflow_token_overhead(&input(20_000, 70_000));
        assert_eq!(decision.verdict, TokenOverheadVerdict::Healthy);
        assert!(decision.allow_overhead_wakeup);
        assert_eq!(decision.reason, "within_token_policy");
    }

    #[test]
    fn warning_above_seventy_five_percent_of_max_ratio() {
        let decision = evaluate_workflow_token_overhead(&input(69_999, 30_001));
        assert_eq!(decision.verdict, TokenOverheadVerdict::OverheadWarning);
        assert!(decision.allow_overhead_wakeup);
        assert_eq!(decision.reason, "overhead_ratio_warning");
    }

    #[test]
    fn block_nonproduction_at_max_ratio() {
        let decision = evaluate_workflow_token_overhead(&input(60_000, 40_000));
        assert_eq!(decision.verdict, TokenOverheadVerdict::BlockNonProduction);
        assert!(!decision.allow_overhead_wakeup);
        assert_eq!(decision.reason, "overhead_ratio_exceeded");
    }

    #[test]
    fn hard_token_cap_takes_precedence_over_ratio_block() {
        let mut usage = input(40_000, 60_000);
        usage.hard_token_cap = 100_000;
        let decision = evaluate_workflow_token_overhead(&usage);
        assert_eq!(decision.verdict, TokenOverheadVerdict::HardTokenCapReached);
        assert!(!decision.allow_overhead_wakeup);
        assert_eq!(decision.reason, "hard_token_cap_reached");
    }

    #[test]
    fn serde_round_trips_contract_types() {
        let mut usage = input(65_000, 35_000);
        usage.max_overhead_ratio = Some(0.50);
        usage.min_total_tokens_for_ratio = 50_000;
        let encoded_usage = serde_json::to_string(&usage).unwrap();
        let decoded_usage: WorkflowTokenUsageInput = serde_json::from_str(&encoded_usage).unwrap();
        assert_eq!(decoded_usage.production_tokens, usage.production_tokens);
        assert_eq!(decoded_usage.overhead_tokens, usage.overhead_tokens);
        assert_eq!(decoded_usage.hard_token_cap, usage.hard_token_cap);
        assert_eq!(decoded_usage.max_overhead_ratio, usage.max_overhead_ratio);
        assert_eq!(
            decoded_usage.min_total_tokens_for_ratio,
            usage.min_total_tokens_for_ratio
        );

        assert_eq!(
            serde_json::to_value(TokenOverheadVerdict::HardTokenCapReached).unwrap(),
            serde_json::json!("hard_token_cap_reached")
        );
        let decision = evaluate_workflow_token_overhead(&usage);
        let encoded_decision = serde_json::to_string(&decision).unwrap();
        let decoded_decision: TokenOverheadDecision = serde_json::from_str(&encoded_decision).unwrap();
        assert_eq!(decoded_decision, decision);
    }
}

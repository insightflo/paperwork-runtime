use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DgateSavingsInput {
    pub zero_token_watchdog_skips: u64,
    pub avg_oversight_run_tokens: u64,
    pub g1_advisor_tokens: u64,
    pub g2_advisor_tokens: u64,
    pub g3_advisor_tokens: u64,
    pub free_tier_routed_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DgateSavingsSummary {
    pub avoided_oversight_tokens: u64,
    pub total_advisor_gate_tokens: u64,
    pub net_saved_tokens: i64,
    pub is_net_positive: bool,
}

pub fn summarize_dgate_savings(input: &DgateSavingsInput) -> DgateSavingsSummary {
    let avoided_oversight_tokens = input
        .zero_token_watchdog_skips
        .saturating_mul(input.avg_oversight_run_tokens);
    let total_advisor_gate_tokens = input
        .g1_advisor_tokens
        .saturating_add(input.g2_advisor_tokens)
        .saturating_add(input.g3_advisor_tokens);
    let gross_saved = avoided_oversight_tokens.saturating_add(input.free_tier_routed_tokens);
    let net_saved_tokens = (gross_saved as i128 - total_advisor_gate_tokens as i128)
        .clamp(i64::MIN as i128, i64::MAX as i128) as i64;

    DgateSavingsSummary {
        avoided_oversight_tokens,
        total_advisor_gate_tokens,
        net_saved_tokens,
        is_net_positive: net_saved_tokens > 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(skips: u64, avg: u64, advisors: [u64; 3], free: u64) -> DgateSavingsInput {
        DgateSavingsInput {
            zero_token_watchdog_skips: skips,
            avg_oversight_run_tokens: avg,
            g1_advisor_tokens: advisors[0],
            g2_advisor_tokens: advisors[1],
            g3_advisor_tokens: advisors[2],
            free_tier_routed_tokens: free,
        }
    }

    #[test]
    fn zero_input_has_zero_savings() {
        let summary = summarize_dgate_savings(&input(0, 0, [0, 0, 0], 0));
        assert_eq!(
            summary,
            DgateSavingsSummary {
                avoided_oversight_tokens: 0,
                total_advisor_gate_tokens: 0,
                net_saved_tokens: 0,
                is_net_positive: false,
            }
        );
    }

    #[test]
    fn watchdog_skips_and_free_tier_route_are_net_positive() {
        let summary = summarize_dgate_savings(&input(3, 1_000, [200, 300, 400], 500));
        assert_eq!(summary.avoided_oversight_tokens, 3_000);
        assert_eq!(summary.total_advisor_gate_tokens, 900);
        assert_eq!(summary.net_saved_tokens, 2_600);
        assert!(summary.is_net_positive);
    }

    #[test]
    fn advisor_spend_above_avoided_tokens_is_net_negative() {
        let summary = summarize_dgate_savings(&input(1, 100, [50, 100, 200], 0));
        assert_eq!(summary.avoided_oversight_tokens, 100);
        assert_eq!(summary.total_advisor_gate_tokens, 350);
        assert_eq!(summary.net_saved_tokens, -250);
        assert!(!summary.is_net_positive);
    }

    #[test]
    fn saturating_arithmetic_handles_extreme_values() {
        let saturated = summarize_dgate_savings(&input(
            u64::MAX,
            u64::MAX,
            [u64::MAX, u64::MAX, u64::MAX],
            u64::MAX,
        ));
        assert_eq!(saturated.avoided_oversight_tokens, u64::MAX);
        assert_eq!(saturated.total_advisor_gate_tokens, u64::MAX);
        assert_eq!(saturated.net_saved_tokens, 0);

        let positive_clamp = summarize_dgate_savings(&input(0, 0, [0, 0, 0], u64::MAX));
        assert_eq!(positive_clamp.net_saved_tokens, i64::MAX);
        assert!(positive_clamp.is_net_positive);

        let negative_clamp = summarize_dgate_savings(&input(0, 0, [u64::MAX, 0, 0], 0));
        assert_eq!(negative_clamp.net_saved_tokens, i64::MIN);
        assert!(!negative_clamp.is_net_positive);
    }

    #[test]
    fn serde_round_trip_preserves_input_and_summary() {
        let original = input(7, 11, [13, 17, 19], 23);
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: DgateSavingsInput = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.zero_token_watchdog_skips, 7);
        assert_eq!(decoded.avg_oversight_run_tokens, 11);
        assert_eq!(decoded.g1_advisor_tokens, 13);
        assert_eq!(decoded.g2_advisor_tokens, 17);
        assert_eq!(decoded.g3_advisor_tokens, 19);
        assert_eq!(decoded.free_tier_routed_tokens, 23);

        let summary = summarize_dgate_savings(&decoded);
        let summary_json = serde_json::to_value(&summary).unwrap();
        let decoded_summary: DgateSavingsSummary = serde_json::from_value(summary_json).unwrap();
        assert_eq!(decoded_summary, summary);
    }
}

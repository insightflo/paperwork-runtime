#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HuddleOutcome {
    Resolved,
    NeedsAnotherRound,
    EscalateToHuman,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HuddleRoundInput {
    pub step_run_id: String,
    pub round_index: u32,
    pub max_rounds: u32,
    pub consensus_reached: bool,
    pub blocking_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HuddleRoundDecision {
    pub outcome: HuddleOutcome,
    pub requires_human_card: bool,
    pub escalation_reason: Option<String>,
}

pub fn evaluate_huddle_round(input: &HuddleRoundInput) -> HuddleRoundDecision {
    let cap = if input.max_rounds == 0 { 2 } else { input.max_rounds };

    if input.consensus_reached {
        return HuddleRoundDecision {
            outcome: HuddleOutcome::Resolved,
            requires_human_card: false,
            escalation_reason: None,
        };
    }

    if input.round_index < cap {
        return HuddleRoundDecision {
            outcome: HuddleOutcome::NeedsAnotherRound,
            requires_human_card: false,
            escalation_reason: None,
        };
    }

    let escalation_reason = match input.blocking_summary.as_deref().map(str::trim) {
        Some(summary) if !summary.is_empty() => summary.to_string(),
        _ => format!("Huddle exhausted {} rounds for step run {}", cap, input.step_run_id.trim()),
    };

    HuddleRoundDecision {
        outcome: HuddleOutcome::EscalateToHuman,
        requires_human_card: true,
        escalation_reason: Some(escalation_reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(round_index: u32, max_rounds: u32, consensus_reached: bool, blocking_summary: Option<&str>) -> HuddleRoundInput {
        HuddleRoundInput {
            step_run_id: "  step-run-42  ".to_string(),
            round_index,
            max_rounds,
            consensus_reached,
            blocking_summary: blocking_summary.map(String::from),
        }
    }

    fn decision(
        outcome: HuddleOutcome,
        requires_human_card: bool,
        escalation_reason: Option<&str>,
    ) -> HuddleRoundDecision {
        HuddleRoundDecision {
            outcome,
            requires_human_card,
            escalation_reason: escalation_reason.map(String::from),
        }
    }

    #[test]
    fn consensus_resolves_immediately() {
        let result = evaluate_huddle_round(&input(99, 2, true, Some("still blocked")));
        assert_eq!(result, decision(HuddleOutcome::Resolved, false, None));
    }

    #[test]
    fn round_below_cap_needs_another_round() {
        let result = evaluate_huddle_round(&input(1, 3, false, Some("open disagreement")));
        assert_eq!(result, decision(HuddleOutcome::NeedsAnotherRound, false, None));
    }

    #[test]
    fn round_at_cap_escalates_with_trimmed_custom_summary() {
        let result = evaluate_huddle_round(&input(3, 3, false, Some("  budget owner disagrees  ")));
        assert_eq!(
            result,
            decision(HuddleOutcome::EscalateToHuman, true, Some("budget owner disagrees"))
        );
    }

    #[test]
    fn round_at_cap_escalates_with_fallback_summary() {
        for blocking_summary in [None, Some("   ")] {
            let result = evaluate_huddle_round(&input(3, 3, false, blocking_summary));
            assert_eq!(
                result,
                decision(
                    HuddleOutcome::EscalateToHuman,
                    true,
                    Some("Huddle exhausted 3 rounds for step run step-run-42"),
                )
            );
        }
    }

    #[test]
    fn zero_max_rounds_defaults_to_two() {
        let continuing = evaluate_huddle_round(&input(1, 0, false, None));
        assert_eq!(continuing, decision(HuddleOutcome::NeedsAnotherRound, false, None));

        let escalated = evaluate_huddle_round(&input(2, 0, false, None));
        assert_eq!(
            escalated,
            decision(
                HuddleOutcome::EscalateToHuman,
                true,
                Some("Huddle exhausted 2 rounds for step run step-run-42"),
            )
        );
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let original_input = input(2, 3, false, Some("waiting on budget owner"));
        let encoded_input = serde_json::to_string(&original_input).unwrap();
        let decoded_input: HuddleRoundInput = serde_json::from_str(&encoded_input).unwrap();
        assert_eq!(decoded_input.step_run_id, original_input.step_run_id);
        assert_eq!(decoded_input.round_index, original_input.round_index);
        assert_eq!(decoded_input.max_rounds, original_input.max_rounds);
        assert_eq!(decoded_input.consensus_reached, original_input.consensus_reached);
        assert_eq!(decoded_input.blocking_summary, original_input.blocking_summary);

        let original_decision = decision(HuddleOutcome::EscalateToHuman, true, Some("custom reason"));
        let encoded_decision = serde_json::to_string(&original_decision).unwrap();
        let decoded_decision: HuddleRoundDecision = serde_json::from_str(&encoded_decision).unwrap();
        assert_eq!(decoded_decision, original_decision);
        assert_eq!(
            serde_json::to_value(HuddleOutcome::NeedsAnotherRound).unwrap(),
            serde_json::json!("needs_another_round")
        );
    }
}

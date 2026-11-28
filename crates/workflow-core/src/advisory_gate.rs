use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisoryGateKind {
    None,
    G1PrePlan,
    G2RepeatFailure,
    G3PreSubmit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisoryGateInput {
    pub phase: String,
    pub is_high_risk: bool,
    pub identical_error_count: u32,
    pub advisor_already_passed_phase: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvisoryGateDecision {
    pub gate: AdvisoryGateKind,
    pub invoke_advisor: bool,
    pub reason: String,
}

pub fn evaluate_advisory_gate(input: &AdvisoryGateInput) -> AdvisoryGateDecision {
    if input.advisor_already_passed_phase {
        return decision(AdvisoryGateKind::None, false, "already_passed");
    }

    let phase = input.phase.trim().to_lowercase();
    match phase.as_str() {
        "plan" if input.is_high_risk => {
            decision(AdvisoryGateKind::G1PrePlan, true, "high_risk_plan_review")
        }
        "execute" if input.identical_error_count >= 2 => decision(
            AdvisoryGateKind::G2RepeatFailure,
            true,
            "repeat_error_second_occurrence",
        ),
        "submit" if input.is_high_risk => decision(
            AdvisoryGateKind::G3PreSubmit,
            true,
            "high_risk_pre_submit_review",
        ),
        _ => decision(AdvisoryGateKind::None, false, "zero_token_fast_path"),
    }
}

fn decision(gate: AdvisoryGateKind, invoke_advisor: bool, reason: &str) -> AdvisoryGateDecision {
    AdvisoryGateDecision {
        gate,
        invoke_advisor,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(phase: &str, is_high_risk: bool, identical_error_count: u32) -> AdvisoryGateInput {
        AdvisoryGateInput {
            phase: phase.to_string(),
            is_high_risk,
            identical_error_count,
            advisor_already_passed_phase: false,
        }
    }

    #[test]
    fn low_risk_plan_and_submit_use_zero_token_fast_path() {
        for phase in ["plan", "submit"] {
            let decision = evaluate_advisory_gate(&input(phase, false, 0));
            assert_eq!(decision.gate, AdvisoryGateKind::None);
            assert!(!decision.invoke_advisor);
            assert_eq!(decision.reason, "zero_token_fast_path");
        }
    }

    #[test]
    fn high_risk_plan_and_submit_trigger_g1_and_g3() {
        let cases = [
            ("  PLAN  ", AdvisoryGateKind::G1PrePlan, "high_risk_plan_review"),
            (
                "submit",
                AdvisoryGateKind::G3PreSubmit,
                "high_risk_pre_submit_review",
            ),
        ];

        for (phase, gate, reason) in cases {
            let decision = evaluate_advisory_gate(&input(phase, true, 0));
            assert_eq!(decision.gate, gate);
            assert!(decision.invoke_advisor);
            assert_eq!(decision.reason, reason);
        }
    }

    #[test]
    fn execute_triggers_g2_only_on_second_identical_error() {
        let first = evaluate_advisory_gate(&input("execute", false, 1));
        assert_eq!(first.gate, AdvisoryGateKind::None);
        assert!(!first.invoke_advisor);
        assert_eq!(first.reason, "zero_token_fast_path");

        let second = evaluate_advisory_gate(&input("execute", false, 2));
        assert_eq!(second.gate, AdvisoryGateKind::G2RepeatFailure);
        assert!(second.invoke_advisor);
        assert_eq!(second.reason, "repeat_error_second_occurrence");
    }

    #[test]
    fn already_passed_phase_is_idempotent_fast_path() {
        let input = AdvisoryGateInput {
            phase: "submit".to_string(),
            is_high_risk: true,
            identical_error_count: 2,
            advisor_already_passed_phase: true,
        };
        let decision = evaluate_advisory_gate(&input);
        assert_eq!(decision.gate, AdvisoryGateKind::None);
        assert!(!decision.invoke_advisor);
        assert_eq!(decision.reason, "already_passed");
    }

    #[test]
    fn serde_round_trip_preserves_input_and_decision() {
        let input = AdvisoryGateInput {
            phase: "execute".to_string(),
            is_high_risk: true,
            identical_error_count: 2,
            advisor_already_passed_phase: false,
        };
        let encoded_input = serde_json::to_string(&input).unwrap();
        let decoded_input: AdvisoryGateInput = serde_json::from_str(&encoded_input).unwrap();
        assert_eq!(decoded_input.phase, input.phase);
        assert_eq!(decoded_input.is_high_risk, input.is_high_risk);
        assert_eq!(
            decoded_input.identical_error_count,
            input.identical_error_count
        );
        assert_eq!(
            decoded_input.advisor_already_passed_phase,
            input.advisor_already_passed_phase
        );

        let decision = evaluate_advisory_gate(&input);
        let encoded_decision = serde_json::to_string(&decision).unwrap();
        let decoded_decision: AdvisoryGateDecision =
            serde_json::from_str(&encoded_decision).unwrap();
        assert_eq!(decoded_decision, decision);
    }
}

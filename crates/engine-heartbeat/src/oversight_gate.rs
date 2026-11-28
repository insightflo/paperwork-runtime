#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OversightSkipReason {
    HealthyActiveRun, RunCapReached, CooldownActive, NoActionableException,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OversightGateInput {
    pub latest_run_running: bool, pub failed_step_count: u32,
    pub has_exhausted_step_failure: bool, pub has_stall_breach: bool,
    pub has_qa_failure: bool, pub oversight_runs_this_workflow: u32,
    pub max_oversight_runs_per_workflow: u32, pub ms_since_last_oversight: Option<u64>,
    pub cooldown_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OversightGateDecision {
    pub allow_llm_wakeup: bool,
    pub skip_reason: Option<OversightSkipReason>,
    pub trigger_reason: Option<String>,
}

pub fn evaluate_oversight_wakeup(input: &OversightGateInput) -> OversightGateDecision {
    let cap = if input.max_oversight_runs_per_workflow == 0 { 5 } else { input.max_oversight_runs_per_workflow };
    if input.oversight_runs_this_workflow >= cap {
        return deny(OversightSkipReason::RunCapReached);
    }
    if input.ms_since_last_oversight.is_some_and(|ms| ms < input.cooldown_ms) {
        return deny(OversightSkipReason::CooldownActive);
    }
    let trigger = match (input.has_exhausted_step_failure, input.has_stall_breach, input.has_qa_failure) {
        (true, _, _) => Some("exhausted_step_failure"),
        (_, true, _) => Some("stall_breach"),
        (_, _, true) => Some("qa_failure"),
        _ => None,
    };
    if input.latest_run_running && input.failed_step_count == 0 && trigger.is_none() {
        return deny(OversightSkipReason::HealthyActiveRun);
    }
    if trigger.is_none() {
        return deny(OversightSkipReason::NoActionableException);
    }
    OversightGateDecision { allow_llm_wakeup: true, skip_reason: None, trigger_reason: trigger.map(String::from) }
}

fn deny(skip_reason: OversightSkipReason) -> OversightGateDecision {
    OversightGateDecision { allow_llm_wakeup: false, skip_reason: Some(skip_reason), trigger_reason: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input() -> OversightGateInput {
        OversightGateInput {
            latest_run_running: false, failed_step_count: 0,
            has_exhausted_step_failure: false, has_stall_breach: false, has_qa_failure: false,
            oversight_runs_this_workflow: 0, max_oversight_runs_per_workflow: 5,
            ms_since_last_oversight: None, cooldown_ms: 60_000,
        }
    }

    fn denied_reason(input: &OversightGateInput) -> OversightSkipReason {
        let decision = evaluate_oversight_wakeup(input);
        assert!(!decision.allow_llm_wakeup);
        assert!(decision.trigger_reason.is_none());
        decision.skip_reason.expect("denied decision carries a skip reason")
    }

    #[test]
    fn healthy_active_run_is_suppressed_with_zero_tokens() {
        let mut input = base_input();
        input.latest_run_running = true;
        assert_eq!(denied_reason(&input), OversightSkipReason::HealthyActiveRun);
    }

    #[test]
    fn cap_defaults_to_five_and_is_enforced_first() {
        let mut input = base_input();
        input.max_oversight_runs_per_workflow = 0;
        input.oversight_runs_this_workflow = 5;
        input.has_exhausted_step_failure = true;
        input.ms_since_last_oversight = Some(0);
        assert_eq!(denied_reason(&input), OversightSkipReason::RunCapReached);
    }

    #[test]
    fn cooldown_is_enforced_before_exceptions() {
        let mut input = base_input();
        input.ms_since_last_oversight = Some(999);
        input.cooldown_ms = 1_000;
        input.has_qa_failure = true;
        assert_eq!(denied_reason(&input), OversightSkipReason::CooldownActive);
    }

    #[test]
    fn exhausted_step_failure_is_allowed_with_highest_trigger_priority() {
        let mut input = base_input();
        input.has_exhausted_step_failure = true;
        input.has_stall_breach = true;
        input.has_qa_failure = true;
        let decision = evaluate_oversight_wakeup(&input);
        assert!(decision.allow_llm_wakeup && decision.skip_reason.is_none());
        assert_eq!(decision.trigger_reason.as_deref(), Some("exhausted_step_failure"));
    }

    #[test]
    fn stall_breach_is_allowed_without_exhausted_step_failure() {
        let mut input = base_input();
        input.has_stall_breach = true;
        input.has_qa_failure = true;
        let decision = evaluate_oversight_wakeup(&input);
        assert!(decision.allow_llm_wakeup);
        assert_eq!(decision.trigger_reason.as_deref(), Some("stall_breach"));
    }

    #[test]
    fn qa_failure_is_allowed_without_higher_priority_exceptions() {
        let mut input = base_input();
        input.has_qa_failure = true;
        let decision = evaluate_oversight_wakeup(&input);
        assert!(decision.allow_llm_wakeup);
        assert_eq!(decision.trigger_reason.as_deref(), Some("qa_failure"));
    }

    #[test]
    fn non_running_without_exception_is_suppressed() {
        assert_eq!(denied_reason(&base_input()), OversightSkipReason::NoActionableException);
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let input = base_input();
        let input_json = serde_json::to_string(&input).unwrap();
        let input_back: OversightGateInput = serde_json::from_str(&input_json).unwrap();
        assert_eq!(serde_json::to_string(&input_back).unwrap(), input_json);
        assert_eq!(
            serde_json::to_string(&OversightSkipReason::NoActionableException).unwrap(),
            "\"no_actionable_exception\""
        );
        let decision = OversightGateDecision {
            allow_llm_wakeup: true, skip_reason: None, trigger_reason: Some("qa_failure".to_string()),
        };
        let decision_json = serde_json::to_string(&decision).unwrap();
        let decision_back: OversightGateDecision = serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decision_back, decision);
    }
}

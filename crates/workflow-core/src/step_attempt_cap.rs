use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    InfraSigterm,
    InfraRateLimit,
    StaleQueued,
    ContentOrQa,
    RuntimeError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRetryCapInput {
    pub llm_attempts_used: u32,
    pub max_llm_attempts: u32,
    pub last_failure: FailureCategory,
    pub huddle_rounds_used: u32,
    pub max_huddle_rounds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepRetryAction {
    ZeroTokenBackoffRetry,
    AllowLlmRetry,
    RouteToExceptionHuddle,
    FailFastEscalate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepRetryDecision {
    pub action: StepRetryAction,
    pub counts_against_llm_cap: bool,
    pub reason: String,
}

fn decision(action: StepRetryAction, counts_against_llm_cap: bool, reason: &str) -> StepRetryDecision {
    StepRetryDecision { action, counts_against_llm_cap, reason: reason.to_string() }
}

pub fn evaluate_step_retry_cap(input: &StepRetryCapInput) -> StepRetryDecision {
    let max_llm = if input.max_llm_attempts == 0 { 3 } else { input.max_llm_attempts };
    let max_huddle = if input.max_huddle_rounds == 0 { 2 } else { input.max_huddle_rounds };

    if matches!(
        input.last_failure,
        FailureCategory::InfraSigterm | FailureCategory::InfraRateLimit | FailureCategory::StaleQueued
    ) {
        return decision(StepRetryAction::ZeroTokenBackoffRetry, false, "infra_zero_token_backoff");
    }

    if input.llm_attempts_used >= max_llm {
        if matches!(input.last_failure, FailureCategory::ContentOrQa)
            && input.huddle_rounds_used < max_huddle
        {
            return decision(
                StepRetryAction::RouteToExceptionHuddle,
                true,
                "llm_cap_reached_route_huddle",
            );
        }
        return decision(StepRetryAction::FailFastEscalate, true, "llm_cap_exhausted");
    }

    decision(StepRetryAction::AllowLlmRetry, true, "within_llm_cap")
}

pub fn should_dedup_owner_action(existing_step_run_ids: &[String], candidate_step_run_id: &str) -> bool {
    let candidate = candidate_step_run_id.trim();
    if candidate.is_empty() {
        return false;
    }
    existing_step_run_ids.iter().any(|existing| existing.trim() == candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(last_failure: FailureCategory, llm_attempts_used: u32, huddle_rounds_used: u32) -> StepRetryCapInput {
        StepRetryCapInput {
            llm_attempts_used,
            max_llm_attempts: 3,
            last_failure,
            huddle_rounds_used,
            max_huddle_rounds: 2,
        }
    }

    #[test]
    fn infra_failures_bypass_llm_cap() {
        for failure in [FailureCategory::InfraSigterm, FailureCategory::InfraRateLimit, FailureCategory::StaleQueued] {
            let decision = evaluate_step_retry_cap(&input(failure, 99, 0));
            assert_eq!(decision.action, StepRetryAction::ZeroTokenBackoffRetry);
            assert!(!decision.counts_against_llm_cap);
            assert_eq!(decision.reason, "infra_zero_token_backoff");
        }
    }

    #[test]
    fn llm_attempt_cap_defaults_to_three() {
        let mut below_cap = input(FailureCategory::RuntimeError, 2, 0);
        below_cap.max_llm_attempts = 0;
        let decision = evaluate_step_retry_cap(&below_cap);
        assert_eq!(decision.action, StepRetryAction::AllowLlmRetry);
        assert_eq!(decision.reason, "within_llm_cap");

        let mut at_cap = input(FailureCategory::RuntimeError, 3, 0);
        at_cap.max_llm_attempts = 0;
        let decision = evaluate_step_retry_cap(&at_cap);
        assert_eq!(decision.action, StepRetryAction::FailFastEscalate);
        assert!(decision.counts_against_llm_cap);
        assert_eq!(decision.reason, "llm_cap_exhausted");
    }

    #[test]
    fn content_or_qa_routes_to_huddle_then_escalates() {
        for huddle_rounds_used in [0, 1] {
            let decision = evaluate_step_retry_cap(&input(FailureCategory::ContentOrQa, 3, huddle_rounds_used));
            assert_eq!(decision.action, StepRetryAction::RouteToExceptionHuddle);
            assert!(decision.counts_against_llm_cap);
            assert_eq!(decision.reason, "llm_cap_reached_route_huddle");
        }
        let decision = evaluate_step_retry_cap(&input(FailureCategory::ContentOrQa, 3, 2));
        assert_eq!(decision.action, StepRetryAction::FailFastEscalate);
        assert_eq!(decision.reason, "llm_cap_exhausted");
    }

    #[test]
    fn owner_action_step_run_id_dedup_trims_both_sides() {
        let existing = vec![" sr-1 ".to_string(), "sr-2".to_string()];
        assert!(should_dedup_owner_action(&existing, "sr-1"));
        assert!(should_dedup_owner_action(&existing, " sr-2 "));
        assert!(!should_dedup_owner_action(&existing, "sr-3"));
        assert!(!should_dedup_owner_action(&existing, "   "));
        assert!(!should_dedup_owner_action(&[], "sr-1"));
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let input = input(FailureCategory::ContentOrQa, 3, 1);
        let encoded = serde_json::to_string(&input).unwrap();
        assert!(encoded.contains("\"last_failure\":\"content_or_qa\""));
        let decoded: StepRetryCapInput = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.last_failure, FailureCategory::ContentOrQa);
        assert_eq!(decoded.llm_attempts_used, 3);

        let decision = evaluate_step_retry_cap(&decoded);
        let encoded = serde_json::to_string(&decision).unwrap();
        assert!(encoded.contains("\"action\":\"route_to_exception_huddle\""));
        let decoded: StepRetryDecision = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, decision);
    }
}

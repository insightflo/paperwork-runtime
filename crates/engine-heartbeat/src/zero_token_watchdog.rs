#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

const DEFAULT_STALL_THRESHOLD_MS: u64 = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchdogAction {
    KeepRunning,
    TerminateAndBackoffRetry,
    TriggerG2Advisor,
    MarkSucceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessWatchdogInput {
    pub exit_code: Option<i32>,
    pub silent_ms: u64,
    pub stall_threshold_ms: u64,
    pub identical_error_streak: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchdogDecision {
    pub action: WatchdogAction,
    pub wake_llm_oversight: bool,
    pub reason: String,
}

pub fn evaluate_zero_token_watchdog(input: &ProcessWatchdogInput) -> WatchdogDecision {
    let stall_ms = if input.stall_threshold_ms == 0 {
        DEFAULT_STALL_THRESHOLD_MS
    } else {
        input.stall_threshold_ms
    };

    if input.exit_code == Some(0) {
        return decision(WatchdogAction::MarkSucceeded, false, "exit_zero_success");
    }
    if input.exit_code.is_some() {
        if input.identical_error_streak >= 2 {
            return decision(
                WatchdogAction::TriggerG2Advisor,
                true,
                "g2_repeat_failure_advisor",
            );
        }
        return decision(
            WatchdogAction::TerminateAndBackoffRetry,
            false,
            "first_failure_zero_token_retry",
        );
    }
    if input.silent_ms >= stall_ms {
        return decision(
            WatchdogAction::TerminateAndBackoffRetry,
            false,
            "stdout_stall_reap",
        );
    }
    decision(WatchdogAction::KeepRunning, false, "healthy_zero_token")
}

fn decision(action: WatchdogAction, wake_llm_oversight: bool, reason: &str) -> WatchdogDecision {
    WatchdogDecision {
        action,
        wake_llm_oversight,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        exit_code: Option<i32>,
        silent_ms: u64,
        stall_threshold_ms: u64,
        identical_error_streak: u32,
    ) -> ProcessWatchdogInput {
        ProcessWatchdogInput {
            exit_code,
            silent_ms,
            stall_threshold_ms,
            identical_error_streak,
        }
    }

    #[test]
    fn healthy_running_process_keeps_zero_token_path() {
        let decision = evaluate_zero_token_watchdog(&input(None, 10_000, 0, 0));
        assert_eq!(decision.action, WatchdogAction::KeepRunning);
        assert!(!decision.wake_llm_oversight);
        assert_eq!(decision.reason, "healthy_zero_token");
    }

    #[test]
    fn exit_zero_marks_succeeded_without_llm_oversight() {
        let decision = evaluate_zero_token_watchdog(&input(Some(0), 999_999, 0, 9));
        assert_eq!(decision.action, WatchdogAction::MarkSucceeded);
        assert!(!decision.wake_llm_oversight);
        assert_eq!(decision.reason, "exit_zero_success");
    }

    #[test]
    fn first_failure_retries_without_spending_tokens() {
        let decision = evaluate_zero_token_watchdog(&input(Some(17), 0, 0, 1));
        assert_eq!(decision.action, WatchdogAction::TerminateAndBackoffRetry);
        assert!(!decision.wake_llm_oversight);
        assert_eq!(decision.reason, "first_failure_zero_token_retry");
    }

    #[test]
    fn second_identical_failure_triggers_g2_advisor() {
        let decision = evaluate_zero_token_watchdog(&input(Some(17), 0, 0, 2));
        assert_eq!(decision.action, WatchdogAction::TriggerG2Advisor);
        assert!(decision.wake_llm_oversight);
        assert_eq!(decision.reason, "g2_repeat_failure_advisor");
    }

    #[test]
    fn stdout_stall_at_default_threshold_is_reaped() {
        let decision = evaluate_zero_token_watchdog(&input(None, 300_000, 0, 0));
        assert_eq!(decision.action, WatchdogAction::TerminateAndBackoffRetry);
        assert!(!decision.wake_llm_oversight);
        assert_eq!(decision.reason, "stdout_stall_reap");
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        assert_eq!(
            serde_json::to_value(WatchdogAction::TriggerG2Advisor).unwrap(),
            serde_json::json!("trigger_g2_advisor")
        );

        let original_input = input(Some(2), 42, 1_000, 2);
        let input_json = serde_json::to_string(&original_input).unwrap();
        let decoded_input: ProcessWatchdogInput = serde_json::from_str(&input_json).unwrap();
        assert_eq!(decoded_input.exit_code, original_input.exit_code);
        assert_eq!(decoded_input.silent_ms, original_input.silent_ms);
        assert_eq!(decoded_input.stall_threshold_ms, original_input.stall_threshold_ms);
        assert_eq!(decoded_input.identical_error_streak, original_input.identical_error_streak);

        let original_decision = evaluate_zero_token_watchdog(&original_input);
        let decision_json = serde_json::to_string(&original_decision).unwrap();
        let decoded_decision: WatchdogDecision = serde_json::from_str(&decision_json).unwrap();
        assert_eq!(decoded_decision, original_decision);
    }
}

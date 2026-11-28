//! Unified run-watchdog evaluation for dgate-hybrid heartbeat supervision.
//! Pure inputs in, deterministic supervision verdict out.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunWatchdogStatus {
    HealthySilent,
    ReapAndBackoff,
    EscalateG2,
    EscalateHumanCap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunWatchdogInput {
    pub silent_ms: u64,
    pub stall_limit_ms: u64,
    pub identical_error_streak: u32,
    pub total_llm_attempts: u32,
    pub max_llm_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunWatchdogVerdict {
    pub status: RunWatchdogStatus,
    pub wake_llm: bool,
    pub reason: String,
}

pub fn evaluate_run_watchdog(input: &RunWatchdogInput) -> RunWatchdogVerdict {
    let stall_ms = if input.stall_limit_ms == 0 { 300_000 } else { input.stall_limit_ms };
    let max_llm = if input.max_llm_attempts == 0 { 3 } else { input.max_llm_attempts };

    if input.total_llm_attempts >= max_llm {
        return verdict(RunWatchdogStatus::EscalateHumanCap, false, "llm_attempt_cap_reached");
    }
    if input.identical_error_streak >= 2 {
        return verdict(RunWatchdogStatus::EscalateG2, true, "g2_repeat_error_trigger");
    }
    if input.silent_ms >= stall_ms {
        return verdict(RunWatchdogStatus::ReapAndBackoff, false, "zero_token_stall_reap");
    }
    verdict(RunWatchdogStatus::HealthySilent, false, "healthy_no_llm")
}

fn verdict(status: RunWatchdogStatus, wake_llm: bool, reason: &str) -> RunWatchdogVerdict {
    RunWatchdogVerdict { status, wake_llm, reason: reason.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eval(
        silent_ms: u64,
        stall_limit_ms: u64,
        streak: u32,
        attempts: u32,
        max_llm: u32,
    ) -> RunWatchdogVerdict {
        evaluate_run_watchdog(&RunWatchdogInput {
            silent_ms,
            stall_limit_ms,
            identical_error_streak: streak,
            total_llm_attempts: attempts,
            max_llm_attempts: max_llm,
        })
    }

    #[test]
    fn healthy_zero_token_silence_does_not_wake_llm() {
        let verdict = eval(10_000, 300_000, 0, 0, 3);
        assert_eq!(verdict.status, RunWatchdogStatus::HealthySilent);
        assert!(!verdict.wake_llm);
        assert_eq!(verdict.reason, "healthy_no_llm");
    }

    #[test]
    fn zero_token_stall_reaps_and_backs_off() {
        let verdict = eval(300_000, 300_000, 0, 0, 3);
        assert_eq!(verdict.status, RunWatchdogStatus::ReapAndBackoff);
        assert!(!verdict.wake_llm);
        assert_eq!(verdict.reason, "zero_token_stall_reap");
    }

    #[test]
    fn g2_repeat_error_wakes_llm_before_stall_reap() {
        let verdict = eval(600_000, 300_000, 2, 0, 3);
        assert_eq!(verdict.status, RunWatchdogStatus::EscalateG2);
        assert!(verdict.wake_llm);
        assert_eq!(verdict.reason, "g2_repeat_error_trigger");
    }

    #[test]
    fn llm_attempt_cap_escalates_to_human_without_wake() {
        let verdict = eval(600_000, 300_000, 2, 3, 3);
        assert_eq!(verdict.status, RunWatchdogStatus::EscalateHumanCap);
        assert!(!verdict.wake_llm);
        assert_eq!(verdict.reason, "llm_attempt_cap_reached");
    }

    #[test]
    fn zero_limits_use_defaults() {
        assert_eq!(eval(299_999, 0, 0, 2, 0).status, RunWatchdogStatus::HealthySilent);
        assert_eq!(eval(300_000, 0, 0, 2, 0).status, RunWatchdogStatus::ReapAndBackoff);
        assert_eq!(eval(0, 300_000, 0, 3, 0).status, RunWatchdogStatus::EscalateHumanCap);
    }

    #[test]
    fn serde_round_trip_preserves_contracts() {
        let encoded_status = serde_json::to_string(&RunWatchdogStatus::EscalateG2).unwrap();
        assert_eq!(encoded_status, "\"escalate_g2\"");

        let input = RunWatchdogInput {
            silent_ms: 1,
            stall_limit_ms: 2,
            identical_error_streak: 3,
            total_llm_attempts: 4,
            max_llm_attempts: 5,
        };
        let encoded_input = serde_json::to_string(&input).unwrap();
        let decoded_input: RunWatchdogInput = serde_json::from_str(&encoded_input).unwrap();
        assert_eq!(serde_json::to_string(&decoded_input).unwrap(), encoded_input);

        let verdict = evaluate_run_watchdog(&input);
        let encoded_verdict = serde_json::to_string(&verdict).unwrap();
        let decoded_verdict: RunWatchdogVerdict = serde_json::from_str(&encoded_verdict).unwrap();
        assert_eq!(decoded_verdict, verdict);
    }
}

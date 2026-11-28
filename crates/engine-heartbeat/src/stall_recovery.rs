#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StallRecoveryStep {
    SalvageCommittedWork,
    ResumeFromCheckpoint,
    RetryFreshZeroToken,
    EscalateG2Advisor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StallRecoveryInput {
    pub has_uncommitted_valid_changes: bool,
    pub has_valid_checkpoint: bool,
    pub stall_count_for_step: u32,
    pub max_zero_token_stall_retries: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StallRecoveryPlan {
    pub step: StallRecoveryStep,
    pub preserve_worktree: bool,
    pub reason: String,
}

pub fn plan_stall_recovery(input: &StallRecoveryInput) -> StallRecoveryPlan {
    let cap = if input.max_zero_token_stall_retries == 0 {
        2
    } else {
        input.max_zero_token_stall_retries
    };

    if input.has_uncommitted_valid_changes {
        return plan(
            StallRecoveryStep::SalvageCommittedWork,
            true,
            "salvage_written_files_before_cleanup",
        );
    }
    if input.stall_count_for_step >= cap {
        return plan(StallRecoveryStep::EscalateG2Advisor, false, "stall_cap_reached_g2_advisor");
    }
    if input.has_valid_checkpoint {
        return plan(StallRecoveryStep::ResumeFromCheckpoint, true, "resume_valid_checkpoint");
    }
    plan(StallRecoveryStep::RetryFreshZeroToken, false, "fresh_zero_token_retry")
}

fn plan(step: StallRecoveryStep, preserve_worktree: bool, reason: &str) -> StallRecoveryPlan {
    StallRecoveryPlan { step, preserve_worktree, reason: reason.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        has_uncommitted_valid_changes: bool,
        has_valid_checkpoint: bool,
        stall_count_for_step: u32,
        max_zero_token_stall_retries: u32,
    ) -> StallRecoveryInput {
        StallRecoveryInput {
            has_uncommitted_valid_changes,
            has_valid_checkpoint,
            stall_count_for_step,
            max_zero_token_stall_retries,
        }
    }

    #[test]
    fn salvage_takes_precedence_even_at_cap() {
        let plan = plan_stall_recovery(&input(true, true, 9, 2));
        assert_eq!(plan.step, StallRecoveryStep::SalvageCommittedWork);
        assert!(plan.preserve_worktree);
        assert_eq!(plan.reason, "salvage_written_files_before_cleanup");
    }

    #[test]
    fn g2_escalation_at_cap_precedes_checkpoint_resume() {
        let plan = plan_stall_recovery(&input(false, true, 3, 3));
        assert_eq!(plan.step, StallRecoveryStep::EscalateG2Advisor);
        assert!(!plan.preserve_worktree);
        assert_eq!(plan.reason, "stall_cap_reached_g2_advisor");
    }

    #[test]
    fn checkpoint_resumes_below_cap() {
        let plan = plan_stall_recovery(&input(false, true, 1, 3));
        assert_eq!(plan.step, StallRecoveryStep::ResumeFromCheckpoint);
        assert!(plan.preserve_worktree);
        assert_eq!(plan.reason, "resume_valid_checkpoint");
    }

    #[test]
    fn fresh_zero_token_retry_without_checkpoint_below_cap() {
        let plan = plan_stall_recovery(&input(false, false, 1, 3));
        assert_eq!(plan.step, StallRecoveryStep::RetryFreshZeroToken);
        assert!(!plan.preserve_worktree);
        assert_eq!(plan.reason, "fresh_zero_token_retry");
    }

    #[test]
    fn zero_max_retries_uses_default_cap_two() {
        let below_default_cap = plan_stall_recovery(&input(false, false, 1, 0));
        assert_eq!(below_default_cap.step, StallRecoveryStep::RetryFreshZeroToken);
        let at_default_cap = plan_stall_recovery(&input(false, false, 2, 0));
        assert_eq!(at_default_cap.step, StallRecoveryStep::EscalateG2Advisor);
    }

    #[test]
    fn serde_round_trip() {
        for step in [
            StallRecoveryStep::SalvageCommittedWork,
            StallRecoveryStep::ResumeFromCheckpoint,
            StallRecoveryStep::RetryFreshZeroToken,
            StallRecoveryStep::EscalateG2Advisor,
        ] {
            let json = serde_json::to_string(&step).unwrap();
            assert_eq!(serde_json::from_str::<StallRecoveryStep>(&json).unwrap(), step);
        }

        let input = input(true, false, 4, 2);
        let input_json = serde_json::to_string(&input).unwrap();
        let input_back = serde_json::from_str::<StallRecoveryInput>(&input_json).unwrap();
        assert!(input_back.has_uncommitted_valid_changes);
        assert!(!input_back.has_valid_checkpoint);
        assert_eq!(input_back.stall_count_for_step, 4);
        assert_eq!(input_back.max_zero_token_stall_retries, 2);

        let plan = plan_stall_recovery(&input);
        let plan_json = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<StallRecoveryPlan>(&plan_json).unwrap(), plan);
    }

    #[test]
    fn step_names_are_snake_case() {
        assert_eq!(
            serde_json::to_value(StallRecoveryStep::EscalateG2Advisor).unwrap(),
            serde_json::json!("escalate_g2_advisor")
        );
        assert_eq!(
            serde_json::to_value(StallRecoveryStep::RetryFreshZeroToken).unwrap(),
            serde_json::json!("retry_fresh_zero_token")
        );
    }
}

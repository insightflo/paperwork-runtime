use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyUnblockDisposition {
    CancelSuperseded,
    ConvertToZeroTokenBackoff,
    ConvertToStructuredHuddle,
    EscalateToHuman,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyUnblockIssueInput {
    pub issue_id: String,
    pub is_superseded_run: bool,
    pub is_mission_terminal: bool,
    pub is_infra_transient: bool,
    pub huddle_rounds_used: u32,
    pub max_huddle_rounds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnblockMigrationAction {
    pub issue_id: String,
    pub disposition: LegacyUnblockDisposition,
    pub reason: String,
}

pub fn classify_legacy_unblock_issue(input: &LegacyUnblockIssueInput) -> UnblockMigrationAction {
    let cap = if input.max_huddle_rounds == 0 { 2 } else { input.max_huddle_rounds };
    let (disposition, reason) = if input.is_mission_terminal || input.is_superseded_run {
        (LegacyUnblockDisposition::CancelSuperseded, "superseded_or_terminal")
    } else if input.is_infra_transient {
        (
            LegacyUnblockDisposition::ConvertToZeroTokenBackoff,
            "infra_zero_token_backoff",
        )
    } else if input.huddle_rounds_used < cap {
        (
            LegacyUnblockDisposition::ConvertToStructuredHuddle,
            "migrate_to_huddle",
        )
    } else {
        (
            LegacyUnblockDisposition::EscalateToHuman,
            "huddle_budget_exhausted",
        )
    };

    UnblockMigrationAction {
        issue_id: input.issue_id.clone(),
        disposition,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> LegacyUnblockIssueInput {
        LegacyUnblockIssueInput {
            issue_id: "issue-1".to_string(), is_superseded_run: false, is_mission_terminal: false,
            is_infra_transient: false, huddle_rounds_used: 0, max_huddle_rounds: 2,
        }
    }

    fn action_for(configure: impl FnOnce(&mut LegacyUnblockIssueInput)) -> UnblockMigrationAction {
        let mut issue = input();
        configure(&mut issue);
        classify_legacy_unblock_issue(&issue)
    }

    fn assert_action(action: &UnblockMigrationAction, disposition: LegacyUnblockDisposition, reason: &str) {
        assert_eq!(action.issue_id, "issue-1");
        assert_eq!(action.disposition, disposition);
        assert_eq!(action.reason, reason);
    }

    #[test]
    fn cancels_superseded_and_terminal_issues_first() {
        let superseded = action_for(|issue| {
            issue.is_superseded_run = true;
            issue.is_infra_transient = true;
        });
        assert_action(&superseded, LegacyUnblockDisposition::CancelSuperseded, "superseded_or_terminal");

        let terminal = action_for(|issue| issue.is_mission_terminal = true);
        assert_action(&terminal, LegacyUnblockDisposition::CancelSuperseded, "superseded_or_terminal");
    }

    #[test]
    fn converts_infra_transient_issues_to_zero_token_backoff() {
        let action = action_for(|issue| {
            issue.is_infra_transient = true;
            issue.huddle_rounds_used = 99;
        });
        assert_action(&action, LegacyUnblockDisposition::ConvertToZeroTokenBackoff, "infra_zero_token_backoff");
    }

    #[test]
    fn converts_issues_below_huddle_cap_to_structured_huddle() {
        let action = action_for(|issue| {
            issue.huddle_rounds_used = 1;
            issue.max_huddle_rounds = 3;
        });
        assert_action(&action, LegacyUnblockDisposition::ConvertToStructuredHuddle, "migrate_to_huddle");
    }

    #[test]
    fn escalates_to_human_at_huddle_cap() {
        let action = action_for(|issue| issue.huddle_rounds_used = 2);
        assert_action(&action, LegacyUnblockDisposition::EscalateToHuman, "huddle_budget_exhausted");
    }

    #[test]
    fn uses_default_huddle_cap_of_two_when_max_is_zero() {
        let below_cap = action_for(|issue| {
            issue.huddle_rounds_used = 1;
            issue.max_huddle_rounds = 0;
        });
        assert_eq!(below_cap.disposition, LegacyUnblockDisposition::ConvertToStructuredHuddle);

        let at_cap = action_for(|issue| {
            issue.huddle_rounds_used = 2;
            issue.max_huddle_rounds = 0;
        });
        assert_eq!(at_cap.disposition, LegacyUnblockDisposition::EscalateToHuman);
    }

    #[test]
    fn serde_round_trips_contracts() {
        let mut issue = input();
        issue.issue_id = "issue-serde".to_string();
        issue.huddle_rounds_used = 1;
        let json = serde_json::to_string(&issue).expect("serialize input");
        let decoded: LegacyUnblockIssueInput = serde_json::from_str(&json).expect("deserialize input");
        assert_eq!(decoded.issue_id, issue.issue_id);
        assert_eq!(decoded.huddle_rounds_used, issue.huddle_rounds_used);
        assert_eq!(decoded.max_huddle_rounds, issue.max_huddle_rounds);

        let action = classify_legacy_unblock_issue(&issue);
        let json = serde_json::to_string(&action).expect("serialize action");
        let decoded: UnblockMigrationAction = serde_json::from_str(&json).expect("deserialize action");
        assert_eq!(decoded, action);
        assert_eq!(
            serde_json::to_value(LegacyUnblockDisposition::ConvertToStructuredHuddle).expect("serialize disposition"),
            serde_json::json!("convert_to_structured_huddle")
        );
    }
}

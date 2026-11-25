#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuleSeverity {
    Must,
    Should,
    May,
}

impl RuleSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuleSeverity::Must => "MUST",
            RuleSeverity::Should => "SHOULD",
            RuleSeverity::May => "MAY",
        }
    }

    pub fn parse(raw: &str) -> Result<RuleSeverity, WorktreeRuleDbError> {
        match raw {
            "MUST" => Ok(RuleSeverity::Must),
            "SHOULD" => Ok(RuleSeverity::Should),
            "MAY" => Ok(RuleSeverity::May),
            _ => Err(WorktreeRuleDbError::InvalidSeverity(raw.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    ToolCall,
    FileRead,
    FileWrite,
    FileDelete,
    NetworkRequest,
    CommandExecution,
    StateQuery,
}

impl RuleAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuleAction::ToolCall => "tool_call",
            RuleAction::FileRead => "file_read",
            RuleAction::FileWrite => "file_write",
            RuleAction::FileDelete => "file_delete",
            RuleAction::NetworkRequest => "network_request",
            RuleAction::CommandExecution => "command_execution",
            RuleAction::StateQuery => "state_query",
        }
    }

    pub fn parse(raw: &str) -> Result<RuleAction, WorktreeRuleDbError> {
        match raw {
            "tool_call" => Ok(RuleAction::ToolCall),
            "file_read" => Ok(RuleAction::FileRead),
            "file_write" => Ok(RuleAction::FileWrite),
            "file_delete" => Ok(RuleAction::FileDelete),
            "network_request" => Ok(RuleAction::NetworkRequest),
            "command_execution" => Ok(RuleAction::CommandExecution),
            "state_query" => Ok(RuleAction::StateQuery),
            _ => Err(WorktreeRuleDbError::InvalidAction(raw.to_string())),
        }
    }
}

#[derive(Debug)]
pub enum WorktreeRuleDbError {
    InvalidSeverity(String),
    InvalidAction(String),
    InvalidName,
    InvalidCreatedBy,
    InvalidVersion,
    NotFound,
    VersionConflict { expected: i32, actual: i32 },
    Pg(postgres::Error),
}

impl fmt::Display for WorktreeRuleDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorktreeRuleDbError::InvalidSeverity(raw) => {
                write!(f, "invalid worktree rule severity: {raw}")
            }
            WorktreeRuleDbError::InvalidAction(raw) => {
                write!(f, "invalid worktree rule action: {raw}")
            }
            WorktreeRuleDbError::InvalidName => write!(f, "worktree rule name must not be empty"),
            WorktreeRuleDbError::InvalidCreatedBy => {
                write!(f, "worktree rule created_by must not be empty")
            }
            WorktreeRuleDbError::InvalidVersion => {
                write!(f, "worktree rule expected version must be at least 1")
            }
            WorktreeRuleDbError::NotFound => write!(f, "worktree rule not found"),
            WorktreeRuleDbError::VersionConflict { expected, actual } => write!(
                f,
                "worktree rule version conflict: expected={expected}, actual={actual}"
            ),
            WorktreeRuleDbError::Pg(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for WorktreeRuleDbError {}

impl From<postgres::Error> for WorktreeRuleDbError {
    fn from(err: postgres::Error) -> Self {
        WorktreeRuleDbError::Pg(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEVERITIES: [RuleSeverity; 3] = [
        RuleSeverity::Must,
        RuleSeverity::Should,
        RuleSeverity::May,
    ];
    const ACTIONS: [RuleAction; 7] = [
        RuleAction::ToolCall,
        RuleAction::FileRead,
        RuleAction::FileWrite,
        RuleAction::FileDelete,
        RuleAction::NetworkRequest,
        RuleAction::CommandExecution,
        RuleAction::StateQuery,
    ];

    #[test]
    fn severity_parse_and_serde_roundtrip() {
        for severity in SEVERITIES {
            let json = serde_json::to_value(severity).unwrap();
            assert_eq!(json, serde_json::json!(severity.as_str()));
            assert_eq!(serde_json::from_value::<RuleSeverity>(json).unwrap(), severity);
            assert_eq!(RuleSeverity::parse(severity.as_str()).unwrap(), severity);
        }
        assert_eq!(RuleSeverity::Must.as_str(), "MUST");
        assert_eq!(RuleSeverity::Should.as_str(), "SHOULD");
        assert_eq!(RuleSeverity::May.as_str(), "MAY");
    }

    #[test]
    fn action_parse_and_serde_roundtrip() {
        for action in ACTIONS {
            let json = serde_json::to_value(action).unwrap();
            assert_eq!(json, serde_json::json!(action.as_str()));
            assert_eq!(serde_json::from_value::<RuleAction>(json).unwrap(), action);
            assert_eq!(RuleAction::parse(action.as_str()).unwrap(), action);
        }
        assert_eq!(RuleAction::ToolCall.as_str(), "tool_call");
        assert_eq!(RuleAction::StateQuery.as_str(), "state_query");
    }

    #[test]
    fn parse_rejects_unknown_and_untrimmed_strings() {
        for raw in ["must", "Must", "MUST ", "", "sometimes"] {
            assert!(matches!(
                RuleSeverity::parse(raw),
                Err(WorktreeRuleDbError::InvalidSeverity(got)) if got == raw
            ));
        }
        for raw in ["tool_call ", "ToolCall", "file-read", "", "shell_exec"] {
            assert!(matches!(
                RuleAction::parse(raw),
                Err(WorktreeRuleDbError::InvalidAction(got)) if got == raw
            ));
        }
    }

    #[test]
    fn error_display_covers_every_non_pg_variant() {
        assert!(WorktreeRuleDbError::InvalidSeverity("x".to_string())
            .to_string()
            .contains('x'));
        assert!(WorktreeRuleDbError::InvalidAction("y".to_string())
            .to_string()
            .contains('y'));
        assert!(!WorktreeRuleDbError::InvalidName.to_string().is_empty());
        assert!(!WorktreeRuleDbError::InvalidCreatedBy.to_string().is_empty());
        assert!(!WorktreeRuleDbError::InvalidVersion.to_string().is_empty());
        assert!(!WorktreeRuleDbError::NotFound.to_string().is_empty());
        let conflict = WorktreeRuleDbError::VersionConflict { expected: 2, actual: 3 };
        let rendered = conflict.to_string();
        assert!(rendered.contains("expected=2"));
        assert!(rendered.contains("actual=3"));
        let as_error: &dyn std::error::Error = &conflict;
        assert!(as_error.source().is_none());
    }

    fn create_input(name: &str, created_by: &str) -> CreateWorktreeRuleInput {
        CreateWorktreeRuleInput {
            company_id: uuid::Uuid::new_v4(),
            name: name.to_string(),
            severity: RuleSeverity::Must,
            action: RuleAction::ToolCall,
            predicate: serde_json::json!({}),
            decision_map: serde_json::json!({}),
            message: "message".to_string(),
            enabled: true,
            created_by: created_by.to_string(),
        }
    }

    #[test]
    fn create_input_validation_rejects_empty_required_strings() {
        assert!(create_input("rule", "creator").validate().is_ok());
        assert!(matches!(
            create_input("   ", "creator").validate(),
            Err(WorktreeRuleDbError::InvalidName)
        ));
        assert!(matches!(
            create_input("rule", "\t").validate(),
            Err(WorktreeRuleDbError::InvalidCreatedBy)
        ));
    }

    #[test]
    fn update_input_validation_rejects_empty_optional_name() {
        let valid = UpdateWorktreeRuleInput {
            name: Some("rule".to_string()),
            severity: None,
            action: None,
            predicate: None,
            decision_map: None,
            message: None,
        };
        assert!(valid.validate().is_ok());
        let invalid = UpdateWorktreeRuleInput {
            name: Some("  ".to_string()),
            ..valid
        };
        assert!(matches!(
            invalid.validate(),
            Err(WorktreeRuleDbError::InvalidName)
        ));
    }
}

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    RevisionRequested,
    Approved,
    Rejected,
    Cancelled,
}

const ALL_STATUSES: [ApprovalStatus; 5] = [
    ApprovalStatus::Pending,
    ApprovalStatus::RevisionRequested,
    ApprovalStatus::Approved,
    ApprovalStatus::Rejected,
    ApprovalStatus::Cancelled,
];

const STATUS_NAMES: [&str; 5] = [
    "pending",
    "revision_requested",
    "approved",
    "rejected",
    "cancelled",
];

impl ApprovalStatus {
    pub fn as_str(&self) -> &'static str {
        STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<ApprovalStatus, ApprovalDbError> {
        ALL_STATUSES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| ApprovalDbError::InvalidStatus(raw.to_string()))
    }

    pub fn is_resolvable(&self) -> bool {
        matches!(
            self,
            ApprovalStatus::Pending | ApprovalStatus::RevisionRequested
        )
    }

    pub fn is_terminal(&self) -> bool {
        !self.is_resolvable()
    }
}

#[derive(Debug)]
pub enum ApprovalDbError {
    InvalidStatus(String),
    InvalidTransition {
        from: ApprovalStatus,
        to: ApprovalStatus,
    },
    EmptyDecisionActor,
    Db(postgres::Error),
}

impl fmt::Display for ApprovalDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApprovalDbError::InvalidStatus(raw) => write!(f, "invalid approval status: {raw}"),
            ApprovalDbError::InvalidTransition { from, to } => write!(
                f,
                "illegal approval status transition: {} -> {}",
                from.as_str(),
                to.as_str()
            ),
            ApprovalDbError::EmptyDecisionActor => write!(f, "empty decided_by_user_id"),
            ApprovalDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for ApprovalDbError {}

impl From<postgres::Error> for ApprovalDbError {
    fn from(err: postgres::Error) -> Self {
        ApprovalDbError::Db(err)
    }
}

pub fn validate_approval_transition(
    from: ApprovalStatus,
    to: ApprovalStatus,
) -> Result<(), ApprovalDbError> {
    let legal = match from {
        ApprovalStatus::Pending => matches!(
            to,
            ApprovalStatus::Approved
                | ApprovalStatus::Rejected
                | ApprovalStatus::RevisionRequested
                | ApprovalStatus::Cancelled
        ),
        ApprovalStatus::RevisionRequested => matches!(
            to,
            ApprovalStatus::Approved
                | ApprovalStatus::Rejected
                | ApprovalStatus::Pending
                | ApprovalStatus::Cancelled
        ),
        _ => false,
    };
    if !legal {
        return Err(ApprovalDbError::InvalidTransition { from, to });
    }
    Ok(())
}

#[derive(Debug)]
pub enum ResolutionOutcome {
    Applied(ApprovalRow),
    AlreadyInTargetState(ApprovalRow),
    NotFoundOrConflict,
}

#[cfg(test)]
mod tests {
    use super::ApprovalStatus::*;
    use super::*;

    const LEGAL: &[(ApprovalStatus, ApprovalStatus)] = &[
        (Pending, Approved),
        (Pending, Rejected),
        (Pending, RevisionRequested),
        (Pending, Cancelled),
        (RevisionRequested, Approved),
        (RevisionRequested, Rejected),
        (RevisionRequested, Pending),
        (RevisionRequested, Cancelled),
    ];

    #[test]
    fn legal_transition_matrix() {
        for from in ALL_STATUSES {
            for to in ALL_STATUSES {
                assert_eq!(
                    validate_approval_transition(from, to).is_ok(),
                    LEGAL.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn invalid_transition_reports_from_to() {
        assert!(matches!(
            validate_approval_transition(Approved, Pending),
            Err(ApprovalDbError::InvalidTransition {
                from: Approved,
                to: Pending
            })
        ));
        assert!(matches!(
            validate_approval_transition(Cancelled, Rejected),
            Err(ApprovalDbError::InvalidTransition {
                from: Cancelled,
                to: Rejected
            })
        ));
    }

    #[test]
    fn status_parse_and_serde_roundtrip() {
        for status in ALL_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(
                serde_json::from_value::<ApprovalStatus>(json).unwrap(),
                status
            );
            assert_eq!(ApprovalStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(matches!(
            ApprovalStatus::parse("done"),
            Err(ApprovalDbError::InvalidStatus(raw)) if raw == "done"
        ));
        assert!(Pending.is_resolvable() && RevisionRequested.is_resolvable());
        assert!(!Pending.is_terminal() && !RevisionRequested.is_terminal());
        assert!(Approved.is_terminal() && Rejected.is_terminal() && Cancelled.is_terminal());
        assert!(!Approved.is_resolvable() && !Rejected.is_resolvable() && !Cancelled.is_resolvable());
    }

    #[test]
    fn sql_constants_are_parameterized_and_company_scoped() {
        for sql in [
            SQL_GET_APPROVAL_BY_ID,
            SQL_LIST_APPROVALS_BY_COMPANY,
            SQL_CREATE_APPROVAL,
            SQL_RESOLVE_APPROVAL_FENCED,
            SQL_REQUEST_REVISION_FENCED,
            SQL_RESUBMIT_APPROVAL_FENCED,
            SQL_CANCEL_APPROVAL_FENCED,
        ] {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in [
            SQL_GET_APPROVAL_BY_ID,
            SQL_LIST_APPROVALS_BY_COMPANY,
            SQL_RESOLVE_APPROVAL_FENCED,
            SQL_REQUEST_REVISION_FENCED,
            SQL_RESUBMIT_APPROVAL_FENCED,
            SQL_CANCEL_APPROVAL_FENCED,
        ] {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
        assert!(
            SQL_RESOLVE_APPROVAL_FENCED.contains("status IN ('pending', 'revision_requested')")
        );
        assert!(SQL_RESOLVE_APPROVAL_FENCED.contains("decided_at = now()"));
        assert!(SQL_REQUEST_REVISION_FENCED.contains("status = 'pending'"));
        assert!(SQL_REQUEST_REVISION_FENCED.contains("'revision_requested'"));
        assert!(SQL_RESUBMIT_APPROVAL_FENCED.contains("status = 'revision_requested'"));
        assert!(SQL_RESUBMIT_APPROVAL_FENCED.contains("decided_by_user_id = NULL"));
        assert!(
            SQL_CANCEL_APPROVAL_FENCED.contains("status IN ('pending', 'revision_requested')")
        );
        assert!(SQL_CREATE_APPROVAL.contains("'pending'"));
        for sql in [
            SQL_GET_APPROVAL_BY_ID,
            SQL_RESOLVE_APPROVAL_FENCED,
            SQL_REQUEST_REVISION_FENCED,
            SQL_RESUBMIT_APPROVAL_FENCED,
            SQL_CANCEL_APPROVAL_FENCED,
        ] {
            assert!(sql.contains("decided_by_user_id"), "{sql}");
        }
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(-9), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(10_000), 200);
    }
}

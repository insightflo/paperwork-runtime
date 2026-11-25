#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    Blocked,
    Cancelled,
}

const ALL_STATUSES: [IssueStatus; 7] = [
    IssueStatus::Backlog,
    IssueStatus::Todo,
    IssueStatus::InProgress,
    IssueStatus::InReview,
    IssueStatus::Done,
    IssueStatus::Blocked,
    IssueStatus::Cancelled,
];

const STATUS_NAMES: [&str; 7] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
];

impl IssueStatus {
    pub fn as_str(&self) -> &'static str {
        STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<IssueStatus, IssueDbError> {
        ALL_STATUSES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| IssueDbError::InvalidStatus(raw.to_string()))
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, IssueStatus::Done | IssueStatus::Cancelled)
    }
}

impl FromStr for IssueStatus {
    type Err = IssueDbError;

    fn from_str(raw: &str) -> Result<IssueStatus, IssueDbError> {
        IssueStatus::parse(raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssuePriority {
    Critical,
    High,
    Medium,
    Low,
}

const ALL_PRIORITIES: [IssuePriority; 4] = [
    IssuePriority::Critical,
    IssuePriority::High,
    IssuePriority::Medium,
    IssuePriority::Low,
];

const PRIORITY_NAMES: [&str; 4] = ["critical", "high", "medium", "low"];

impl IssuePriority {
    pub fn as_str(&self) -> &'static str {
        PRIORITY_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<IssuePriority, IssueDbError> {
        ALL_PRIORITIES
            .into_iter()
            .find(|p| p.as_str() == raw)
            .ok_or_else(|| IssueDbError::InvalidPriority(raw.to_string()))
    }
}

impl FromStr for IssuePriority {
    type Err = IssueDbError;

    fn from_str(raw: &str) -> Result<IssuePriority, IssueDbError> {
        IssuePriority::parse(raw)
    }
}

#[derive(Debug)]
pub enum IssueDbError {
    NotFound,
    CompanyMismatch,
    InvalidStatus(String),
    InvalidPriority(String),
    Fenced,
    UndecodableRow(&'static str),
    Db(postgres::Error),
}

impl fmt::Display for IssueDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IssueDbError::NotFound => write!(f, "issue not found"),
            IssueDbError::CompanyMismatch => write!(f, "issue belongs to a different company"),
            IssueDbError::InvalidStatus(raw) => write!(f, "invalid issue status: {raw}"),
            IssueDbError::InvalidPriority(raw) => write!(f, "invalid issue priority: {raw}"),
            IssueDbError::Fenced => write!(f, "issue fencing conflict"),
            IssueDbError::UndecodableRow(col) => write!(f, "undecodable issue column: {col}"),
            IssueDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for IssueDbError {}

impl From<postgres::Error> for IssueDbError {
    fn from(err: postgres::Error) -> Self {
        IssueDbError::Db(err)
    }
}

#[cfg(test)]
mod tests {
    use super::IssuePriority::*;
    use super::IssueStatus::*;
    use super::*;

    #[test]
    fn status_parse_and_serde_roundtrip() {
        for status in ALL_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<IssueStatus>(json).unwrap(), status);
            assert_eq!(IssueStatus::parse(status.as_str()).unwrap(), status);
            assert_eq!(status.as_str().parse::<IssueStatus>().unwrap(), status);
        }
        assert!(matches!(
            IssueStatus::parse("archived"),
            Err(IssueDbError::InvalidStatus(raw)) if raw == "archived"
        ));
        assert!(Done.is_terminal() && Cancelled.is_terminal());
        assert!(!Backlog.is_terminal() && !InProgress.is_terminal() && !Blocked.is_terminal());
    }

    #[test]
    fn priority_parse_and_serde_roundtrip() {
        for priority in ALL_PRIORITIES {
            let json = serde_json::to_value(priority).unwrap();
            assert_eq!(json, serde_json::json!(priority.as_str()));
            assert_eq!(serde_json::from_value::<IssuePriority>(json).unwrap(), priority);
            assert_eq!(priority.as_str().parse::<IssuePriority>().unwrap(), priority);
        }
        assert!(matches!(
            IssuePriority::parse("urgent"),
            Err(IssueDbError::InvalidPriority(raw)) if raw == "urgent"
        ));
    }

    #[test]
    fn error_display_is_distinct_per_variant() {
        let msgs = [
            IssueDbError::NotFound.to_string(),
            IssueDbError::CompanyMismatch.to_string(),
            IssueDbError::InvalidStatus("x".to_string()).to_string(),
            IssueDbError::InvalidPriority("x".to_string()).to_string(),
            IssueDbError::Fenced.to_string(),
            IssueDbError::UndecodableRow("status").to_string(),
        ];
        for (i, a) in msgs.iter().enumerate() {
            for b in msgs.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
        assert!(IssueDbError::InvalidStatus("bogus".to_string()).to_string().contains("bogus"));
        assert!(IssueDbError::UndecodableRow("title").to_string().contains("title"));
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_issue_fencing_and_transitions() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = c.transaction().unwrap();
        let (ca, cb) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let (ga, gb) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let (run1, run2) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        for (cid, prefix) in [(ca, format!("P{ca}")), (cb, format!("P{cb}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix]).unwrap();
        }
        for (aid, cid) in [(ga, ca), (gb, cb)] {
            tx.execute("INSERT INTO agents (id,company_id,name) VALUES ($1,$2,'x')", &[&aid, &cid]).unwrap();
        }
        let issue_id = uuid::Uuid::new_v4();
        tx.execute(
            "INSERT INTO issues (id, company_id, title, status, priority) VALUES ($1,$2,'t','todo','high')",
            &[&issue_id, &ca],
        )
        .unwrap();

        assert!(matches!(
            get_issue(&mut tx, cb, issue_id),
            Err(IssueDbError::CompanyMismatch)
        ));
        let got = get_issue(&mut tx, ca, issue_id).unwrap();
        assert_eq!(got.status, Todo);
        assert_eq!(got.priority, High);

        let mut checkout = |cid: uuid::Uuid, aid: uuid::Uuid, run: uuid::Uuid, statuses: &[IssueStatus]| {
            checkout_issue_fenced(&mut tx, cid, issue_id, aid, run, Some("x"), statuses)
        };
        assert!(matches!(checkout(cb, gb, run1, &[Todo]), Err(IssueDbError::CompanyMismatch)));
        assert!(matches!(checkout(ca, gb, run1, &[Todo]), Err(IssueDbError::Fenced)));
        assert!(matches!(checkout(ca, ga, run1, &[Done]), Err(IssueDbError::Fenced)));
        assert!(matches!(checkout(ca, ga, run1, &[]), Err(IssueDbError::Fenced)));
        let locked = checkout(ca, ga, run1, &[Todo]).unwrap();
        assert_eq!(locked.status, InProgress);
        assert_eq!(locked.checkout_run_id, Some(run1));
        assert_eq!(locked.execution_run_id, Some(run1));
        assert!(locked.started_at.is_some() && locked.execution_locked_at.is_some());
        // Same row is now fenced for other runs and other agents.
        assert!(matches!(checkout(ca, ga, run2, &[InProgress]), Err(IssueDbError::Fenced)));
        assert!(matches!(checkout(ca, gb, run1, &[InProgress]), Err(IssueDbError::Fenced)));
        // Re-checkout by the owning run is idempotent.
        checkout(ca, ga, run1, &[InProgress]).unwrap();

        assert!(matches!(
            release_issue_checkout_fenced(&mut tx, ca, issue_id, run2),
            Err(IssueDbError::Fenced)
        ));
        let released = release_issue_checkout_fenced(&mut tx, ca, issue_id, run1).unwrap();
        assert_eq!(released.checkout_run_id, None);
        assert_eq!(released.execution_run_id, None);
        assert_eq!(released.execution_locked_at, None);

        assert!(matches!(
            transition_issue_status_fenced(&mut tx, ca, issue_id, Todo, InReview),
            Err(IssueDbError::Fenced)
        ));
        let reviewed =
            transition_issue_status_fenced(&mut tx, ca, issue_id, InProgress, InReview).unwrap();
        assert_eq!(reviewed.status, InReview);
        assert_eq!(reviewed.checkout_run_id, None);
        assert_eq!(reviewed.execution_run_id, None);
        assert!(matches!(
            transition_issue_status_fenced(&mut tx, cb, issue_id, InReview, Done),
            Err(IssueDbError::CompanyMismatch)
        ));
        let done = transition_issue_status_fenced(&mut tx, ca, issue_id, InReview, Done).unwrap();
        assert_eq!(done.status, Done);
        assert!(done.completed_at.is_some());
        let reopened = transition_issue_status_fenced(&mut tx, ca, issue_id, Done, Todo).unwrap();
        assert_eq!(reopened.completed_at, None);

        assert!(list_issues_by_company(&mut tx, ca, 50).unwrap().iter().any(|i| i.id == issue_id));
        assert!(list_issue_work_products(&mut tx, ca, issue_id).unwrap().is_empty());
        tx.rollback().unwrap();
    }
}

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    Planning,
    Active,
    Completed,
    Cancelled,
    Paused,
}

const ALL_STATUSES: [MissionStatus; 5] = [
    MissionStatus::Planning,
    MissionStatus::Active,
    MissionStatus::Completed,
    MissionStatus::Cancelled,
    MissionStatus::Paused,
];

const STATUS_NAMES: [&str; 5] = ["planning", "active", "completed", "cancelled", "paused"];

impl MissionStatus {
    pub fn as_str(&self) -> &'static str {
        STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<MissionStatus, MissionDbError> {
        ALL_STATUSES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| MissionDbError::InvalidStatus(raw.to_string()))
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, MissionStatus::Completed | MissionStatus::Cancelled)
    }
}

#[derive(Debug)]
pub enum MissionDbError {
    InvalidStatus(String),
    InvalidTransition {
        from: MissionStatus,
        to: MissionStatus,
    },
    InvalidRevision(i32),
    Db(postgres::Error),
}

impl fmt::Display for MissionDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MissionDbError::InvalidStatus(raw) => write!(f, "invalid mission status: {raw}"),
            MissionDbError::InvalidTransition { from, to } => write!(
                f,
                "illegal mission status transition: {} -> {}",
                from.as_str(),
                to.as_str()
            ),
            MissionDbError::InvalidRevision(rev) => {
                write!(f, "invalid rolling-state revision: {rev}")
            }
            MissionDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for MissionDbError {}

impl From<postgres::Error> for MissionDbError {
    fn from(err: postgres::Error) -> Self {
        MissionDbError::Db(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionPlan {
    pub sets_started_at: bool,
    pub sets_completed_at: bool,
}

pub fn mission_transition_plan(next: MissionStatus) -> TransitionPlan {
    TransitionPlan {
        sets_started_at: next == MissionStatus::Active,
        sets_completed_at: next.is_terminal(),
    }
}

pub fn validate_mission_transition(
    expected_status: MissionStatus,
    next_status: MissionStatus,
) -> Result<(), MissionDbError> {
    if expected_status == next_status {
        return Err(MissionDbError::InvalidTransition {
            from: expected_status,
            to: next_status,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MissionStatus::*;
    use super::*;

    #[test]
    fn transition_plan_flags_for_all_statuses() {
        for (status, started, completed) in [
            (Planning, false, false),
            (Active, true, false),
            (Completed, false, true),
            (Cancelled, false, true),
            (Paused, false, false),
        ] {
            assert_eq!(
                mission_transition_plan(status),
                TransitionPlan {
                    sets_started_at: started,
                    sets_completed_at: completed
                },
                "{status:?}"
            );
        }
    }

    #[test]
    fn status_parse_and_serde_roundtrip() {
        for status in ALL_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(
                serde_json::from_value::<MissionStatus>(json).unwrap(),
                status
            );
            assert_eq!(MissionStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(matches!(
            MissionStatus::parse("done"),
            Err(MissionDbError::InvalidStatus(raw)) if raw == "done"
        ));
        assert!(Completed.is_terminal() && Cancelled.is_terminal());
        assert!(!Planning.is_terminal() && !Active.is_terminal() && !Paused.is_terminal());
    }

    #[test]
    fn same_status_rejected_distinct_pairs_accepted() {
        for from in ALL_STATUSES {
            for to in ALL_STATUSES {
                let result = validate_mission_transition(from, to);
                if from == to {
                    assert!(matches!(
                        result,
                        Err(MissionDbError::InvalidTransition { from: f, to: t })
                            if f == from && t == to
                    ));
                } else {
                    assert!(result.is_ok(), "{from:?} -> {to:?}");
                }
            }
        }
    }

    #[test]
    fn sql_constants_are_parameterized_and_company_scoped() {
        for sql in [
            SQL_GET_MISSION,
            SQL_LIST_MISSIONS_BY_COMPANY,
            SQL_TRANSITION_MISSION_STATUS_FENCED,
            SQL_GET_MISSION_ROLLING_STATE,
            SQL_BUMP_MISSION_ROLLING_STATE_FENCED,
            SQL_LIST_MISSION_SESSIONS,
        ] {
            assert!(sql.contains("company_id = $"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(-9), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(10_000), 200);
    }

    #[test]
    fn bump_revision_validation() {
        assert!(matches!(
            validate_bump_revision(0),
            Err(MissionDbError::InvalidRevision(0))
        ));
        assert!(matches!(
            validate_bump_revision(-1),
            Err(MissionDbError::InvalidRevision(-1))
        ));
        assert_eq!(validate_bump_revision(1).unwrap(), 1);
        assert_eq!(validate_bump_revision(i32::MAX).unwrap(), i32::MAX);
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_fencing() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (a, b, ga, m) = (
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
        );
        let mut tx = c.transaction().unwrap();
        for (cid, prefix) in [(a, format!("P{a}")), (b, format!("P{b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix]).unwrap();
        }
        tx.execute("INSERT INTO agents (id,company_id,name) VALUES ($1,$2,'x')", &[&ga, &a]).unwrap();
        tx.execute("INSERT INTO missions (id,company_id,owner_agent_id,title) VALUES ($1,$2,$3,'m')", &[&m, &a, &ga]).unwrap();
        tx.execute("INSERT INTO mission_rolling_state (company_id,mission_id) VALUES ($1,$2)", &[&a, &m]).unwrap();
        let input = |expected_status: MissionStatus, next_status: MissionStatus, company_id| {
            TransitionMissionInput { mission_id: m, company_id, expected_status, next_status }
        };
        let applied = transition_mission_status_fenced(&mut tx, &input(Planning, Active, a)).unwrap().expect("planning->active must apply");
        assert_eq!(applied.status, Active);
        assert!(applied.started_at.is_some());
        assert!(transition_mission_status_fenced(&mut tx, &input(Planning, Paused, a)).unwrap().is_none());
        assert!(transition_mission_status_fenced(&mut tx, &input(Active, Paused, b)).unwrap().is_none());
        let bump = |expected_revision: i32| BumpRollingStateInput {
            mission_id: m, company_id: a, expected_revision,
            state_json: serde_json::json!({}), state_markdown: "s".to_string(),
        };
        assert!(bump_mission_rolling_state_fenced(&mut tx, &bump(99)).unwrap().is_none());
        assert_eq!(bump_mission_rolling_state_fenced(&mut tx, &bump(1)).unwrap().map(|r| r.revision), Some(2));
        tx.rollback().unwrap();
    }
}

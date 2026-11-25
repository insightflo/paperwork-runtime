#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::Transaction;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

#[derive(Debug)]
pub enum ScheduleDbError {
    InvalidAdvanceWindow { last_run_at: DateTime<Utc>, next_run_at: DateTime<Utc> },
    Db(postgres::Error),
}

impl fmt::Display for ScheduleDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScheduleDbError::InvalidAdvanceWindow { last_run_at, next_run_at } => write!(
                f,
                "invalid advance window: next_run_at {next_run_at} is not after last_run_at {last_run_at}"
            ),
            ScheduleDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for ScheduleDbError {}

impl From<postgres::Error> for ScheduleDbError {
    fn from(err: postgres::Error) -> Self {
        ScheduleDbError::Db(err)
    }
}

pub fn clamp_due_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn validate_advance_window(
    last_run_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
) -> Result<(), ScheduleDbError> {
    if next_run_at <= last_run_at {
        return Err(ScheduleDbError::InvalidAdvanceWindow { last_run_at, next_run_at });
    }
    Ok(())
}

pub const SQL_LIST_DUE_SCHEDULES: &str = "SELECT id, company_id, agent_id, cron_expression, timezone, mission_id, enabled, last_run_at, next_run_at FROM schedules WHERE company_id = $1 AND enabled = true AND next_run_at IS NOT NULL AND next_run_at <= $2 ORDER BY next_run_at ASC, id ASC LIMIT $3 FOR UPDATE SKIP LOCKED";
pub const SQL_ADVANCE_SCHEDULE_FENCED: &str = "UPDATE schedules SET last_run_at = $2, next_run_at = $3, updated_at = now() WHERE id = $1 AND company_id = $4 AND enabled = true AND next_run_at IS NOT DISTINCT FROM $5 RETURNING id, company_id, agent_id, last_run_at, next_run_at, updated_at";
pub const SQL_SET_SCHEDULE_ENABLED: &str = "UPDATE schedules SET enabled = $2, updated_at = now() WHERE id = $1 AND company_id = $3 RETURNING id, enabled, updated_at";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DueSchedule {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub cron_expression: String,
    pub timezone: String,
    pub mission_id: Option<Uuid>,
    pub enabled: bool,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
}

pub fn list_due_schedules_skip_locked(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    due_before: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<DueSchedule>, ScheduleDbError> {
    let rows = tx.query(
        SQL_LIST_DUE_SCHEDULES,
        &[&company_id, &due_before, &clamp_due_limit(limit)],
    )?;
    Ok(rows
        .iter()
        .map(|row| DueSchedule {
            id: row.get(0),
            company_id: row.get(1),
            agent_id: row.get(2),
            cron_expression: row.get(3),
            timezone: row.get(4),
            mission_id: row.get(5),
            enabled: row.get(6),
            last_run_at: row.get(7),
            next_run_at: row.get(8),
        })
        .collect())
}

#[derive(Debug)]
pub struct AdvanceScheduleInput {
    pub schedule_id: Uuid,
    pub company_id: Uuid,
    pub last_run_at: DateTime<Utc>,
    pub next_run_at: DateTime<Utc>,
    pub expected_next_run_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdvancedSchedule {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FencedAdvanceResult {
    Applied(AdvancedSchedule),
    Discarded,
}

pub fn advance_schedule_fenced(
    tx: &mut Transaction<'_>,
    input: &AdvanceScheduleInput,
) -> Result<FencedAdvanceResult, ScheduleDbError> {
    validate_advance_window(input.last_run_at, input.next_run_at)?;
    let updated = tx.query_opt(
        SQL_ADVANCE_SCHEDULE_FENCED,
        &[
            &input.schedule_id,
            &input.last_run_at,
            &input.next_run_at,
            &input.company_id,
            &input.expected_next_run_at,
        ],
    )?;
    let Some(row) = updated else {
        return Ok(FencedAdvanceResult::Discarded);
    };
    Ok(FencedAdvanceResult::Applied(AdvancedSchedule {
        id: row.get(0),
        company_id: row.get(1),
        agent_id: row.get(2),
        last_run_at: row.get(3),
        next_run_at: row.get(4),
        updated_at: row.get(5),
    }))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleToggleResult {
    pub id: Uuid,
    pub enabled: bool,
    pub updated_at: DateTime<Utc>,
}

pub fn set_schedule_enabled(
    tx: &mut Transaction<'_>,
    schedule_id: Uuid,
    company_id: Uuid,
    enabled: bool,
) -> Result<Option<ScheduleToggleResult>, ScheduleDbError> {
    let row = tx.query_opt(SQL_SET_SCHEDULE_ENABLED, &[&schedule_id, &enabled, &company_id])?;
    Ok(row.map(|row| ScheduleToggleResult {
        id: row.get(0),
        enabled: row.get(1),
        updated_at: row.get(2),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).unwrap()
    }

    #[test]
    fn due_limit_is_clamped() {
        assert_eq!(clamp_due_limit(0), 1);
        assert_eq!(clamp_due_limit(-9), 1);
        assert_eq!(clamp_due_limit(1), 1);
        assert_eq!(clamp_due_limit(200), 200);
        assert_eq!(clamp_due_limit(10_000), 200);
    }

    #[test]
    fn advance_window_rejects_non_forward() {
        let t = ts(1_700_000_000);
        assert!(matches!(
            validate_advance_window(t, t),
            Err(ScheduleDbError::InvalidAdvanceWindow { .. })
        ));
        assert!(matches!(
            validate_advance_window(t, ts(1_699_999_999)),
            Err(ScheduleDbError::InvalidAdvanceWindow { .. })
        ));
        assert!(validate_advance_window(t, ts(1_700_000_001)).is_ok());
    }

    #[test]
    fn error_display_mentions_window() {
        let err = ScheduleDbError::InvalidAdvanceWindow {
            last_run_at: ts(1_700_000_000),
            next_run_at: ts(1_699_999_999),
        };
        let msg = err.to_string();
        assert!(msg.contains("invalid advance window"));
        assert!(msg.contains("last_run_at"));
    }

    #[test]
    fn structs_serde_roundtrip() {
        let due = DueSchedule {
            id: Uuid::nil(),
            company_id: Uuid::nil(),
            agent_id: Uuid::nil(),
            cron_expression: "*/5 * * * *".into(),
            timezone: "UTC".into(),
            mission_id: None,
            enabled: true,
            last_run_at: Some(ts(1_700_000_000)),
            next_run_at: Some(ts(1_700_000_300)),
        };
        let json = serde_json::to_value(&due).unwrap();
        assert_eq!(serde_json::from_value::<DueSchedule>(json).unwrap(), due);

        let advanced = AdvancedSchedule {
            id: Uuid::nil(),
            company_id: Uuid::nil(),
            agent_id: Uuid::nil(),
            last_run_at: Some(ts(1_700_000_000)),
            next_run_at: Some(ts(1_700_000_300)),
            updated_at: ts(1_700_000_300),
        };
        let applied = FencedAdvanceResult::Applied(advanced);
        let json = serde_json::to_value(&applied).unwrap();
        assert_eq!(
            serde_json::from_value::<FencedAdvanceResult>(json).unwrap(),
            applied
        );
        let json = serde_json::to_value(FencedAdvanceResult::Discarded).unwrap();
        assert_eq!(
            serde_json::from_value::<FencedAdvanceResult>(json).unwrap(),
            FencedAdvanceResult::Discarded
        );

        let toggle = ScheduleToggleResult {
            id: Uuid::nil(),
            enabled: false,
            updated_at: ts(1_700_000_300),
        };
        let json = serde_json::to_value(&toggle).unwrap();
        assert_eq!(
            serde_json::from_value::<ScheduleToggleResult>(json).unwrap(),
            toggle
        );
    }

    #[test]
    fn sql_due_listing_is_company_scoped_and_locking() {
        assert!(SQL_LIST_DUE_SCHEDULES.contains("FROM schedules"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("company_id = $1"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("enabled = true"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("next_run_at IS NOT NULL"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("next_run_at <= $2"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("ORDER BY next_run_at ASC, id ASC"));
        assert!(SQL_LIST_DUE_SCHEDULES.contains("FOR UPDATE SKIP LOCKED"));
    }

    #[test]
    fn sql_advance_is_fenced_cas() {
        assert!(SQL_ADVANCE_SCHEDULE_FENCED.contains("id = $1 AND company_id = $4"));
        assert!(SQL_ADVANCE_SCHEDULE_FENCED.contains("enabled = true"));
        assert!(SQL_ADVANCE_SCHEDULE_FENCED.contains("next_run_at IS NOT DISTINCT FROM $5"));
        assert!(SQL_ADVANCE_SCHEDULE_FENCED.contains("RETURNING"));
    }

    #[test]
    fn sql_toggle_is_company_scoped() {
        assert!(SQL_SET_SCHEDULE_ENABLED.contains("id = $1 AND company_id = $3"));
        assert!(SQL_SET_SCHEDULE_ENABLED.contains("RETURNING id, enabled, updated_at"));
    }
}

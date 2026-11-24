use chrono::{DateTime, Utc};
use postgres::Transaction;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

#[cfg(unix)]
pub mod runner;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus { Queued, Running, Succeeded, Failed, Cancelled, TimedOut }

const ALL_STATUSES: [RunStatus; 6] = [
    RunStatus::Queued, RunStatus::Running, RunStatus::Succeeded,
    RunStatus::Failed, RunStatus::Cancelled, RunStatus::TimedOut,
];

const STATUS_NAMES: [&str; 6] = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"];

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Option<RunStatus> {
        ALL_STATUSES.into_iter().find(|s| s.as_str() == raw)
    }

    pub fn is_terminal(&self) -> bool {
        !matches!(self, RunStatus::Queued | RunStatus::Running)
    }

    pub fn is_running(&self) -> bool {
        matches!(self, RunStatus::Running)
    }

    pub fn is_legal_transition(from: RunStatus, to: RunStatus) -> bool {
        match from {
            RunStatus::Queued => {
                matches!(to, RunStatus::Running | RunStatus::Cancelled | RunStatus::Failed)
            }
            RunStatus::Running => to.is_terminal(),
            _ => false,
        }
    }
}

#[derive(Debug)]
pub enum HeartbeatDbError {
    EmptyExpectedStatuses,
    IllegalTransition { from: RunStatus, to: RunStatus },
    Db(postgres::Error),
}

impl fmt::Display for HeartbeatDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HeartbeatDbError::EmptyExpectedStatuses => write!(f, "empty expected_statuses"),
            HeartbeatDbError::IllegalTransition { from, to } => {
                write!(f, "illegal run status transition: {} -> {}", from.as_str(), to.as_str())
            }
            HeartbeatDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for HeartbeatDbError {}

impl From<postgres::Error> for HeartbeatDbError {
    fn from(err: postgres::Error) -> Self {
        HeartbeatDbError::Db(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionPlan { pub sets_started_at: bool, pub sets_finished_at: bool }

pub fn validate_transition(
    expected: &[RunStatus],
    next: RunStatus,
) -> Result<TransitionPlan, HeartbeatDbError> {
    if expected.is_empty() {
        return Err(HeartbeatDbError::EmptyExpectedStatuses);
    }
    for from in expected {
        if !RunStatus::is_legal_transition(*from, next) {
            return Err(HeartbeatDbError::IllegalTransition { from: *from, to: next });
        }
    }
    Ok(TransitionPlan {
        sets_started_at: next == RunStatus::Running,
        sets_finished_at: next.is_terminal(),
    })
}

#[derive(Debug)]
pub struct ClaimWakeupInput { pub company_id: Uuid, pub agent_id: Uuid }

#[derive(Debug)]
pub struct ClaimedWakeup {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub source: String,
    pub reason: Option<String>,
    pub idempotency_key: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub requested_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
}

pub const SQL_SELECT_QUEUED_WAKEUP: &str = "SELECT id, company_id, agent_id, source, reason, idempotency_key, payload, requested_at FROM agent_wakeup_requests WHERE company_id = $1 AND agent_id = $2 AND status = 'queued' ORDER BY requested_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED";
pub const SQL_CLAIM_WAKEUP: &str = "UPDATE agent_wakeup_requests SET status = 'claimed', claimed_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'queued' RETURNING id, company_id, agent_id, source, reason, idempotency_key, payload, requested_at, claimed_at";
pub const SQL_TRANSITION_RUN_FENCED: &str = "UPDATE heartbeat_runs SET status = $2, updated_at = now(), started_at = CASE WHEN $3 THEN COALESCE(started_at, now()) ELSE started_at END, finished_at = CASE WHEN $4 THEN COALESCE(finished_at, now()) ELSE finished_at END, error = COALESCE($5, error), error_code = COALESCE($6, error_code) WHERE id = $1 AND company_id = $7 AND status = ANY($8) RETURNING id, status, started_at, finished_at";
pub const SQL_LIST_STALE_RUNS: &str = "SELECT id, company_id, agent_id, process_pid, process_loss_retry_count, updated_at FROM heartbeat_runs WHERE company_id = $1 AND status = 'running' AND updated_at < $2 ORDER BY updated_at ASC, id ASC LIMIT $3 FOR UPDATE SKIP LOCKED";

pub fn claim_next_queued_wakeup(
    tx: &mut Transaction<'_>,
    input: &ClaimWakeupInput,
) -> Result<Option<ClaimedWakeup>, HeartbeatDbError> {
    let selected = tx.query_opt(SQL_SELECT_QUEUED_WAKEUP, &[&input.company_id, &input.agent_id])?;
    let Some(selected) = selected else { return Ok(None) };
    let claimed = tx.query_opt(SQL_CLAIM_WAKEUP, &[&selected.get::<_, Uuid>(0), &input.company_id])?;
    Ok(claimed.map(|row| ClaimedWakeup {
        id: row.get(0), company_id: row.get(1), agent_id: row.get(2), source: row.get(3),
        reason: row.get(4), idempotency_key: row.get(5), payload: row.get(6),
        requested_at: row.get(7), claimed_at: row.get(8),
    }))
}

#[derive(Debug)]
pub struct FencedTransitionInput {
    pub run_id: Uuid,
    pub company_id: Uuid,
    pub expected_statuses: Vec<RunStatus>,
    pub next_status: RunStatus,
    pub error: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug)]
pub struct AppliedTransition {
    pub run_id: Uuid,
    pub status: RunStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
pub enum FencedTransitionResult { Applied(AppliedTransition), Discarded }

pub fn transition_run_status_fenced(
    tx: &mut Transaction<'_>,
    input: &FencedTransitionInput,
) -> Result<FencedTransitionResult, HeartbeatDbError> {
    let plan = validate_transition(&input.expected_statuses, input.next_status)?;
    let expected: Vec<&str> = input.expected_statuses.iter().map(|s| s.as_str()).collect();
    let updated = tx.query_opt(
        SQL_TRANSITION_RUN_FENCED,
        &[
            &input.run_id, &input.next_status.as_str(), &plan.sets_started_at,
            &plan.sets_finished_at, &input.error, &input.error_code, &input.company_id, &expected,
        ],
    )?;
    let Some(row) = updated else { return Ok(FencedTransitionResult::Discarded) };
    let status: String = row.get(1);
    Ok(FencedTransitionResult::Applied(AppliedTransition {
        run_id: row.get(0),
        status: RunStatus::parse(&status).unwrap_or(input.next_status),
        started_at: row.get(2),
        finished_at: row.get(3),
    }))
}

#[derive(Debug)]
pub struct StaleRunCandidate {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub process_pid: Option<i32>,
    pub process_loss_retry_count: i32,
    pub updated_at: DateTime<Utc>,
}

pub fn clamp_stale_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn list_stale_running_runs_skip_locked(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    stale_before: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<StaleRunCandidate>, HeartbeatDbError> {
    let rows = tx.query(SQL_LIST_STALE_RUNS, &[&company_id, &stale_before, &clamp_stale_limit(limit)])?;
    Ok(rows.iter().map(|row| StaleRunCandidate {
        id: row.get(0), company_id: row.get(1), agent_id: row.get(2),
        process_pid: row.get(3), process_loss_retry_count: row.get(4), updated_at: row.get(5),
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::RunStatus::*;
    use super::*;

    const LEGAL: &[(RunStatus, RunStatus)] = &[
        (Queued, Running), (Queued, Cancelled), (Queued, Failed),
        (Running, Succeeded), (Running, Failed), (Running, Cancelled), (Running, TimedOut),
    ];

    #[test]
    fn legal_transition_matrix() {
        for from in ALL_STATUSES {
            for to in ALL_STATUSES {
                assert_eq!(
                    RunStatus::is_legal_transition(from, to),
                    LEGAL.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn validate_transition_rejects_bad_input() {
        assert!(matches!(
            validate_transition(&[], Running),
            Err(HeartbeatDbError::EmptyExpectedStatuses)
        ));
        assert!(matches!(
            validate_transition(&[Succeeded], Running),
            Err(HeartbeatDbError::IllegalTransition { from: Succeeded, to: Running })
        ));
        for (from, to) in [(Failed, Succeeded), (Queued, Succeeded)] {
            assert!(matches!(
                validate_transition(&[from], to),
                Err(HeartbeatDbError::IllegalTransition { .. })
            ));
        }
    }

    #[test]
    fn validate_transition_plan_flags() {
        let started = validate_transition(&[Queued], Running).unwrap();
        assert!(started.sets_started_at && !started.sets_finished_at);
        let finished = validate_transition(&[Running], Succeeded).unwrap();
        assert!(!finished.sets_started_at && finished.sets_finished_at);
    }

    #[test]
    fn stale_limit_is_clamped() {
        assert_eq!(clamp_stale_limit(0), 1);
        assert_eq!(clamp_stale_limit(-9), 1);
        assert_eq!(clamp_stale_limit(200), 200);
        assert_eq!(clamp_stale_limit(10_000), 200);
    }

    #[test]
    fn run_status_serde_roundtrip() {
        for status in ALL_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<RunStatus>(json).unwrap(), status);
        }
        assert_eq!(RunStatus::parse("timed_out"), Some(TimedOut));
        assert_eq!(RunStatus::parse("done"), None);
        assert!(!Queued.is_terminal());
        assert!(Running.is_running() && !Running.is_terminal() && Cancelled.is_terminal());
    }
}

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::Transaction;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus { Pending, Running, Completed, Failed, Cancelled }

const RUN_STATUSES: [(WorkflowRunStatus, &str); 5] = [
    (WorkflowRunStatus::Pending, "pending"), (WorkflowRunStatus::Running, "running"),
    (WorkflowRunStatus::Completed, "completed"), (WorkflowRunStatus::Failed, "failed"),
    (WorkflowRunStatus::Cancelled, "cancelled"),
];

impl WorkflowRunStatus {
    pub fn as_str(&self) -> &'static str { RUN_STATUSES[*self as usize].1 }
    pub fn parse(raw: &str) -> Option<Self> { RUN_STATUSES.into_iter().find(|(_, n)| *n == raw).map(|(s, _)| s) }
    pub fn is_terminal(&self) -> bool { !matches!(self, Self::Pending | Self::Running) }
    pub fn is_legal_transition(from: Self, to: Self) -> bool {
        matches!((from, to),
            (Self::Pending, Self::Running) | (Self::Pending, Self::Cancelled) | (Self::Pending, Self::Failed)
                | (Self::Running, Self::Completed) | (Self::Running, Self::Failed) | (Self::Running, Self::Cancelled))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepStatus { Pending, Running, Completed, Failed, Skipped, Cancelled }

const STEP_STATUSES: [(WorkflowStepStatus, &str); 6] = [
    (WorkflowStepStatus::Pending, "pending"), (WorkflowStepStatus::Running, "running"),
    (WorkflowStepStatus::Completed, "completed"), (WorkflowStepStatus::Failed, "failed"),
    (WorkflowStepStatus::Skipped, "skipped"), (WorkflowStepStatus::Cancelled, "cancelled"),
];

impl WorkflowStepStatus {
    pub fn as_str(&self) -> &'static str { STEP_STATUSES[*self as usize].1 }
    pub fn parse(raw: &str) -> Option<Self> { STEP_STATUSES.into_iter().find(|(_, n)| *n == raw).map(|(s, _)| s) }
    pub fn is_terminal(&self) -> bool { !matches!(self, Self::Pending | Self::Running) }
    pub fn is_legal_transition(from: Self, to: Self) -> bool {
        matches!((from, to),
            (Self::Pending, Self::Running) | (Self::Pending, Self::Skipped)
                | (Self::Pending, Self::Cancelled) | (Self::Pending, Self::Failed)
                | (Self::Running, Self::Completed) | (Self::Running, Self::Failed)
                | (Self::Running, Self::Cancelled))
    }
}

#[derive(Debug)]
pub enum WorkflowDbError {
    EmptyExpectedStatuses,
    IllegalRunTransition { from: WorkflowRunStatus, to: WorkflowRunStatus },
    IllegalStepTransition { from: WorkflowStepStatus, to: WorkflowStepStatus },
    Db(postgres::Error),
}

impl std::fmt::Display for WorkflowDbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkflowDbError::EmptyExpectedStatuses => write!(f, "empty expected_statuses"),
            WorkflowDbError::IllegalRunTransition { from, to } =>
                write!(f, "illegal run status transition: {} -> {}", from.as_str(), to.as_str()),
            WorkflowDbError::IllegalStepTransition { from, to } =>
                write!(f, "illegal step status transition: {} -> {}", from.as_str(), to.as_str()),
            WorkflowDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for WorkflowDbError {}

impl From<postgres::Error> for WorkflowDbError {
    fn from(err: postgres::Error) -> Self { WorkflowDbError::Db(err) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionPlan { pub sets_started_at: bool, pub sets_completed_at: bool }

fn check_expected<T: Copy>(
    expected: &[T], next: T, legal: fn(T, T) -> bool, reject: fn(T, T) -> WorkflowDbError,
) -> Result<(), WorkflowDbError> {
    if expected.is_empty() { return Err(WorkflowDbError::EmptyExpectedStatuses) }
    for from in expected {
        if !legal(*from, next) { return Err(reject(*from, next)) }
    }
    Ok(())
}

pub fn validate_run_transition(
    expected: &[WorkflowRunStatus], next: WorkflowRunStatus,
) -> Result<TransitionPlan, WorkflowDbError> {
    check_expected(expected, next, WorkflowRunStatus::is_legal_transition, |from, to| WorkflowDbError::IllegalRunTransition { from, to })?;
    Ok(TransitionPlan { sets_started_at: next == WorkflowRunStatus::Running, sets_completed_at: next.is_terminal() })
}

pub fn validate_step_transition(
    expected: &[WorkflowStepStatus], next: WorkflowStepStatus,
) -> Result<TransitionPlan, WorkflowDbError> {
    check_expected(expected, next, WorkflowStepStatus::is_legal_transition, |from, to| WorkflowDbError::IllegalStepTransition { from, to })?;
    Ok(TransitionPlan { sets_started_at: next == WorkflowStepStatus::Running, sets_completed_at: next.is_terminal() })
}

pub fn clamp_batch_limit(limit: i64) -> i64 { limit.clamp(1, 200) }

pub const SQL_LIST_PENDING_WORKFLOW_RUNS: &str = "SELECT id, workflow_id, company_id, mission_id, triggered_by, created_at FROM workflow_runs WHERE company_id = $1 AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED";
pub const SQL_TRANSITION_WORKFLOW_RUN_FENCED: &str = "UPDATE workflow_runs SET status = $2, started_at = CASE WHEN $3 THEN COALESCE(started_at, now()) ELSE started_at END, completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END WHERE id = $1 AND company_id = $5 AND status = ANY($6) RETURNING id, status, started_at, completed_at";
pub const SQL_TRANSITION_STEP_RUN_FENCED: &str = "UPDATE workflow_step_runs wsr SET status = $2, status_transition_version = wsr.status_transition_version + 1, started_at = CASE WHEN $3 THEN COALESCE(wsr.started_at, now()) ELSE wsr.started_at END, completed_at = CASE WHEN $4 THEN COALESCE(wsr.completed_at, now()) ELSE wsr.completed_at END WHERE wsr.id = $1 AND wsr.workflow_run_id = $5 AND wsr.status = ANY($6) AND wsr.status_transition_version = $7 AND EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.id = wsr.workflow_run_id AND wr.company_id = $8) RETURNING wsr.id, wsr.status, wsr.status_transition_version, wsr.started_at, wsr.completed_at";
pub const SQL_LIST_STEP_RUNS_FOR_RUN: &str = "SELECT wsr.id, wsr.workflow_run_id, wsr.step_id, wsr.status, wsr.retry_count, wsr.status_transition_version, wsr.execution_generation, wsr.started_at, wsr.completed_at FROM workflow_step_runs wsr INNER JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id WHERE wr.company_id = $1 AND wsr.workflow_run_id = $2 ORDER BY wsr.step_id ASC, wsr.id ASC";

#[derive(Debug)]
pub struct PendingWorkflowRun {
    pub id: Uuid, pub workflow_id: Uuid, pub company_id: Uuid, pub mission_id: Option<Uuid>,
    pub triggered_by: String, pub created_at: DateTime<Utc>,
}

pub fn list_pending_workflow_runs_skip_locked(
    tx: &mut Transaction<'_>, company_id: Uuid, limit: i64,
) -> Result<Vec<PendingWorkflowRun>, WorkflowDbError> {
    let rows = tx.query(SQL_LIST_PENDING_WORKFLOW_RUNS, &[&company_id, &clamp_batch_limit(limit)])?;
    Ok(rows.iter().map(|row| PendingWorkflowRun {
        id: row.get(0), workflow_id: row.get(1), company_id: row.get(2),
        mission_id: row.get(3), triggered_by: row.get(4), created_at: row.get(5),
    }).collect())
}

#[derive(Debug)]
pub enum TransitionResult<T> { Applied(T), Discarded }

#[derive(Debug)]
pub struct RunTransitionInput {
    pub run_id: Uuid, pub company_id: Uuid,
    pub expected_statuses: Vec<WorkflowRunStatus>, pub next_status: WorkflowRunStatus,
}

#[derive(Debug)]
pub struct AppliedRunTransition {
    pub run_id: Uuid, pub status: WorkflowRunStatus,
    pub started_at: Option<DateTime<Utc>>, pub completed_at: Option<DateTime<Utc>>,
}

pub fn transition_workflow_run_fenced(
    tx: &mut Transaction<'_>, input: &RunTransitionInput,
) -> Result<TransitionResult<AppliedRunTransition>, WorkflowDbError> {
    let plan = validate_run_transition(&input.expected_statuses, input.next_status)?;
    let expected: Vec<&str> = input.expected_statuses.iter().map(|s| s.as_str()).collect();
    let updated = tx.query_opt(SQL_TRANSITION_WORKFLOW_RUN_FENCED, &[
        &input.run_id, &input.next_status.as_str(), &plan.sets_started_at,
        &plan.sets_completed_at, &input.company_id, &expected])?;
    let Some(row) = updated else { return Ok(TransitionResult::Discarded) };
    Ok(TransitionResult::Applied(AppliedRunTransition {
        run_id: row.get(0),
        status: WorkflowRunStatus::parse(&row.get::<_, String>(1)).unwrap_or(input.next_status),
        started_at: row.get(2), completed_at: row.get(3) }))
}

#[derive(Debug)]
pub struct StepTransitionInput {
    pub step_run_id: Uuid, pub workflow_run_id: Uuid, pub company_id: Uuid,
    pub expected_statuses: Vec<WorkflowStepStatus>, pub next_status: WorkflowStepStatus,
    pub expected_transition_version: i32,
}

#[derive(Debug)]
pub struct AppliedStepTransition {
    pub step_run_id: Uuid, pub status: WorkflowStepStatus, pub status_transition_version: i32,
    pub started_at: Option<DateTime<Utc>>, pub completed_at: Option<DateTime<Utc>>,
}

pub fn transition_step_run_fenced(
    tx: &mut Transaction<'_>, input: &StepTransitionInput,
) -> Result<TransitionResult<AppliedStepTransition>, WorkflowDbError> {
    let plan = validate_step_transition(&input.expected_statuses, input.next_status)?;
    let expected: Vec<&str> = input.expected_statuses.iter().map(|s| s.as_str()).collect();
    let updated = tx.query_opt(SQL_TRANSITION_STEP_RUN_FENCED, &[
        &input.step_run_id, &input.next_status.as_str(), &plan.sets_started_at,
        &plan.sets_completed_at, &input.workflow_run_id, &expected,
        &input.expected_transition_version, &input.company_id])?;
    let Some(row) = updated else { return Ok(TransitionResult::Discarded) };
    Ok(TransitionResult::Applied(AppliedStepTransition {
        step_run_id: row.get(0),
        status: WorkflowStepStatus::parse(&row.get::<_, String>(1)).unwrap_or(input.next_status),
        status_transition_version: row.get(2),
        started_at: row.get(3), completed_at: row.get(4) }))
}

#[derive(Debug)]
pub struct StepRunRow {
    pub id: Uuid, pub workflow_run_id: Uuid, pub step_id: String, pub status: String,
    pub retry_count: i32, pub status_transition_version: i32, pub execution_generation: i32,
    pub started_at: Option<DateTime<Utc>>, pub completed_at: Option<DateTime<Utc>>,
}

pub fn list_step_runs_for_run(
    tx: &mut Transaction<'_>, company_id: Uuid, workflow_run_id: Uuid,
) -> Result<Vec<StepRunRow>, WorkflowDbError> {
    let rows = tx.query(SQL_LIST_STEP_RUNS_FOR_RUN, &[&company_id, &workflow_run_id])?;
    Ok(rows.iter().map(|row| StepRunRow {
        id: row.get(0), workflow_run_id: row.get(1), step_id: row.get(2), status: row.get(3),
        retry_count: row.get(4), status_transition_version: row.get(5),
        execution_generation: row.get(6), started_at: row.get(7), completed_at: row.get(8),
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::{WorkflowRunStatus as R, WorkflowStepStatus as S, *};

    const RUN_LEGAL: &[(R, R)] = &[
        (R::Pending, R::Running), (R::Pending, R::Cancelled), (R::Pending, R::Failed),
        (R::Running, R::Completed), (R::Running, R::Failed), (R::Running, R::Cancelled)];
    const STEP_LEGAL: &[(S, S)] = &[
        (S::Pending, S::Running), (S::Pending, S::Skipped), (S::Pending, S::Cancelled), (S::Pending, S::Failed),
        (S::Running, S::Completed), (S::Running, S::Failed), (S::Running, S::Cancelled)];

    #[test]
    fn transition_matrices() {
        for from in RUN_STATUSES.map(|(s, _)| s) {
            for to in RUN_STATUSES.map(|(s, _)| s) {
                assert_eq!(R::is_legal_transition(from, to), RUN_LEGAL.contains(&(from, to)), "{from:?} -> {to:?}");
            }
        }
        for from in STEP_STATUSES.map(|(s, _)| s) {
            for to in STEP_STATUSES.map(|(s, _)| s) {
                assert_eq!(S::is_legal_transition(from, to), STEP_LEGAL.contains(&(from, to)), "{from:?} -> {to:?}");
            }
        }
    }
    #[test]
    fn validators_reject_bad_input() {
        use WorkflowDbError::*;
        assert!(matches!(validate_run_transition(&[], R::Running), Err(EmptyExpectedStatuses)));
        assert!(matches!(validate_step_transition(&[], S::Running), Err(EmptyExpectedStatuses)));
        assert!(matches!(validate_run_transition(&[R::Completed], R::Running),
            Err(IllegalRunTransition { from: R::Completed, to: R::Running })));
        assert!(matches!(validate_step_transition(&[S::Running], S::Skipped),
            Err(IllegalStepTransition { from: S::Running, to: S::Skipped })));
        for (from, to) in [(R::Failed, R::Running), (R::Pending, R::Completed)] {
            assert!(matches!(validate_run_transition(&[from], to), Err(IllegalRunTransition { .. })));
        }
        for (from, to) in [(S::Skipped, S::Running), (S::Pending, S::Completed)] {
            assert!(matches!(validate_step_transition(&[from], to), Err(IllegalStepTransition { .. })));
        }
    }
    #[test]
    fn transition_plan_flags_and_clamp() {
        for (plan, want) in [
            (validate_run_transition(&[R::Pending], R::Running).unwrap(), (true, false)),
            (validate_run_transition(&[R::Running], R::Completed).unwrap(), (false, true)),
            (validate_step_transition(&[S::Pending], S::Running).unwrap(), (true, false)),
            (validate_step_transition(&[S::Pending], S::Skipped).unwrap(), (false, true)),
        ] {
            assert_eq!((plan.sets_started_at, plan.sets_completed_at), want);
        }
        for (input, want) in [(0i64, 1), (-9, 1), (200, 200), (10_000, 200)] {
            assert_eq!(clamp_batch_limit(input), want);
        }
    }
    #[test]
    fn status_names_parse_terminal_serde() {
        for (status, name) in RUN_STATUSES {
            assert_eq!(status.as_str(), name);
            assert_eq!(R::parse(name), Some(status));
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(name));
            assert_eq!(serde_json::from_value::<R>(json).unwrap(), status);
        }
        for (status, name) in STEP_STATUSES {
            assert_eq!(status.as_str(), name);
            assert_eq!(S::parse(name), Some(status));
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(name));
            assert_eq!(serde_json::from_value::<S>(json).unwrap(), status);
        }
        assert_eq!(R::parse("done"), None);
        assert_eq!(S::parse("timed_out"), None);
        assert!(R::Completed.is_terminal() && !R::Running.is_terminal());
        assert!(S::Skipped.is_terminal() && !S::Pending.is_terminal());
    }
    #[test]
    fn sql_fence_invariants() {
        for (sql, needle) in [
            (SQL_LIST_PENDING_WORKFLOW_RUNS, "FOR UPDATE SKIP LOCKED"),
            (SQL_LIST_PENDING_WORKFLOW_RUNS, "company_id = $1"),
            (SQL_TRANSITION_WORKFLOW_RUN_FENCED, "status = ANY($6)"),
            (SQL_TRANSITION_WORKFLOW_RUN_FENCED, "company_id = $5"),
            (SQL_TRANSITION_STEP_RUN_FENCED, "status_transition_version = $7"),
            (SQL_TRANSITION_STEP_RUN_FENCED, "status_transition_version + 1"),
            (SQL_TRANSITION_STEP_RUN_FENCED, "wr.company_id = $8"),
            (SQL_LIST_STEP_RUNS_FOR_RUN, "wr.company_id = $1 AND wsr.workflow_run_id = $2"),
        ] {
            assert!(sql.contains(needle), "missing {needle}");
        }
    }
}

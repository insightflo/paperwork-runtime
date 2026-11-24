#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{
    mission_transition_plan, validate_mission_transition, MissionDbError, MissionStatus,
};

#[derive(Debug, Clone)]
pub struct MissionRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub owner_agent_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub status: MissionStatus,
    pub goal_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub source_mission_id: Option<Uuid>,
    pub source_workflow_run_id: Option<Uuid>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct MissionRollingStateRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub mission_id: Uuid,
    pub revision: i32,
    pub status: String,
    pub state_markdown: String,
    pub state_json: serde_json::Value,
    pub last_run_id: Option<Uuid>,
    pub last_compacted_at: Option<DateTime<Utc>>,
    pub total_runs: i32,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_cents: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct MissionSessionRow {
    pub id: Uuid,
    pub mission_id: Uuid,
    pub agent_id: Uuid,
    pub company_id: Uuid,
    pub session_secret_id: Uuid,
    pub adapter_type: String,
    pub status: String,
    pub last_active_at: DateTime<Utc>,
    pub run_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct TransitionMissionInput {
    pub mission_id: Uuid,
    pub company_id: Uuid,
    pub expected_status: MissionStatus,
    pub next_status: MissionStatus,
}

#[derive(Debug)]
pub struct BumpRollingStateInput {
    pub mission_id: Uuid,
    pub company_id: Uuid,
    pub expected_revision: i32,
    pub state_json: serde_json::Value,
    pub state_markdown: String,
}

pub const SQL_GET_MISSION: &str = "SELECT id, company_id, owner_agent_id, title, description, status, goal_id, project_id, source_mission_id, source_workflow_run_id, started_at, completed_at, created_at, updated_at FROM missions WHERE id = $1 AND company_id = $2";
pub const SQL_LIST_MISSIONS_BY_COMPANY: &str = "SELECT id, company_id, owner_agent_id, title, description, status, goal_id, project_id, source_mission_id, source_workflow_run_id, started_at, completed_at, created_at, updated_at FROM missions WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at ASC, id ASC LIMIT $3";
pub const SQL_TRANSITION_MISSION_STATUS_FENCED: &str = "UPDATE missions SET status = $3, started_at = CASE WHEN $4 THEN COALESCE(started_at, now()) ELSE started_at END, completed_at = CASE WHEN $5 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 AND company_id = $2 AND status = $6 RETURNING id, company_id, owner_agent_id, title, description, status, goal_id, project_id, source_mission_id, source_workflow_run_id, started_at, completed_at, created_at, updated_at";
pub const SQL_GET_MISSION_ROLLING_STATE: &str = "SELECT id, company_id, mission_id, revision, status, state_markdown, state_json, last_run_id, last_compacted_at, total_runs, total_input_tokens, total_output_tokens, total_cost_cents, created_at, updated_at FROM mission_rolling_state WHERE mission_id = $1 AND company_id = $2";
pub const SQL_BUMP_MISSION_ROLLING_STATE_FENCED: &str = "UPDATE mission_rolling_state SET revision = revision + 1, state_json = $4, state_markdown = $5, updated_at = now() WHERE mission_id = $1 AND company_id = $2 AND revision = $3 RETURNING id, company_id, mission_id, revision, status, state_markdown, state_json, last_run_id, last_compacted_at, total_runs, total_input_tokens, total_output_tokens, total_cost_cents, created_at, updated_at";
pub const SQL_LIST_MISSION_SESSIONS: &str = "SELECT id, mission_id, agent_id, company_id, session_secret_id, adapter_type, status, last_active_at, run_count, expires_at, created_at FROM mission_sessions WHERE mission_id = $1 AND company_id = $2 ORDER BY created_at ASC, id ASC";

fn mission_from_row(row: &Row) -> Result<MissionRow, MissionDbError> {
    let raw_status: String = row.get(5);
    Ok(MissionRow {
        id: row.get(0),
        company_id: row.get(1),
        owner_agent_id: row.get(2),
        title: row.get(3),
        description: row.get(4),
        status: MissionStatus::parse(&raw_status)?,
        goal_id: row.get(6),
        project_id: row.get(7),
        source_mission_id: row.get(8),
        source_workflow_run_id: row.get(9),
        started_at: row.get(10),
        completed_at: row.get(11),
        created_at: row.get(12),
        updated_at: row.get(13),
    })
}

fn rolling_state_from_row(row: &Row) -> MissionRollingStateRow {
    MissionRollingStateRow {
        id: row.get(0),
        company_id: row.get(1),
        mission_id: row.get(2),
        revision: row.get(3),
        status: row.get(4),
        state_markdown: row.get(5),
        state_json: row.get(6),
        last_run_id: row.get(7),
        last_compacted_at: row.get(8),
        total_runs: row.get(9),
        total_input_tokens: row.get(10),
        total_output_tokens: row.get(11),
        total_cost_cents: row.get(12),
        created_at: row.get(13),
        updated_at: row.get(14),
    }
}

fn session_from_row(row: &Row) -> MissionSessionRow {
    MissionSessionRow {
        id: row.get(0),
        mission_id: row.get(1),
        agent_id: row.get(2),
        company_id: row.get(3),
        session_secret_id: row.get(4),
        adapter_type: row.get(5),
        status: row.get(6),
        last_active_at: row.get(7),
        run_count: row.get(8),
        expires_at: row.get(9),
        created_at: row.get(10),
    }
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn validate_bump_revision(expected_revision: i32) -> Result<i32, MissionDbError> {
    if expected_revision < 1 {
        return Err(MissionDbError::InvalidRevision(expected_revision));
    }
    Ok(expected_revision)
}

pub fn get_mission(
    tx: &mut Transaction<'_>,
    mission_id: Uuid,
    company_id: Uuid,
) -> Result<Option<MissionRow>, MissionDbError> {
    let row = tx.query_opt(SQL_GET_MISSION, &[&mission_id, &company_id])?;
    row.map(|r| mission_from_row(&r)).transpose()
}

pub fn list_missions_by_company(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    status_filter: Option<MissionStatus>,
    limit: i64,
) -> Result<Vec<MissionRow>, MissionDbError> {
    let status = status_filter.map(|s| s.as_str());
    let rows = tx.query(
        SQL_LIST_MISSIONS_BY_COMPANY,
        &[&company_id, &status, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(mission_from_row).collect()
}

pub fn transition_mission_status_fenced(
    tx: &mut Transaction<'_>,
    input: &TransitionMissionInput,
) -> Result<Option<MissionRow>, MissionDbError> {
    validate_mission_transition(input.expected_status, input.next_status)?;
    let plan = mission_transition_plan(input.next_status);
    let updated = tx.query_opt(
        SQL_TRANSITION_MISSION_STATUS_FENCED,
        &[
            &input.mission_id,
            &input.company_id,
            &input.next_status.as_str(),
            &plan.sets_started_at,
            &plan.sets_completed_at,
            &input.expected_status.as_str(),
        ],
    )?;
    updated.map(|row| mission_from_row(&row)).transpose()
}

pub fn get_mission_rolling_state(
    tx: &mut Transaction<'_>,
    mission_id: Uuid,
    company_id: Uuid,
) -> Result<Option<MissionRollingStateRow>, MissionDbError> {
    let row = tx.query_opt(
        SQL_GET_MISSION_ROLLING_STATE,
        &[&mission_id, &company_id],
    )?;
    Ok(row.map(|r| rolling_state_from_row(&r)))
}

pub fn bump_mission_rolling_state_fenced(
    tx: &mut Transaction<'_>,
    input: &BumpRollingStateInput,
) -> Result<Option<MissionRollingStateRow>, MissionDbError> {
    let expected = validate_bump_revision(input.expected_revision)?;
    let updated = tx.query_opt(
        SQL_BUMP_MISSION_ROLLING_STATE_FENCED,
        &[
            &input.mission_id,
            &input.company_id,
            &expected,
            &input.state_json,
            &input.state_markdown,
        ],
    )?;
    Ok(updated.map(|r| rolling_state_from_row(&r)))
}

pub fn list_mission_sessions(
    tx: &mut Transaction<'_>,
    mission_id: Uuid,
    company_id: Uuid,
) -> Result<Vec<MissionSessionRow>, MissionDbError> {
    let rows = tx.query(
        SQL_LIST_MISSION_SESSIONS,
        &[&mission_id, &company_id],
    )?;
    Ok(rows.iter().map(session_from_row).collect())
}

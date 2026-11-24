use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{ApprovalDbError, ApprovalStatus, ResolutionOutcome};

#[derive(Debug, Clone)]
pub struct ApprovalRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub approval_type: String,
    pub requested_by_agent_id: Option<Uuid>,
    pub requested_by_user_id: Option<String>,
    pub requested_by_plugin_id: Option<String>,
    pub status: ApprovalStatus,
    pub payload: serde_json::Value,
    pub decision_note: Option<String>,
    pub decided_by_user_id: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct CreateApprovalInput {
    pub company_id: Uuid,
    pub approval_type: String,
    pub requested_by_agent_id: Option<Uuid>,
    pub requested_by_user_id: Option<String>,
    pub requested_by_plugin_id: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Debug)]
pub struct ResolveApprovalInput {
    pub approval_id: Uuid,
    pub company_id: Uuid,
    pub target_status: ApprovalStatus,
    pub decided_by_user_id: String,
    pub decision_note: Option<String>,
}

pub const SQL_GET_APPROVAL_BY_ID: &str = "SELECT id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at FROM approvals WHERE id = $1 AND company_id = $2";
pub const SQL_LIST_APPROVALS_BY_COMPANY: &str = "SELECT id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at FROM approvals WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at ASC, id ASC LIMIT $3";
pub const SQL_CREATE_APPROVAL: &str = "INSERT INTO approvals (company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload) VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";
pub const SQL_RESOLVE_APPROVAL_FENCED: &str = "UPDATE approvals SET status = $3, decided_by_user_id = $4, decision_note = $5, decided_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('pending', 'revision_requested') RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";
pub const SQL_REQUEST_REVISION_FENCED: &str = "UPDATE approvals SET status = 'revision_requested', decided_by_user_id = $3, decision_note = $4, decided_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";
pub const SQL_RESUBMIT_APPROVAL_FENCED: &str = "UPDATE approvals SET status = 'pending', payload = COALESCE($3, payload), decision_note = NULL, decided_by_user_id = NULL, decided_at = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'revision_requested' RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";
pub const SQL_CANCEL_APPROVAL_FENCED: &str = "UPDATE approvals SET status = 'cancelled', updated_at = now() WHERE id = $1 AND company_id = $2 AND status IN ('pending', 'revision_requested') RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";

fn approval_from_row(row: &Row) -> Result<ApprovalRow, ApprovalDbError> {
    let raw_status: String = row.get(6);
    Ok(ApprovalRow {
        id: row.get(0),
        company_id: row.get(1),
        approval_type: row.get(2),
        requested_by_agent_id: row.get(3),
        requested_by_user_id: row.get(4),
        requested_by_plugin_id: row.get(5),
        status: ApprovalStatus::parse(&raw_status)?,
        payload: row.get(7),
        decision_note: row.get(8),
        decided_by_user_id: row.get(9),
        decided_at: row.get(10),
        created_at: row.get(11),
        updated_at: row.get(12),
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn get_approval_by_id(
    tx: &mut Transaction<'_>,
    approval_id: Uuid,
    company_id: Uuid,
) -> Result<Option<ApprovalRow>, ApprovalDbError> {
    let row = tx.query_opt(SQL_GET_APPROVAL_BY_ID, &[&approval_id, &company_id])?;
    row.map(|r| approval_from_row(&r)).transpose()
}

pub fn list_approvals_by_company(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    status_filter: Option<ApprovalStatus>,
    limit: i64,
) -> Result<Vec<ApprovalRow>, ApprovalDbError> {
    let status = status_filter.map(|s| s.as_str());
    let rows = tx.query(
        SQL_LIST_APPROVALS_BY_COMPANY,
        &[&company_id, &status, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(approval_from_row).collect()
}

pub fn create_approval(
    tx: &mut Transaction<'_>,
    input: &CreateApprovalInput,
) -> Result<ApprovalRow, ApprovalDbError> {
    let row = tx.query_one(
        SQL_CREATE_APPROVAL,
        &[
            &input.company_id,
            &input.approval_type,
            &input.requested_by_agent_id,
            &input.requested_by_user_id,
            &input.requested_by_plugin_id,
            &input.payload,
        ],
    )?;
    approval_from_row(&row)
}

pub fn resolve_approval_fenced(
    tx: &mut Transaction<'_>,
    input: &ResolveApprovalInput,
) -> Result<ResolutionOutcome, ApprovalDbError> {
    match input.target_status {
        ApprovalStatus::Approved | ApprovalStatus::Rejected => {}
        other => return Err(ApprovalDbError::InvalidStatus(other.as_str().to_string())),
    }
    if input.decided_by_user_id.trim().is_empty() {
        return Err(ApprovalDbError::EmptyDecisionActor);
    }
    let updated = tx.query_opt(
        SQL_RESOLVE_APPROVAL_FENCED,
        &[
            &input.approval_id,
            &input.company_id,
            &input.target_status.as_str(),
            &input.decided_by_user_id,
            &input.decision_note,
        ],
    )?;
    if let Some(row) = updated {
        return Ok(ResolutionOutcome::Applied(approval_from_row(&row)?));
    }
    match get_approval_by_id(tx, input.approval_id, input.company_id)? {
        Some(current) if current.status == input.target_status => {
            Ok(ResolutionOutcome::AlreadyInTargetState(current))
        }
        _ => Ok(ResolutionOutcome::NotFoundOrConflict),
    }
}

pub fn request_revision_fenced(
    tx: &mut Transaction<'_>,
    approval_id: Uuid,
    company_id: Uuid,
    decided_by_user_id: &str,
    decision_note: Option<&str>,
) -> Result<Option<ApprovalRow>, ApprovalDbError> {
    if decided_by_user_id.trim().is_empty() {
        return Err(ApprovalDbError::EmptyDecisionActor);
    }
    let updated = tx.query_opt(
        SQL_REQUEST_REVISION_FENCED,
        &[&approval_id, &company_id, &decided_by_user_id, &decision_note],
    )?;
    updated.map(|row| approval_from_row(&row)).transpose()
}

pub fn resubmit_approval_fenced(
    tx: &mut Transaction<'_>,
    approval_id: Uuid,
    company_id: Uuid,
    payload: Option<serde_json::Value>,
) -> Result<Option<ApprovalRow>, ApprovalDbError> {
    let updated = tx.query_opt(
        SQL_RESUBMIT_APPROVAL_FENCED,
        &[&approval_id, &company_id, &payload],
    )?;
    updated.map(|row| approval_from_row(&row)).transpose()
}

pub fn cancel_approval_fenced(
    tx: &mut Transaction<'_>,
    approval_id: Uuid,
    company_id: Uuid,
) -> Result<Option<ApprovalRow>, ApprovalDbError> {
    let updated = tx.query_opt(SQL_CANCEL_APPROVAL_FENCED, &[&approval_id, &company_id])?;
    updated.map(|row| approval_from_row(&row)).transpose()
}

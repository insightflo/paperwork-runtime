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
pub const SQL_CREATE_APPROVAL: &str = "INSERT INTO approvals (company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload) SELECT $1, $2, $3, $4, $5, 'pending', $6 WHERE $3::uuid IS NULL OR EXISTS (SELECT 1 FROM agents a WHERE a.id = $3 AND a.company_id = $1) RETURNING id, company_id, type, requested_by_agent_id, requested_by_user_id, requested_by_plugin_id, status, payload, decision_note, decided_by_user_id, decided_at, created_at, updated_at";
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
    let row = tx.query_opt(
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
    approval_from_row(&row.ok_or(ApprovalDbError::CrossCompanyRequesterAgent)?)
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
    let updated = tx
        .query_opt(
            SQL_RESOLVE_APPROVAL_FENCED,
            &[
                &input.approval_id,
                &input.company_id,
                &input.target_status.as_str(),
                &input.decided_by_user_id,
                &input.decision_note,
            ],
        )?
        .map(|row| approval_from_row(&row))
        .transpose()?;
    let existing = if updated.is_none() {
        get_approval_by_id(tx, input.approval_id, input.company_id)?
    } else {
        None
    };
    Ok(classify_resolution_outcome(
        updated,
        existing,
        input.target_status,
    ))
}

pub fn classify_resolution_outcome(
    updated: Option<ApprovalRow>,
    existing: Option<ApprovalRow>,
    target: ApprovalStatus,
) -> ResolutionOutcome {
    match (updated, existing) {
        (Some(row), _) => ResolutionOutcome::Applied(row),
        (None, Some(row)) if row.status == target => {
            ResolutionOutcome::AlreadyInTargetState(row)
        }
        _ => ResolutionOutcome::NotFoundOrConflict,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: ApprovalStatus) -> ApprovalRow {
        let ts = Utc::now();
        ApprovalRow {
            id: Uuid::new_v4(),
            company_id: Uuid::new_v4(),
            approval_type: "t".to_string(),
            requested_by_agent_id: None,
            requested_by_user_id: None,
            requested_by_plugin_id: None,
            status,
            payload: serde_json::json!({}),
            decision_note: Some("note".to_string()),
            decided_by_user_id: Some("u".to_string()),
            decided_at: Some(ts),
            created_at: ts,
            updated_at: ts,
        }
    }

    #[test]
    fn first_apply_returns_applied_row() {
        let applied = row(ApprovalStatus::Approved);
        let expected = (
            applied.id,
            applied.decided_by_user_id.clone(),
            applied.decision_note.clone(),
        );
        let ResolutionOutcome::Applied(got) =
            classify_resolution_outcome(Some(applied), None, ApprovalStatus::Approved)
        else {
            panic!("expected Applied");
        };
        assert_eq!(
            (got.id, got.decided_by_user_id, got.decision_note),
            expected
        );
    }

    #[test]
    fn missed_resolution_same_target_preserves_decision() {
        let existing = row(ApprovalStatus::Approved);
        let expected = (
            existing.decided_by_user_id.clone(),
            existing.decision_note.clone(),
            existing.decided_at,
        );
        let ResolutionOutcome::AlreadyInTargetState(got) =
            classify_resolution_outcome(None, Some(existing), ApprovalStatus::Approved)
        else {
            panic!("expected AlreadyInTargetState");
        };
        assert_eq!(
            (got.decided_by_user_id, got.decision_note, got.decided_at),
            expected
        );
    }

    #[test]
    fn missed_resolution_opposite_terminal_is_conflict() {
        assert!(matches!(
            classify_resolution_outcome(
                None,
                Some(row(ApprovalStatus::Rejected)),
                ApprovalStatus::Approved
            ),
            ResolutionOutcome::NotFoundOrConflict
        ));
    }

    #[test]
    fn missed_resolution_missing_row_is_conflict() {
        assert!(matches!(
            classify_resolution_outcome(None, None, ApprovalStatus::Approved),
            ResolutionOutcome::NotFoundOrConflict
        ));
    }
}

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{validate_object_field, validate_optional_object_field, validate_quality_continuation,
    validate_request_hash, validate_request_key, validate_resolved_by, validate_schema_version, validate_source,
    validate_title, ContinuationMode, DecisionDbError, DecisionPriority, DecisionStatus, InteractionType, SCHEMA_VERSION};

/// Full 26-column projection of `operator_decisions` (packages/db schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub quality_action_id: Option<Uuid>,
    pub quality_binding: Option<serde_json::Value>,
    pub request_key: String,
    pub request_hash: String,
    pub schema_version: i32,
    pub status: DecisionStatus,
    pub priority: DecisionPriority,
    pub interaction_type: InteractionType,
    pub title: String,
    pub description: String,
    pub source_type: String,
    pub source_id: String,
    pub source_context: serde_json::Value,
    pub issue_id: Option<Uuid>,
    pub requested_by_agent_id: Option<Uuid>,
    pub requested_by_user_id: Option<String>,
    pub definition: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub resolved_by_user_id: Option<String>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub cancelled_at: Option<DateTime<Utc>>,
    pub continuation_mode: ContinuationMode,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `id`/`status`/`result`/`resolved_*`/`cancelled_at`/timestamps are DB-owned on insert.
#[derive(Debug)]
pub struct CreateDecisionInput {
    pub company_id: Uuid,
    pub request_key: String,
    pub request_hash: String,
    pub priority: DecisionPriority,
    pub interaction_type: InteractionType,
    pub title: String,
    pub description: String,
    pub source_type: String,
    pub source_id: String,
    pub source_context: serde_json::Value,
    pub issue_id: Option<Uuid>,
    pub requested_by_agent_id: Option<Uuid>,
    pub requested_by_user_id: Option<String>,
    pub definition: serde_json::Value,
    pub continuation_mode: ContinuationMode,
    pub quality_action_id: Option<Uuid>,
    pub quality_binding: Option<serde_json::Value>,
}

pub const SQL_LIST_OPERATOR_DECISIONS: &str = "SELECT id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at FROM operator_decisions WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at ASC, id ASC LIMIT $3";
pub const SQL_GET_OPERATOR_DECISION_BY_ID: &str = "SELECT id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at FROM operator_decisions WHERE id = $1 AND company_id = $2";
pub const SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY: &str = "SELECT id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at FROM operator_decisions WHERE company_id = $1 AND request_key = $2";
/// Conflict target `operator_decisions_company_request_uq`; `status` uses DB default 'pending'.
pub const SQL_CREATE_OPERATOR_DECISION: &str = "INSERT INTO operator_decisions (company_id, request_key, request_hash, schema_version, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, continuation_mode, quality_action_id, quality_binding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT (company_id, request_key) DO NOTHING RETURNING id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at";
/// `status = 'pending'` fence; satisfies `operator_decisions_resolved_state_check` atomically.
pub const SQL_RESOLVE_OPERATOR_DECISION_FENCED: &str = "UPDATE operator_decisions SET status = 'resolved', result = $3, resolved_by_user_id = $4, resolved_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at";
/// The `status = 'pending'` fence satisfies `operator_decisions_cancelled_state_check`.
pub const SQL_CANCEL_OPERATOR_DECISION_FENCED: &str = "UPDATE operator_decisions SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at";

fn decode_col<'a, T: postgres::types::FromSql<'a>>(row: &'a Row, idx: usize, column: &'static str) -> Result<T, DecisionDbError> {
    row.try_get(idx).map_err(|err| DecisionDbError::UndecodableRow { column: column.to_string(), detail: err.to_string() })
}

// Column positions for the shared 26-column projection used by every
// SELECT/RETURNING list in this file: 0 id, 1 company_id, 2 quality_action_id,
// 3 quality_binding, 4 request_key, 5 request_hash, 6 schema_version, 7 status,
// 8 priority, 9 interaction_type, 10 title, 11 description, 12 source_type,
// 13 source_id, 14 source_context, 15 issue_id, 16 requested_by_agent_id,
// 17 requested_by_user_id, 18 definition, 19 result, 20 resolved_by_user_id,
// 21 resolved_at, 22 cancelled_at, 23 continuation_mode, 24 created_at, 25 updated_at
fn decision_from_row(row: &Row) -> Result<DecisionRow, DecisionDbError> {
    let schema_version: i32 = decode_col(row, 6, "schema_version")?;
    validate_schema_version(schema_version)?;
    Ok(DecisionRow {
        id: decode_col(row, 0, "id")?, company_id: decode_col(row, 1, "company_id")?,
        quality_action_id: decode_col(row, 2, "quality_action_id")?, quality_binding: decode_col(row, 3, "quality_binding")?,
        request_key: decode_col(row, 4, "request_key")?, request_hash: decode_col(row, 5, "request_hash")?,
        schema_version,
        status: DecisionStatus::parse(&decode_col::<String>(row, 7, "status")?)?,
        priority: DecisionPriority::parse(&decode_col::<String>(row, 8, "priority")?)?,
        interaction_type: InteractionType::parse(&decode_col::<String>(row, 9, "interaction_type")?)?,
        title: decode_col(row, 10, "title")?, description: decode_col(row, 11, "description")?,
        source_type: decode_col(row, 12, "source_type")?, source_id: decode_col(row, 13, "source_id")?,
        source_context: decode_col(row, 14, "source_context")?, issue_id: decode_col(row, 15, "issue_id")?,
        requested_by_agent_id: decode_col(row, 16, "requested_by_agent_id")?,
        requested_by_user_id: decode_col(row, 17, "requested_by_user_id")?,
        definition: decode_col(row, 18, "definition")?, result: decode_col(row, 19, "result")?,
        resolved_by_user_id: decode_col(row, 20, "resolved_by_user_id")?,
        resolved_at: decode_col(row, 21, "resolved_at")?, cancelled_at: decode_col(row, 22, "cancelled_at")?,
        continuation_mode: ContinuationMode::parse(&decode_col::<String>(row, 23, "continuation_mode")?)?,
        created_at: decode_col(row, 24, "created_at")?, updated_at: decode_col(row, 25, "updated_at")?,
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 { limit.clamp(1, 200) }

pub fn list_operator_decisions(tx: &mut Transaction<'_>, company_id: Uuid, status_filter: Option<DecisionStatus>, limit: i64) -> Result<Vec<DecisionRow>, DecisionDbError> {
    let rows = tx.query(SQL_LIST_OPERATOR_DECISIONS, &[&company_id, &status_filter.map(|s| s.as_str()), &clamp_list_limit(limit)])?;
    rows.iter().map(decision_from_row).collect()
}

/// `Ok(None)` when absent or owned by another company (company fence).
pub fn get_operator_decision_by_id(tx: &mut Transaction<'_>, decision_id: Uuid, company_id: Uuid) -> Result<Option<DecisionRow>, DecisionDbError> {
    let row = tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_ID, &[&decision_id, &company_id])?;
    row.map(|r| decision_from_row(&r)).transpose()
}

/// Validates `request_key` non-empty (trimmed) BEFORE any PG I/O.
pub fn get_operator_decision_by_request_key(tx: &mut Transaction<'_>, company_id: Uuid, request_key: &str) -> Result<Option<DecisionRow>, DecisionDbError> {
    validate_request_key(request_key)?;
    let row = tx.query_opt(SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY, &[&company_id, &request_key])?;
    row.map(|r| decision_from_row(&r)).transpose()
}

/// Validates input invariants BEFORE any PG I/O; on conflict-miss replays iff `request_hash` matches.
pub fn create_operator_decision(tx: &mut Transaction<'_>, input: &CreateDecisionInput) -> Result<CreateOutcome, DecisionDbError> {
    validate_request_key(&input.request_key)?;
    validate_request_hash(&input.request_hash)?;
    validate_title(&input.title)?;
    validate_source(&input.source_type, &input.source_id)?;
    validate_object_field("source_context", &input.source_context)?;
    validate_object_field("definition", &input.definition)?;
    validate_optional_object_field("quality_binding", input.quality_binding.as_ref())?;
    validate_quality_continuation(input.quality_action_id, input.continuation_mode)?;
    let inserted = tx.query_opt(SQL_CREATE_OPERATOR_DECISION, &[
        &input.company_id, &input.request_key, &input.request_hash, &SCHEMA_VERSION,
        &input.priority.as_str(), &input.interaction_type.as_str(), &input.title, &input.description,
        &input.source_type, &input.source_id, &input.source_context, &input.issue_id,
        &input.requested_by_agent_id, &input.requested_by_user_id, &input.definition,
        &input.continuation_mode.as_str(), &input.quality_action_id, &input.quality_binding,
    ])?.map(|row| decision_from_row(&row)).transpose()?;
    let existing = if inserted.is_none() { get_operator_decision_by_request_key(tx, input.company_id, &input.request_key)? } else { None };
    classify_create_outcome(inserted, existing, &input.request_hash)
}

/// Validates `result`/`resolved_by_user_id` BEFORE any PG I/O; the pending fence makes the CAS atomic.
pub fn resolve_operator_decision(tx: &mut Transaction<'_>, decision_id: Uuid, company_id: Uuid, result: &serde_json::Value, resolved_by_user_id: &str) -> Result<ResolutionOutcome, DecisionDbError> {
    validate_object_field("result", result)?;
    validate_resolved_by(resolved_by_user_id)?;
    let updated = tx.query_opt(SQL_RESOLVE_OPERATOR_DECISION_FENCED, &[&decision_id, &company_id, &result, &resolved_by_user_id])?
        .map(|row| decision_from_row(&row)).transpose()?;
    let existing = if updated.is_none() { get_operator_decision_by_id(tx, decision_id, company_id)? } else { None };
    Ok(classify_resolution_outcome(updated, existing, DecisionStatus::Resolved))
}

/// Fenced pending->cancelled CAS; `Ok(None)` when absent/terminal/other company.
pub fn cancel_operator_decision(tx: &mut Transaction<'_>, decision_id: Uuid, company_id: Uuid) -> Result<Option<DecisionRow>, DecisionDbError> {
    let row = tx.query_opt(SQL_CANCEL_OPERATOR_DECISION_FENCED, &[&decision_id, &company_id])?;
    row.map(|r| decision_from_row(&r)).transpose()
}

#[derive(Debug)]
pub enum CreateOutcome {
    Created(DecisionRow),
    Replayed(DecisionRow),
}

/// Inserted row wins; conflict-miss with matching `request_hash` replays; else `RequestKeyConflict`.
pub fn classify_create_outcome(inserted: Option<DecisionRow>, existing: Option<DecisionRow>, request_hash: &str) -> Result<CreateOutcome, DecisionDbError> {
    match (inserted, existing) {
        (Some(row), _) => Ok(CreateOutcome::Created(row)),
        (None, Some(row)) if row.request_hash == request_hash => Ok(CreateOutcome::Replayed(row)),
        _ => Err(DecisionDbError::RequestKeyConflict),
    }
}

#[derive(Debug)]
pub enum ResolutionOutcome {
    Applied(DecisionRow),
    AlreadyInTargetState(DecisionRow),
    NotFoundOrConflict,
}

pub fn classify_resolution_outcome(updated: Option<DecisionRow>, existing: Option<DecisionRow>, target: DecisionStatus) -> ResolutionOutcome {
    match (updated, existing) {
        (Some(row), _) => ResolutionOutcome::Applied(row),
        (None, Some(row)) if row.status == target => ResolutionOutcome::AlreadyInTargetState(row),
        _ => ResolutionOutcome::NotFoundOrConflict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: DecisionStatus, request_hash: &str) -> DecisionRow {
        let ts = Utc::now();
        DecisionRow {
            id: Uuid::new_v4(), company_id: Uuid::new_v4(), quality_action_id: None, quality_binding: None,
            request_key: "k".into(), request_hash: request_hash.into(), schema_version: SCHEMA_VERSION, status,
            priority: DecisionPriority::Medium, interaction_type: InteractionType::SingleSelect, title: "t".into(),
            description: String::new(), source_type: "s".into(), source_id: "i".into(), source_context: serde_json::json!({}),
            issue_id: None, requested_by_agent_id: None, requested_by_user_id: None, definition: serde_json::json!({}),
            result: None, resolved_by_user_id: None, resolved_at: None, cancelled_at: None,
            continuation_mode: ContinuationMode::None, created_at: ts, updated_at: ts,
        }
    }

    #[test]
    fn sql_constants_company_scoped_and_parameterized() {
        const ALL: [&str; 6] = [SQL_LIST_OPERATOR_DECISIONS, SQL_GET_OPERATOR_DECISION_BY_ID,
            SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY, SQL_CREATE_OPERATOR_DECISION,
            SQL_RESOLVE_OPERATOR_DECISION_FENCED, SQL_CANCEL_OPERATOR_DECISION_FENCED];
        for sql in ALL {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        assert!(SQL_CREATE_OPERATOR_DECISION.contains("ON CONFLICT (company_id, request_key) DO NOTHING"));
        let insert_cols = SQL_CREATE_OPERATOR_DECISION.split("VALUES").next().unwrap();
        for owned in ["id", "status", "result", "resolved_by_user_id", "resolved_at", "cancelled_at", "created_at", "updated_at"] {
            assert!(!insert_cols.split([' ', ',', '(', ')']).any(|c| c == owned), "{owned} must be DB-owned");
        }
        assert!(SQL_RESOLVE_OPERATOR_DECISION_FENCED.contains("status = 'pending'"));
        assert!(SQL_RESOLVE_OPERATOR_DECISION_FENCED.contains("result = $3"));
        assert!(SQL_RESOLVE_OPERATOR_DECISION_FENCED.contains("resolved_by_user_id = $4"));
        assert!(SQL_RESOLVE_OPERATOR_DECISION_FENCED.contains("resolved_at = now()"));
        assert!(SQL_CANCEL_OPERATOR_DECISION_FENCED.contains("status = 'pending'"));
        assert!(SQL_CANCEL_OPERATOR_DECISION_FENCED.contains("cancelled_at = now()"));
        assert!(SQL_LIST_OPERATOR_DECISIONS.contains("ORDER BY created_at ASC, id ASC LIMIT $3"));
        assert!(SQL_GET_OPERATOR_DECISION_BY_REQUEST_KEY.contains("company_id = $1 AND request_key = $2"));
    }

    #[test]
    fn create_outcome_classification() {
        let inserted = row(DecisionStatus::Pending, "h");
        assert!(matches!(classify_create_outcome(Some(inserted.clone()), None, "h"), Ok(CreateOutcome::Created(r)) if r.id == inserted.id));
        let existing = row(DecisionStatus::Pending, "h");
        assert!(matches!(classify_create_outcome(None, Some(existing.clone()), "h"), Ok(CreateOutcome::Replayed(r)) if r.id == existing.id));
        assert!(matches!(classify_create_outcome(None, Some(row(DecisionStatus::Pending, "h")), "other"), Err(DecisionDbError::RequestKeyConflict)));
        assert!(matches!(classify_create_outcome(None, None, "h"), Err(DecisionDbError::RequestKeyConflict)));
    }

    #[test]
    fn resolution_outcome_classification() {
        let updated = row(DecisionStatus::Resolved, "h");
        assert!(matches!(classify_resolution_outcome(Some(updated.clone()), None, DecisionStatus::Resolved), ResolutionOutcome::Applied(r) if r.id == updated.id));
        let existing = row(DecisionStatus::Resolved, "h");
        assert!(matches!(classify_resolution_outcome(None, Some(existing.clone()), DecisionStatus::Resolved), ResolutionOutcome::AlreadyInTargetState(r) if r.id == existing.id));
        assert!(matches!(classify_resolution_outcome(None, Some(row(DecisionStatus::Pending, "h")), DecisionStatus::Resolved), ResolutionOutcome::NotFoundOrConflict));
        assert!(matches!(classify_resolution_outcome(None, Some(row(DecisionStatus::Cancelled, "h")), DecisionStatus::Resolved), ResolutionOutcome::NotFoundOrConflict));
        assert!(matches!(classify_resolution_outcome(None, None, DecisionStatus::Resolved), ResolutionOutcome::NotFoundOrConflict));
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_replay_resolve_cancel_fencing() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return; }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        for (cid, prefix) in [(a, format!("P{a}")), (b, format!("P{b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix]).unwrap();
        }
        let mk = |key: &str, hash: &str| CreateDecisionInput {
            company_id: a, request_key: key.into(), request_hash: hash.into(), priority: DecisionPriority::Medium,
            interaction_type: InteractionType::SingleSelect, title: "t".into(), description: String::new(),
            source_type: "test".into(), source_id: "s".into(), source_context: serde_json::json!({}), issue_id: None,
            requested_by_agent_id: None, requested_by_user_id: None, definition: serde_json::json!({}),
            continuation_mode: ContinuationMode::None, quality_action_id: None, quality_binding: None,
        };
        assert!(get_operator_decision_by_request_key(&mut tx, a, "k1").unwrap().is_none());
        let CreateOutcome::Created(created) = create_operator_decision(&mut tx, &mk("k1", "h1")).unwrap() else { panic!("first create must insert") };
        assert!(created.status == DecisionStatus::Pending && created.schema_version == SCHEMA_VERSION && created.created_at <= created.updated_at);
        let CreateOutcome::Replayed(replayed) = create_operator_decision(&mut tx, &mk("k1", "h1")).unwrap() else { panic!("same hash must replay") };
        assert_eq!(replayed.id, created.id);
        assert!(matches!(create_operator_decision(&mut tx, &mk("k1", "h2")), Err(DecisionDbError::RequestKeyConflict)));
        let result = serde_json::json!({"actionId": "a1"});
        let ResolutionOutcome::Applied(resolved) = resolve_operator_decision(&mut tx, created.id, a, &result, "u1").unwrap() else { panic!("resolve must apply") };
        assert_eq!((resolved.status, resolved.resolved_by_user_id.as_deref()), (DecisionStatus::Resolved, Some("u1")));
        assert!(resolved.resolved_at.is_some() && resolved.result.is_some());
        let ResolutionOutcome::AlreadyInTargetState(again) = resolve_operator_decision(&mut tx, created.id, a, &result, "u2").unwrap() else { panic!("resolve replay must be idempotent") };
        assert_eq!(again.resolved_by_user_id.as_deref(), Some("u1"));
        assert!(matches!(resolve_operator_decision(&mut tx, created.id, b, &result, "u3").unwrap(), ResolutionOutcome::NotFoundOrConflict));
        let CreateOutcome::Created(second) = create_operator_decision(&mut tx, &mk("k2", "h1")).unwrap() else { panic!("second create") };
        let cancelled = cancel_operator_decision(&mut tx, second.id, a).unwrap().unwrap();
        assert_eq!((cancelled.status, cancelled.cancelled_at.is_some()), (DecisionStatus::Cancelled, true));
        assert!(cancel_operator_decision(&mut tx, second.id, a).unwrap().is_none());
        assert!(get_operator_decision_by_id(&mut tx, created.id, b).unwrap().is_none());
        assert!(list_operator_decisions(&mut tx, a, Some(DecisionStatus::Pending), 100).unwrap().iter().all(|r| r.status == DecisionStatus::Pending));
        assert_eq!(list_operator_decisions(&mut tx, a, Some(DecisionStatus::Resolved), 100).unwrap().len(), 1);
        tx.rollback().unwrap();
    }
}

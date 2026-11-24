#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{
    ActivityDbError, ActorType, AppendActivityEventInput, OperatorDecisionStatus,
    ResolveOperatorDecisionInput,
};

#[derive(Debug, Clone)]
pub struct ActivityEventRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub actor_type: ActorType,
    pub actor_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub agent_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub details: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct OperatorDecisionRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub quality_action_id: Option<Uuid>,
    pub quality_binding: Option<serde_json::Value>,
    pub request_key: String,
    pub request_hash: String,
    pub schema_version: i32,
    pub status: OperatorDecisionStatus,
    pub priority: String,
    pub interaction_type: String,
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
    pub continuation_mode: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const SQL_APPEND_ACTIVITY_EVENT: &str = "INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details, created_at";
pub const SQL_LIST_ACTIVITY_EVENTS: &str = "SELECT id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details, created_at FROM activity_log WHERE company_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) AND ($3::text IS NULL OR entity_type = $3) AND ($4::text IS NULL OR entity_id = $4) ORDER BY created_at DESC, id DESC LIMIT $5";
pub const SQL_LIST_OPERATOR_DECISIONS: &str = "SELECT id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at FROM operator_decisions WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at ASC, id ASC LIMIT $3";
pub const SQL_RESOLVE_OPERATOR_DECISION_FENCED: &str = "UPDATE operator_decisions SET status = 'resolved', result = $3, resolved_by_user_id = $4, resolved_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING id, company_id, quality_action_id, quality_binding, request_key, request_hash, schema_version, status, priority, interaction_type, title, description, source_type, source_id, source_context, issue_id, requested_by_agent_id, requested_by_user_id, definition, result, resolved_by_user_id, resolved_at, cancelled_at, continuation_mode, created_at, updated_at";

fn cell<T: for<'a> postgres::types::FromSql<'a>>(
    row: &Row,
    idx: usize,
    column: &'static str,
) -> Result<T, ActivityDbError> {
    row.try_get(idx).map_err(|err| ActivityDbError::UndecodableRow {
        column: column.to_string(),
        detail: err.to_string(),
    })
}

// Column order for every activity_log SELECT/RETURNING (row indexes must match):
// 0 id, 1 company_id, 2 actor_type, 3 actor_id, 4 action, 5 entity_type,
// 6 entity_id, 7 agent_id, 8 run_id, 9 details, 10 created_at
fn activity_event_from_row(row: &Row) -> Result<ActivityEventRow, ActivityDbError> {
    let raw_actor_type: String = cell(row, 2, "actor_type")?;
    Ok(ActivityEventRow {
        id: cell(row, 0, "id")?,
        company_id: cell(row, 1, "company_id")?,
        actor_type: ActorType::parse(&raw_actor_type)?,
        actor_id: cell(row, 3, "actor_id")?,
        action: cell(row, 4, "action")?,
        entity_type: cell(row, 5, "entity_type")?,
        entity_id: cell(row, 6, "entity_id")?,
        agent_id: cell(row, 7, "agent_id")?,
        run_id: cell(row, 8, "run_id")?,
        details: cell(row, 9, "details")?,
        created_at: cell(row, 10, "created_at")?,
    })
}

// Column order for every operator_decisions SELECT/RETURNING (row indexes must match):
// 0 id, 1 company_id, 2 quality_action_id, 3 quality_binding, 4 request_key,
// 5 request_hash, 6 schema_version, 7 status, 8 priority, 9 interaction_type,
// 10 title, 11 description, 12 source_type, 13 source_id, 14 source_context,
// 15 issue_id, 16 requested_by_agent_id, 17 requested_by_user_id, 18 definition,
// 19 result, 20 resolved_by_user_id, 21 resolved_at, 22 cancelled_at,
// 23 continuation_mode, 24 created_at, 25 updated_at
fn operator_decision_from_row(row: &Row) -> Result<OperatorDecisionRow, ActivityDbError> {
    let raw_status: String = cell(row, 7, "status")?;
    Ok(OperatorDecisionRow {
        id: cell(row, 0, "id")?,
        company_id: cell(row, 1, "company_id")?,
        quality_action_id: cell(row, 2, "quality_action_id")?,
        quality_binding: cell(row, 3, "quality_binding")?,
        request_key: cell(row, 4, "request_key")?,
        request_hash: cell(row, 5, "request_hash")?,
        schema_version: cell(row, 6, "schema_version")?,
        status: OperatorDecisionStatus::parse(&raw_status)?,
        priority: cell(row, 8, "priority")?,
        interaction_type: cell(row, 9, "interaction_type")?,
        title: cell(row, 10, "title")?,
        description: cell(row, 11, "description")?,
        source_type: cell(row, 12, "source_type")?,
        source_id: cell(row, 13, "source_id")?,
        source_context: cell(row, 14, "source_context")?,
        issue_id: cell(row, 15, "issue_id")?,
        requested_by_agent_id: cell(row, 16, "requested_by_agent_id")?,
        requested_by_user_id: cell(row, 17, "requested_by_user_id")?,
        definition: cell(row, 18, "definition")?,
        result: cell(row, 19, "result")?,
        resolved_by_user_id: cell(row, 20, "resolved_by_user_id")?,
        resolved_at: cell(row, 21, "resolved_at")?,
        cancelled_at: cell(row, 22, "cancelled_at")?,
        continuation_mode: cell(row, 23, "continuation_mode")?,
        created_at: cell(row, 24, "created_at")?,
        updated_at: cell(row, 25, "updated_at")?,
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn append_activity_event(
    tx: &mut Transaction<'_>,
    input: &AppendActivityEventInput,
) -> Result<ActivityEventRow, ActivityDbError> {
    if input.actor_id.trim().is_empty() {
        return Err(ActivityDbError::EmptyActorId);
    }
    for (value, name) in [
        (&input.action, "action"),
        (&input.entity_type, "entity_type"),
        (&input.entity_id, "entity_id"),
    ] {
        if value.trim().is_empty() {
            return Err(ActivityDbError::EmptyField(name));
        }
    }
    if matches!(&input.details, Some(details) if !details.is_object()) {
        return Err(ActivityDbError::InvalidDetails);
    }
    let row = tx.query_one(
        SQL_APPEND_ACTIVITY_EVENT,
        &[
            &input.company_id,
            &input.actor_type.as_str(),
            &input.actor_id,
            &input.action,
            &input.entity_type,
            &input.entity_id,
            &input.agent_id,
            &input.run_id,
            &input.details,
        ],
    )?;
    activity_event_from_row(&row)
}

pub fn list_activity_events(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Option<Uuid>,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ActivityEventRow>, ActivityDbError> {
    let rows = tx.query(
        SQL_LIST_ACTIVITY_EVENTS,
        &[
            &company_id,
            &agent_id,
            &entity_type,
            &entity_id,
            &clamp_list_limit(limit),
        ],
    )?;
    rows.iter().map(activity_event_from_row).collect()
}

pub fn list_operator_decisions(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    status: Option<OperatorDecisionStatus>,
    limit: i64,
) -> Result<Vec<OperatorDecisionRow>, ActivityDbError> {
    let status = status.map(|s| s.as_str());
    let rows = tx.query(
        SQL_LIST_OPERATOR_DECISIONS,
        &[&company_id, &status, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(operator_decision_from_row).collect()
}

pub fn resolve_operator_decision_fenced(
    tx: &mut Transaction<'_>,
    input: &ResolveOperatorDecisionInput,
) -> Result<Option<OperatorDecisionRow>, ActivityDbError> {
    if input.resolved_by_user_id.trim().is_empty() {
        return Err(ActivityDbError::EmptyResolvedBy);
    }
    if !input.result.is_object() {
        return Err(ActivityDbError::InvalidDetails);
    }
    let updated = tx.query_opt(
        SQL_RESOLVE_OPERATOR_DECISION_FENCED,
        &[
            &input.decision_id,
            &input.company_id,
            &input.result,
            &input.resolved_by_user_id,
        ],
    )?;
    updated.map(|row| operator_decision_from_row(&row)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_SQL: [&str; 4] = [
        SQL_APPEND_ACTIVITY_EVENT,
        SQL_LIST_ACTIVITY_EVENTS,
        SQL_LIST_OPERATOR_DECISIONS,
        SQL_RESOLVE_OPERATOR_DECISION_FENCED,
    ];

    #[test]
    fn sql_is_parameterized_and_company_scoped() {
        for sql in ALL_SQL {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in &ALL_SQL[1..] {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
        assert!(SQL_APPEND_ACTIVITY_EVENT.contains("INSERT INTO activity_log (company_id,"));
    }

    #[test]
    fn append_sql_covers_every_column() {
        assert!(SQL_APPEND_ACTIVITY_EVENT.contains(
            "(company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details)"
        ));
        assert!(SQL_APPEND_ACTIVITY_EVENT.contains("RETURNING id, company_id,"));
        assert!(SQL_APPEND_ACTIVITY_EVENT.contains("details, created_at"));
    }

    #[test]
    fn list_activity_sql_is_filtered_and_newest_first() {
        assert!(SQL_LIST_ACTIVITY_EVENTS.contains("($2::uuid IS NULL OR agent_id = $2)"));
        assert!(SQL_LIST_ACTIVITY_EVENTS.contains("($3::text IS NULL OR entity_type = $3)"));
        assert!(SQL_LIST_ACTIVITY_EVENTS.contains("($4::text IS NULL OR entity_id = $4)"));
        assert!(SQL_LIST_ACTIVITY_EVENTS.contains("ORDER BY created_at DESC, id DESC"));
        assert!(SQL_LIST_ACTIVITY_EVENTS.contains("LIMIT $5"));
    }

    #[test]
    fn list_decisions_sql_is_fifo_with_optional_status() {
        assert!(SQL_LIST_OPERATOR_DECISIONS.contains("($2::text IS NULL OR status = $2)"));
        assert!(SQL_LIST_OPERATOR_DECISIONS.contains("ORDER BY created_at ASC, id ASC"));
        assert!(SQL_LIST_OPERATOR_DECISIONS.contains("LIMIT $3"));
    }

    #[test]
    fn resolve_sql_is_pending_fenced_and_company_scoped() {
        for needle in [
            "SET status = 'resolved'", "result = $3", "resolved_by_user_id = $4",
            "resolved_at = now()", "updated_at = now()",
            "WHERE id = $1 AND company_id = $2 AND status = 'pending'",
            "request_hash", "schema_version", "source_context", "continuation_mode", "cancelled_at",
        ] {
            assert!(SQL_RESOLVE_OPERATOR_DECISION_FENCED.contains(needle), "{needle}");
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

use chrono::{DateTime, Utc};
use postgres::{types::FromSql, Row, Transaction};
use uuid::Uuid;

use crate::{validate_agent_transition, AgentDbError, AgentStatus};

const AGENT_COLUMNS: &str = "id, company_id, name, role, title, icon, status, reports_to, capabilities, adapter_type, adapter_config, agent_config, runtime_config, budget_monthly_cents, spent_monthly_cents, pause_reason, paused_at, permissions, last_heartbeat_at, metadata, created_at, updated_at";

pub const SQL_GET_AGENT: &str = "SELECT id, company_id, name, role, title, icon, status, reports_to, capabilities, adapter_type, adapter_config, agent_config, runtime_config, budget_monthly_cents, spent_monthly_cents, pause_reason, paused_at, permissions, last_heartbeat_at, metadata, created_at, updated_at FROM agents WHERE company_id = $1 AND id = $2";
pub const SQL_LIST_AGENTS_BY_COMPANY: &str = "SELECT id, company_id, name, role, title, icon, status, reports_to, capabilities, adapter_type, adapter_config, agent_config, runtime_config, budget_monthly_cents, spent_monthly_cents, pause_reason, paused_at, permissions, last_heartbeat_at, metadata, created_at, updated_at FROM agents WHERE company_id = $1 ORDER BY created_at ASC, id ASC";
pub const SQL_LIST_AGENT_TASK_SESSIONS: &str = "SELECT id, company_id, agent_id, adapter_type, task_key, session_params_json, session_display_id, last_run_id, last_error, created_at, updated_at FROM agent_task_sessions WHERE company_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY updated_at DESC, id ASC";
pub const SQL_LIST_AGENT_TOOL_GRANTS: &str = "SELECT id, company_id, agent_id, tool_id, granted_by, created_at FROM agent_tool_grants WHERE company_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY created_at ASC, id ASC";

// Side columns mirror server/src/services/agents.ts: targeting paused stamps
// pause_reason (COALESCE provided, 'manual') and paused_at = now(); every other
// target clears both (resume and terminate semantics).
fn transition_sql(target: AgentStatus) -> String {
    let side_columns = if target == AgentStatus::Paused {
        "pause_reason = COALESCE($5, 'manual'), paused_at = now()"
    } else {
        "pause_reason = NULL, paused_at = NULL"
    };
    format!("UPDATE agents SET status = $4, updated_at = now(), {side_columns} WHERE company_id = $1 AND id = $2 AND status = $3 RETURNING {AGENT_COLUMNS}")
}

#[derive(Debug, Clone)]
pub struct AgentRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub name: String,
    pub role: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub status: AgentStatus,
    pub reports_to: Option<Uuid>,
    pub capabilities: Option<String>,
    pub adapter_type: String,
    pub adapter_config: serde_json::Value,
    pub agent_config: serde_json::Value,
    pub runtime_config: serde_json::Value,
    pub budget_monthly_cents: i32,
    pub spent_monthly_cents: i32,
    pub pause_reason: Option<String>,
    pub paused_at: Option<DateTime<Utc>>,
    pub permissions: serde_json::Value,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AgentTaskSessionRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub adapter_type: String,
    pub task_key: String,
    pub session_params_json: Option<serde_json::Value>,
    pub session_display_id: Option<String>,
    pub last_run_id: Option<Uuid>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AgentToolGrantRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub tool_id: Uuid,
    pub granted_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct TransitionAgentStatusInput {
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub from_status: AgentStatus,
    pub to_status: AgentStatus,
    pub pause_reason: Option<String>,
}

fn col<'a, T: FromSql<'a>>(row: &'a Row, name: &'static str) -> Result<T, AgentDbError> {
    row.try_get(name)
        .map_err(|e| AgentDbError::UndecodableRow {
            column: name,
            detail: e.to_string(),
        })
}

fn agent_from_row(row: &Row) -> Result<AgentRow, AgentDbError> {
    Ok(AgentRow {
        id: col(row, "id")?,
        company_id: col(row, "company_id")?,
        name: col(row, "name")?,
        role: col(row, "role")?,
        title: col(row, "title")?,
        icon: col(row, "icon")?,
        status: AgentStatus::parse(&col::<String>(row, "status")?)?,
        reports_to: col(row, "reports_to")?,
        capabilities: col(row, "capabilities")?,
        adapter_type: col(row, "adapter_type")?,
        adapter_config: col(row, "adapter_config")?,
        agent_config: col(row, "agent_config")?,
        runtime_config: col(row, "runtime_config")?,
        budget_monthly_cents: col(row, "budget_monthly_cents")?,
        spent_monthly_cents: col(row, "spent_monthly_cents")?,
        pause_reason: col(row, "pause_reason")?,
        paused_at: col(row, "paused_at")?,
        permissions: col(row, "permissions")?,
        last_heartbeat_at: col(row, "last_heartbeat_at")?,
        metadata: col(row, "metadata")?,
        created_at: col(row, "created_at")?,
        updated_at: col(row, "updated_at")?,
    })
}

fn agent_task_session_from_row(row: &Row) -> Result<AgentTaskSessionRow, AgentDbError> {
    Ok(AgentTaskSessionRow {
        id: col(row, "id")?,
        company_id: col(row, "company_id")?,
        agent_id: col(row, "agent_id")?,
        adapter_type: col(row, "adapter_type")?,
        task_key: col(row, "task_key")?,
        session_params_json: col(row, "session_params_json")?,
        session_display_id: col(row, "session_display_id")?,
        last_run_id: col(row, "last_run_id")?,
        last_error: col(row, "last_error")?,
        created_at: col(row, "created_at")?,
        updated_at: col(row, "updated_at")?,
    })
}

fn agent_tool_grant_from_row(row: &Row) -> Result<AgentToolGrantRow, AgentDbError> {
    Ok(AgentToolGrantRow {
        id: col(row, "id")?,
        company_id: col(row, "company_id")?,
        agent_id: col(row, "agent_id")?,
        tool_id: col(row, "tool_id")?,
        granted_by: col(row, "granted_by")?,
        created_at: col(row, "created_at")?,
    })
}

pub fn get_agent(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Uuid,
) -> Result<Option<AgentRow>, AgentDbError> {
    let row = tx.query_opt(SQL_GET_AGENT, &[&company_id, &agent_id])?;
    row.map(|r| agent_from_row(&r)).transpose()
}

pub fn list_agents_by_company(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
) -> Result<Vec<AgentRow>, AgentDbError> {
    let rows = tx.query(SQL_LIST_AGENTS_BY_COMPANY, &[&company_id])?;
    rows.iter().map(agent_from_row).collect()
}

pub fn transition_agent_status_fenced(
    tx: &mut Transaction<'_>,
    input: &TransitionAgentStatusInput,
) -> Result<AgentRow, AgentDbError> {
    validate_agent_transition(input.from_status, input.to_status)?;
    let row = tx.query_opt(
        &transition_sql(input.to_status),
        &[
            &input.company_id,
            &input.agent_id,
            &input.from_status.as_str(),
            &input.to_status.as_str(),
            &input.pause_reason,
        ],
    )?;
    agent_from_row(&row.ok_or(AgentDbError::Fenced)?)
}

pub fn list_agent_task_sessions(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Option<Uuid>,
) -> Result<Vec<AgentTaskSessionRow>, AgentDbError> {
    let rows = tx.query(SQL_LIST_AGENT_TASK_SESSIONS, &[&company_id, &agent_id])?;
    rows.iter().map(agent_task_session_from_row).collect()
}

pub fn list_agent_tool_grants(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Option<Uuid>,
) -> Result<Vec<AgentToolGrantRow>, AgentDbError> {
    let rows = tx.query(SQL_LIST_AGENT_TOOL_GRANTS, &[&company_id, &agent_id])?;
    rows.iter().map(agent_tool_grant_from_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ALL_STATUSES;

    #[test]
    fn every_statement_is_company_scoped_and_parameterized() {
        for sql in [
            SQL_GET_AGENT,
            SQL_LIST_AGENTS_BY_COMPANY,
            SQL_LIST_AGENT_TASK_SESSIONS,
            SQL_LIST_AGENT_TOOL_GRANTS,
        ] {
            assert!(sql.contains("company_id = $1"), "{sql}");
            assert!(sql.contains('$'));
            assert!(!sql.contains("${"), "{sql}");
        }
        assert!(SQL_GET_AGENT.contains("AND id = $2"));
        for sql in [SQL_LIST_AGENT_TASK_SESSIONS, SQL_LIST_AGENT_TOOL_GRANTS] {
            assert!(sql.contains("($2::uuid IS NULL OR agent_id = $2)"), "{sql}");
            assert!(sql.contains("ORDER BY"), "{sql}");
        }
        assert!(SQL_LIST_AGENTS_BY_COMPANY.contains("ORDER BY created_at ASC, id ASC"));
        assert!(SQL_LIST_AGENT_TASK_SESSIONS.contains("FROM agent_task_sessions"));
        assert!(SQL_LIST_AGENT_TOOL_GRANTS.contains("FROM agent_tool_grants"));
    }

    #[test]
    fn transition_set_list_mirrors_ts_side_columns() {
        let paused = transition_sql(AgentStatus::Paused);
        assert!(paused.contains("pause_reason = COALESCE($5, 'manual')"), "{paused}");
        assert!(paused.contains("paused_at = now()"), "{paused}");
        for target in ALL_STATUSES {
            if target == AgentStatus::Paused {
                continue;
            }
            let sql = transition_sql(target);
            assert!(sql.contains("pause_reason = NULL, paused_at = NULL"), "{sql}");
            assert!(!sql.contains("COALESCE"), "{sql}");
        }
        for target in ALL_STATUSES {
            let sql = transition_sql(target);
            assert!(sql.contains("UPDATE agents SET status = $4, updated_at = now(),"), "{sql}");
            assert!(sql.contains("WHERE company_id = $1 AND id = $2 AND status = $3"), "{sql}");
            assert!(sql.contains("RETURNING id, company_id"), "{sql}");
        }
    }

    #[test]
    fn status_decode_is_fail_closed() {
        assert!(matches!(
            AgentStatus::parse("archived"),
            Err(AgentDbError::InvalidStatus(raw)) if raw == "archived"
        ));
        assert!(matches!(
            AgentStatus::parse(""),
            Err(AgentDbError::InvalidStatus(_))
        ));
    }
}

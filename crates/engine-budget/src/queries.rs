use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    BudgetDbError, BudgetIncidentStatus, BudgetScopeType, BudgetThresholdType, BudgetWindowKind,
};

pub const SQL_INSERT_COST_EVENT: &str = "INSERT INTO cost_events (company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at, created_at";

pub const SQL_SUM_SCOPE_SPEND_COMPANY: &str = "SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM cost_events WHERE company_id = $1 AND occurred_at >= $2 AND occurred_at < $3";
pub const SQL_SUM_SCOPE_SPEND_AGENT: &str = "SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM cost_events WHERE company_id = $1 AND agent_id = $2 AND occurred_at >= $3 AND occurred_at < $4";
pub const SQL_SUM_SCOPE_SPEND_PROJECT: &str = "SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM cost_events WHERE company_id = $1 AND project_id = $2 AND occurred_at >= $3 AND occurred_at < $4";

pub const SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE: &str = "SELECT id, company_id, scope_type, scope_id, metric, window_kind, amount, warn_percent, hard_stop_enabled, notify_enabled, is_active, created_by_user_id, updated_by_user_id, created_at, updated_at FROM budget_policies WHERE company_id = $1 AND scope_type = $2 AND scope_id = $3 AND is_active = true ORDER BY updated_at DESC, id ASC";

pub const SQL_UPSERT_OPEN_INCIDENT: &str = "INSERT INTO budget_incidents (company_id, policy_id, scope_type, scope_id, metric, window_kind, window_start, window_end, threshold_type, amount_limit, amount_observed, status, approval_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12) ON CONFLICT (policy_id, window_start, threshold_type) WHERE status <> 'dismissed' DO UPDATE SET amount_observed = EXCLUDED.amount_observed, amount_limit = EXCLUDED.amount_limit, updated_at = now() RETURNING id, company_id, policy_id, scope_type, scope_id, metric, window_kind, window_start, window_end, threshold_type, amount_limit, amount_observed, status, approval_id, resolved_at, created_at, updated_at";

pub const SQL_RESOLVE_INCIDENT_FENCED: &str = "UPDATE budget_incidents SET status = $3, resolved_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'open' RETURNING id, company_id, policy_id, scope_type, scope_id, metric, window_kind, window_start, window_end, threshold_type, amount_limit, amount_observed, status, approval_id, resolved_at, created_at, updated_at";

fn cents_to_db(field: &'static str, value: i64) -> Result<i32, BudgetDbError> {
    i32::try_from(value)
        .ok()
        .filter(|v| *v >= 0)
        .ok_or(BudgetDbError::InvalidAmount { field, value })
}

#[derive(Debug)]
pub struct RecordCostEventInput {
    pub company_id: Uuid, pub agent_id: Uuid,
    pub issue_id: Option<Uuid>, pub project_id: Option<Uuid>, pub goal_id: Option<Uuid>,
    pub heartbeat_run_id: Option<Uuid>, pub billing_code: Option<String>,
    pub provider: String, pub biller: Option<String>, pub billing_type: Option<String>,
    pub model: String,
    pub input_tokens: i32, pub cached_input_tokens: i32, pub output_tokens: i32,
    pub cost_cents: i64, pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostEventRow {
    pub id: Uuid, pub company_id: Uuid, pub agent_id: Uuid,
    pub issue_id: Option<Uuid>, pub project_id: Option<Uuid>, pub goal_id: Option<Uuid>,
    pub heartbeat_run_id: Option<Uuid>, pub billing_code: Option<String>,
    pub provider: String, pub biller: String, pub billing_type: String, pub model: String,
    pub input_tokens: i32, pub cached_input_tokens: i32, pub output_tokens: i32,
    pub cost_cents: i32, pub occurred_at: DateTime<Utc>, pub created_at: DateTime<Utc>,
}

fn cost_event_row(row: &Row) -> CostEventRow {
    CostEventRow {
        id: row.get(0), company_id: row.get(1), agent_id: row.get(2),
        issue_id: row.get(3), project_id: row.get(4), goal_id: row.get(5),
        heartbeat_run_id: row.get(6), billing_code: row.get(7), provider: row.get(8),
        biller: row.get(9), billing_type: row.get(10), model: row.get(11),
        input_tokens: row.get(12), cached_input_tokens: row.get(13), output_tokens: row.get(14),
        cost_cents: row.get(15), occurred_at: row.get(16), created_at: row.get(17),
    }
}

pub fn record_cost_event(
    tx: &mut Transaction<'_>,
    input: &RecordCostEventInput,
) -> Result<CostEventRow, BudgetDbError> {
    let cost_cents = cents_to_db("cost_cents", input.cost_cents)?;
    let biller = input.biller.as_deref().unwrap_or(input.provider.as_str());
    let billing_type = input.billing_type.as_deref().unwrap_or("unknown");
    let row = tx.query_one(
        SQL_INSERT_COST_EVENT,
        &[
            &input.company_id, &input.agent_id, &input.issue_id, &input.project_id,
            &input.goal_id, &input.heartbeat_run_id, &input.billing_code, &input.provider,
            &biller, &billing_type, &input.model,
            &input.input_tokens, &input.cached_input_tokens, &input.output_tokens,
            &cost_cents, &input.occurred_at,
        ],
    )?;
    Ok(cost_event_row(&row))
}

pub fn sum_scope_spend(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    scope_type: BudgetScopeType,
    scope_id: Uuid,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Result<i64, BudgetDbError> {
    if window_end <= window_start {
        return Err(BudgetDbError::InvalidWindow { window_start, window_end });
    }
    let row = match scope_type {
        BudgetScopeType::Company => {
            if scope_id != company_id {
                return Err(BudgetDbError::InvalidScope { scope_type, scope_id, company_id });
            }
            tx.query_one(
                SQL_SUM_SCOPE_SPEND_COMPANY,
                &[&company_id, &window_start, &window_end],
            )?
        }
        BudgetScopeType::Agent => tx.query_one(
            SQL_SUM_SCOPE_SPEND_AGENT,
            &[&company_id, &scope_id, &window_start, &window_end],
        )?,
        BudgetScopeType::Project => tx.query_one(
            SQL_SUM_SCOPE_SPEND_PROJECT,
            &[&company_id, &scope_id, &window_start, &window_end],
        )?,
    };
    Ok(row.get(0))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetPolicyRow {
    pub id: Uuid, pub company_id: Uuid,
    pub scope_type: String, pub scope_id: Uuid,
    pub metric: String, pub window_kind: String,
    pub amount: i32, pub warn_percent: i32,
    pub hard_stop_enabled: bool, pub notify_enabled: bool, pub is_active: bool,
    pub created_by_user_id: Option<String>, pub updated_by_user_id: Option<String>,
    pub created_at: DateTime<Utc>, pub updated_at: DateTime<Utc>,
}

fn policy_row(row: &Row) -> BudgetPolicyRow {
    BudgetPolicyRow {
        id: row.get(0), company_id: row.get(1),
        scope_type: row.get(2), scope_id: row.get(3),
        metric: row.get(4), window_kind: row.get(5),
        amount: row.get(6), warn_percent: row.get(7),
        hard_stop_enabled: row.get(8), notify_enabled: row.get(9), is_active: row.get(10),
        created_by_user_id: row.get(11), updated_by_user_id: row.get(12),
        created_at: row.get(13), updated_at: row.get(14),
    }
}

pub fn list_active_policies_for_scope(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    scope_type: BudgetScopeType,
    scope_id: Uuid,
) -> Result<Vec<BudgetPolicyRow>, BudgetDbError> {
    let rows = tx.query(
        SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE,
        &[&company_id, &scope_type.as_str(), &scope_id],
    )?;
    Ok(rows.iter().map(policy_row).collect())
}

#[derive(Debug)]
pub struct UpsertIncidentInput {
    pub company_id: Uuid, pub policy_id: Uuid,
    pub scope_type: BudgetScopeType, pub scope_id: Uuid,
    pub metric: String, pub window_kind: BudgetWindowKind,
    pub window_start: DateTime<Utc>, pub window_end: DateTime<Utc>,
    pub threshold_type: BudgetThresholdType,
    pub amount_limit: i64, pub amount_observed: i64,
    pub approval_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetIncidentRow {
    pub id: Uuid, pub company_id: Uuid, pub policy_id: Uuid,
    pub scope_type: String, pub scope_id: Uuid, pub metric: String, pub window_kind: String,
    pub window_start: DateTime<Utc>, pub window_end: DateTime<Utc>,
    pub threshold_type: String, pub amount_limit: i32, pub amount_observed: i32,
    pub status: String, pub approval_id: Option<Uuid>, pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>, pub updated_at: DateTime<Utc>,
}

fn incident_row(row: &Row) -> BudgetIncidentRow {
    BudgetIncidentRow {
        id: row.get(0), company_id: row.get(1), policy_id: row.get(2),
        scope_type: row.get(3), scope_id: row.get(4), metric: row.get(5), window_kind: row.get(6),
        window_start: row.get(7), window_end: row.get(8),
        threshold_type: row.get(9), amount_limit: row.get(10), amount_observed: row.get(11),
        status: row.get(12), approval_id: row.get(13), resolved_at: row.get(14),
        created_at: row.get(15), updated_at: row.get(16),
    }
}

pub fn upsert_open_incident_fenced(
    tx: &mut Transaction<'_>,
    input: &UpsertIncidentInput,
) -> Result<BudgetIncidentRow, BudgetDbError> {
    if input.window_end <= input.window_start {
        return Err(BudgetDbError::InvalidWindow {
            window_start: input.window_start,
            window_end: input.window_end,
        });
    }
    let amount_limit = cents_to_db("amount_limit", input.amount_limit)?;
    let amount_observed = cents_to_db("amount_observed", input.amount_observed)?;
    let row = tx.query_one(
        SQL_UPSERT_OPEN_INCIDENT,
        &[
            &input.company_id, &input.policy_id, &input.scope_type.as_str(), &input.scope_id,
            &input.metric, &input.window_kind.as_str(), &input.window_start, &input.window_end,
            &input.threshold_type.as_str(), &amount_limit, &amount_observed, &input.approval_id,
        ],
    )?;
    Ok(incident_row(&row))
}

pub fn resolve_incident_fenced(
    tx: &mut Transaction<'_>,
    incident_id: Uuid,
    company_id: Uuid,
    target_status: BudgetIncidentStatus,
) -> Result<Option<BudgetIncidentRow>, BudgetDbError> {
    crate::validate_incident_transition(BudgetIncidentStatus::Open, target_status)?;
    let row = tx.query_opt(
        SQL_RESOLVE_INCIDENT_FENCED,
        &[&incident_id, &company_id, &target_status.as_str()],
    )?;
    Ok(row.as_ref().map(incident_row))
}

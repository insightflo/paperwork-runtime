use chrono::{DateTime, Utc};
use postgres::{types::FromSql, Row, Transaction};
use uuid::Uuid;

use crate::{IssueDbError, IssuePriority, IssueStatus};

#[derive(Debug, Clone)]
pub struct Issue {
    pub id: Uuid,
    pub company_id: Uuid,
    pub project_id: Option<Uuid>,
    pub mission_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    pub status: IssueStatus,
    pub priority: IssuePriority,
    pub assignee_agent_id: Option<Uuid>,
    pub assignee_user_id: Option<String>,
    pub checkout_run_id: Option<Uuid>,
    pub execution_run_id: Option<Uuid>,
    pub execution_agent_name_key: Option<String>,
    pub execution_locked_at: Option<DateTime<Utc>>,
    pub created_by_agent_id: Option<Uuid>,
    pub created_by_user_id: Option<String>,
    pub issue_number: Option<i32>,
    pub identifier: Option<String>,
    pub origin_kind: String,
    pub origin_id: Option<String>,
    pub origin_run_id: Option<String>,
    pub request_depth: i32,
    pub billing_code: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub cancelled_at: Option<DateTime<Utc>>,
    pub hidden_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct IssueWorkProduct {
    pub id: Uuid,
    pub company_id: Uuid,
    pub project_id: Option<Uuid>,
    pub issue_id: Uuid,
    pub execution_workspace_id: Option<Uuid>,
    pub runtime_service_id: Option<Uuid>,
    pub work_product_type: String,
    pub provider: String,
    pub external_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub status: String,
    pub review_state: String,
    pub is_primary: bool,
    pub health_status: String,
    pub summary: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_by_run_id: Option<Uuid>,
    pub source_execution_generation: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const SQL_GET_ISSUE_BY_ID: &str = "SELECT id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at FROM issues WHERE id = $1";
pub const SQL_LOCK_ISSUE_FOR_UPDATE: &str = "SELECT id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at FROM issues WHERE id = $1 FOR UPDATE";
pub const SQL_LIST_ISSUES_BY_COMPANY: &str = "SELECT id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at FROM issues WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2";
pub const SQL_CHECKOUT_ISSUE_FENCED: &str = "UPDATE issues SET assignee_agent_id = $3, assignee_user_id = NULL, checkout_run_id = $4, execution_run_id = $4, execution_agent_name_key = COALESCE($5, execution_agent_name_key), execution_locked_at = now(), status = 'in_progress', started_at = now(), completed_at = NULL, cancelled_at = NULL, updated_at = now() WHERE id = $2 AND company_id = $1 AND status = ANY($6::text[]) AND (assignee_agent_id IS NULL OR assignee_agent_id = $3) AND (checkout_run_id IS NULL OR checkout_run_id = $4) AND (execution_run_id IS NULL OR execution_run_id = $4) AND EXISTS (SELECT 1 FROM agents a WHERE a.id = $3 AND a.company_id = $1) RETURNING id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at";
pub const SQL_TRANSITION_ISSUE_STATUS_FENCED: &str = "UPDATE issues SET status = $4, started_at = CASE WHEN $4 = 'in_progress' THEN now() ELSE started_at END, completed_at = CASE WHEN $4 = 'done' THEN now() ELSE NULL END, cancelled_at = CASE WHEN $4 = 'cancelled' THEN now() ELSE NULL END, checkout_run_id = CASE WHEN $4 = 'in_progress' THEN checkout_run_id ELSE NULL END, execution_run_id = CASE WHEN $4 = 'in_progress' THEN execution_run_id ELSE NULL END, execution_agent_name_key = CASE WHEN $4 = 'in_progress' THEN execution_agent_name_key ELSE NULL END, execution_locked_at = CASE WHEN $4 = 'in_progress' THEN execution_locked_at ELSE NULL END, updated_at = now() WHERE id = $2 AND company_id = $1 AND status = $3 RETURNING id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at";
pub const SQL_RELEASE_ISSUE_CHECKOUT_FENCED: &str = "UPDATE issues SET checkout_run_id = NULL, execution_run_id = NULL, execution_agent_name_key = NULL, execution_locked_at = NULL, updated_at = now() WHERE id = $2 AND company_id = $1 AND (checkout_run_id IS NULL OR checkout_run_id = $3) AND (execution_run_id IS NULL OR execution_run_id = $3) AND (checkout_run_id = $3 OR execution_run_id = $3) RETURNING id, company_id, project_id, mission_id, parent_id, title, description, status, priority, assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id, execution_agent_name_key, execution_locked_at, created_by_agent_id, created_by_user_id, issue_number, identifier, origin_kind, origin_id, origin_run_id, request_depth, billing_code, started_at, completed_at, cancelled_at, hidden_at, created_at, updated_at";
pub const SQL_LIST_ISSUE_WORK_PRODUCTS: &str = "SELECT id, company_id, project_id, issue_id, execution_workspace_id, runtime_service_id, type, provider, external_id, title, url, status, review_state, is_primary, health_status, summary, metadata, created_by_run_id, source_execution_generation, created_at, updated_at FROM issue_work_products WHERE company_id = $1 AND issue_id = $2 ORDER BY created_at ASC, id ASC";

fn req<'a, T: FromSql<'a>>(row: &'a Row, col: &'static str) -> Result<T, IssueDbError> {
    row.try_get::<&str, T>(col)
        .map_err(|_| IssueDbError::UndecodableRow(col))
}

macro_rules! decode_row {
    ($row:expr, $t:ident, { $($init:tt)* }, $( $col:ident ),+ $(,)?) => {
        $t { $($init)* $( $col: req($row, stringify!($col))?, )+ }
    };
}

fn issue_from_row(row: &Row) -> Result<Issue, IssueDbError> {
    Ok(decode_row!(row, Issue, {
        status: IssueStatus::parse(&req::<String>(row, "status")?)?,
        priority: IssuePriority::parse(&req::<String>(row, "priority")?)?,
    },
        id, company_id, project_id, mission_id, parent_id, title, description,
        assignee_agent_id, assignee_user_id, checkout_run_id, execution_run_id,
        execution_agent_name_key, execution_locked_at, created_by_agent_id,
        created_by_user_id, issue_number, identifier, origin_kind, origin_id,
        origin_run_id, request_depth, billing_code, started_at, completed_at,
        cancelled_at, hidden_at, created_at, updated_at
    ))
}

fn work_product_from_row(row: &Row) -> Result<IssueWorkProduct, IssueDbError> {
    Ok(decode_row!(row, IssueWorkProduct, {
        work_product_type: req(row, "type")?,
    },
        id, company_id, project_id, issue_id, execution_workspace_id,
        runtime_service_id, provider, external_id, title, url, status, review_state,
        is_primary, health_status, summary, metadata, created_by_run_id,
        source_execution_generation, created_at, updated_at
    ))
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn get_issue(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
) -> Result<Issue, IssueDbError> {
    let row = tx
        .query_opt(SQL_GET_ISSUE_BY_ID, &[&issue_id])?
        .ok_or(IssueDbError::NotFound)?;
    let issue = issue_from_row(&row)?;
    if issue.company_id != company_id {
        return Err(IssueDbError::CompanyMismatch);
    }
    Ok(issue)
}

pub fn list_issues_by_company(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    limit: i64,
) -> Result<Vec<Issue>, IssueDbError> {
    let rows = tx.query(
        SQL_LIST_ISSUES_BY_COMPANY,
        &[&company_id, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(issue_from_row).collect()
}

fn lock_issue_for_update(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
) -> Result<Issue, IssueDbError> {
    let row = tx
        .query_opt(SQL_LOCK_ISSUE_FOR_UPDATE, &[&issue_id])?
        .ok_or(IssueDbError::NotFound)?;
    let issue = issue_from_row(&row)?;
    if issue.company_id != company_id {
        return Err(IssueDbError::CompanyMismatch);
    }
    Ok(issue)
}

pub fn checkout_issue_fenced(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
    agent_id: Uuid,
    run_id: Uuid,
    agent_name_key: Option<&str>,
    expected_statuses: &[IssueStatus],
) -> Result<Issue, IssueDbError> {
    let locked = lock_issue_for_update(tx, company_id, issue_id)?;
    if !expected_statuses.contains(&locked.status)
        || locked.assignee_agent_id.is_some_and(|a| a != agent_id)
        || locked.checkout_run_id.is_some_and(|r| r != run_id)
        || locked.execution_run_id.is_some_and(|r| r != run_id)
    {
        return Err(IssueDbError::Fenced);
    }
    let expected: Vec<&str> = expected_statuses.iter().map(|s| s.as_str()).collect();
    let row = tx
        .query_opt(
            SQL_CHECKOUT_ISSUE_FENCED,
            &[&company_id, &issue_id, &agent_id, &run_id, &agent_name_key, &expected],
        )?
        .ok_or(IssueDbError::Fenced)?;
    issue_from_row(&row)
}

pub fn transition_issue_status_fenced(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
    expected_status: IssueStatus,
    new_status: IssueStatus,
) -> Result<Issue, IssueDbError> {
    let locked = lock_issue_for_update(tx, company_id, issue_id)?;
    if locked.status != expected_status {
        return Err(IssueDbError::Fenced);
    }
    let row = tx
        .query_opt(
            SQL_TRANSITION_ISSUE_STATUS_FENCED,
            &[
                &company_id,
                &issue_id,
                &expected_status.as_str(),
                &new_status.as_str(),
            ],
        )?
        .ok_or(IssueDbError::Fenced)?;
    issue_from_row(&row)
}

pub fn release_issue_checkout_fenced(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
    run_id: Uuid,
) -> Result<Issue, IssueDbError> {
    let row = tx
        .query_opt(
            SQL_RELEASE_ISSUE_CHECKOUT_FENCED,
            &[&company_id, &issue_id, &run_id],
        )?
        .ok_or(IssueDbError::Fenced)?;
    issue_from_row(&row)
}

pub fn list_issue_work_products(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    issue_id: Uuid,
) -> Result<Vec<IssueWorkProduct>, IssueDbError> {
    let rows = tx.query(SQL_LIST_ISSUE_WORK_PRODUCTS, &[&company_id, &issue_id])?;
    rows.iter().map(work_product_from_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_constants_are_parameterized_and_company_scoped() {
        for sql in [
            SQL_GET_ISSUE_BY_ID,
            SQL_LOCK_ISSUE_FOR_UPDATE,
            SQL_LIST_ISSUES_BY_COMPANY,
            SQL_CHECKOUT_ISSUE_FENCED,
            SQL_TRANSITION_ISSUE_STATUS_FENCED,
            SQL_RELEASE_ISSUE_CHECKOUT_FENCED,
            SQL_LIST_ISSUE_WORK_PRODUCTS,
        ] {
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in [
            SQL_LIST_ISSUES_BY_COMPANY,
            SQL_CHECKOUT_ISSUE_FENCED,
            SQL_TRANSITION_ISSUE_STATUS_FENCED,
            SQL_RELEASE_ISSUE_CHECKOUT_FENCED,
            SQL_LIST_ISSUE_WORK_PRODUCTS,
        ] {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
        for sql in [SQL_GET_ISSUE_BY_ID, SQL_LOCK_ISSUE_FOR_UPDATE] {
            assert!(sql.starts_with("SELECT id, company_id"), "{sql}");
            assert!(sql.contains("FROM issues WHERE id = $1"), "{sql}");
        }
        assert!(SQL_LOCK_ISSUE_FOR_UPDATE.ends_with("FOR UPDATE"));
        assert!(SQL_LIST_ISSUES_BY_COMPANY.contains("ORDER BY created_at DESC"));
        assert!(SQL_LIST_ISSUE_WORK_PRODUCTS.contains("ORDER BY created_at ASC"));
        assert!(SQL_LIST_ISSUE_WORK_PRODUCTS.contains("issue_id = $2"));
        assert!(SQL_CHECKOUT_ISSUE_FENCED.contains("status = 'in_progress'"));
        assert!(SQL_CHECKOUT_ISSUE_FENCED.contains("started_at = now()"));
        assert!(SQL_CHECKOUT_ISSUE_FENCED.contains("execution_locked_at = now()"));
        assert!(SQL_CHECKOUT_ISSUE_FENCED.contains("status = ANY("));
        assert!(SQL_CHECKOUT_ISSUE_FENCED.contains("EXISTS (SELECT 1 FROM agents a"));
        assert!(SQL_TRANSITION_ISSUE_STATUS_FENCED.contains("status = $3"));
        assert!(SQL_TRANSITION_ISSUE_STATUS_FENCED.contains("completed_at = CASE WHEN $4 = 'done' THEN now() ELSE NULL END"));
        assert!(SQL_TRANSITION_ISSUE_STATUS_FENCED.contains("cancelled_at = CASE WHEN $4 = 'cancelled' THEN now() ELSE NULL END"));
        assert!(SQL_RELEASE_ISSUE_CHECKOUT_FENCED.contains("checkout_run_id = $3 OR execution_run_id = $3"));
        assert!(SQL_RELEASE_ISSUE_CHECKOUT_FENCED.contains("RETURNING"));
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(-9), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(10_000), 200);
    }
}

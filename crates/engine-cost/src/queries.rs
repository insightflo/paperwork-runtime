#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{validate_cost_cents, validate_cost_window, BillingType, CostDbError};

pub const SQL_INSERT_COST_EVENT: &str = "INSERT INTO cost_events (company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = $2 AND a.company_id = $1) AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM issues t WHERE t.id = $3 AND t.company_id = $1)) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM projects t WHERE t.id = $4 AND t.company_id = $1)) AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM goals t WHERE t.id = $5 AND t.company_id = $1)) AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs t WHERE t.id = $6 AND t.company_id = $1)) RETURNING id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at, created_at";
pub const SQL_LIST_COST_EVENTS: &str = "SELECT id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at, created_at FROM cost_events WHERE company_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) AND ($3::timestamptz IS NULL OR occurred_at >= $3) AND ($4::timestamptz IS NULL OR occurred_at <= $4) ORDER BY occurred_at DESC, id DESC LIMIT $5";
pub const SQL_SUM_COMPANY_COST_WINDOW: &str = "SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM cost_events WHERE company_id = $1 AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at <= $3)";
pub const SQL_GET_COMPANY_SPEND_SNAPSHOT: &str = "SELECT id, budget_monthly_cents, spent_monthly_cents FROM companies WHERE id = $1";

#[derive(Debug)]
pub struct RecordCostEventInput {
    pub company_id: Uuid, pub agent_id: Uuid,
    pub issue_id: Option<Uuid>, pub project_id: Option<Uuid>, pub goal_id: Option<Uuid>,
    pub heartbeat_run_id: Option<Uuid>, pub billing_code: Option<String>,
    pub provider: String, pub biller: Option<String>, pub billing_type: Option<BillingType>,
    pub model: String,
    pub input_tokens: i32, pub cached_input_tokens: i32, pub output_tokens: i32,
    pub cost_cents: i64, pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostEventRow {
    pub id: Uuid, pub company_id: Uuid, pub agent_id: Uuid,
    pub issue_id: Option<Uuid>, pub project_id: Option<Uuid>, pub goal_id: Option<Uuid>,
    pub heartbeat_run_id: Option<Uuid>, pub billing_code: Option<String>,
    pub provider: String, pub biller: String, pub billing_type: BillingType, pub model: String,
    pub input_tokens: i32, pub cached_input_tokens: i32, pub output_tokens: i32,
    pub cost_cents: i32, pub occurred_at: DateTime<Utc>, pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompanySpendSnapshotRow {
    pub company_id: Uuid, pub budget_monthly_cents: i32, pub spent_monthly_cents: i32,
}

fn get_col<T>(row: &Row, idx: usize, column: &'static str) -> Result<T, CostDbError>
where
    T: for<'a> postgres::types::FromSql<'a>,
{
    row.try_get(idx).map_err(|err| CostDbError::UndecodableRow {
        column: column.to_string(),
        detail: err.to_string(),
    })
}

// column order shared by SQL_INSERT_COST_EVENT RETURNING and SQL_LIST_COST_EVENTS:
// 0 id, 1 company_id, 2 agent_id, 3 issue_id, 4 project_id, 5 goal_id,
// 6 heartbeat_run_id, 7 billing_code, 8 provider, 9 biller, 10 billing_type,
// 11 model, 12 input_tokens, 13 cached_input_tokens, 14 output_tokens,
// 15 cost_cents, 16 occurred_at, 17 created_at
fn cost_event_row(row: &Row) -> Result<CostEventRow, CostDbError> {
    let raw_billing_type: String = get_col(row, 10, "billing_type")?;
    Ok(CostEventRow {
        id: get_col(row, 0, "id")?,
        company_id: get_col(row, 1, "company_id")?,
        agent_id: get_col(row, 2, "agent_id")?,
        issue_id: get_col(row, 3, "issue_id")?,
        project_id: get_col(row, 4, "project_id")?,
        goal_id: get_col(row, 5, "goal_id")?,
        heartbeat_run_id: get_col(row, 6, "heartbeat_run_id")?,
        billing_code: get_col(row, 7, "billing_code")?,
        provider: get_col(row, 8, "provider")?,
        biller: get_col(row, 9, "biller")?,
        billing_type: BillingType::parse(&raw_billing_type)?,
        model: get_col(row, 11, "model")?,
        input_tokens: get_col(row, 12, "input_tokens")?,
        cached_input_tokens: get_col(row, 13, "cached_input_tokens")?,
        output_tokens: get_col(row, 14, "output_tokens")?,
        cost_cents: get_col(row, 15, "cost_cents")?,
        occurred_at: get_col(row, 16, "occurred_at")?,
        created_at: get_col(row, 17, "created_at")?,
    })
}

// column order for SQL_GET_COMPANY_SPEND_SNAPSHOT:
// 0 id (the company id), 1 budget_monthly_cents, 2 spent_monthly_cents
fn snapshot_row(row: &Row) -> Result<CompanySpendSnapshotRow, CostDbError> {
    Ok(CompanySpendSnapshotRow {
        company_id: get_col(row, 0, "id")?,
        budget_monthly_cents: get_col(row, 1, "budget_monthly_cents")?,
        spent_monthly_cents: get_col(row, 2, "spent_monthly_cents")?,
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 500)
}

pub fn record_cost_event(
    tx: &mut Transaction<'_>,
    input: &RecordCostEventInput,
) -> Result<CostEventRow, CostDbError> {
    let cost_cents = validate_cost_cents(input.cost_cents)?;
    if input.provider.trim().is_empty() {
        return Err(CostDbError::EmptyField("provider"));
    }
    if input.model.trim().is_empty() {
        return Err(CostDbError::EmptyField("model"));
    }
    let biller = input.biller.as_deref().unwrap_or(input.provider.as_str());
    let billing_type = input.billing_type.unwrap_or(BillingType::Unknown).as_str();
    let row = tx
        .query_opt(
            SQL_INSERT_COST_EVENT,
            &[
                &input.company_id, &input.agent_id, &input.issue_id, &input.project_id,
                &input.goal_id, &input.heartbeat_run_id, &input.billing_code, &input.provider,
                &biller, &billing_type, &input.model,
                &input.input_tokens, &input.cached_input_tokens, &input.output_tokens,
                &cost_cents, &input.occurred_at,
            ],
        )?
        .ok_or(CostDbError::CrossCompanyReference)?;
    cost_event_row(&row)
}

pub fn list_cost_events(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_filter: Option<Uuid>,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    limit: i64,
) -> Result<Vec<CostEventRow>, CostDbError> {
    validate_cost_window(from, to)?;
    let rows = tx.query(
        SQL_LIST_COST_EVENTS,
        &[&company_id, &agent_filter, &from, &to, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(cost_event_row).collect()
}

pub fn summarize_company_cost_window(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<i64, CostDbError> {
    validate_cost_window(from, to)?;
    let row = tx.query_one(SQL_SUM_COMPANY_COST_WINDOW, &[&company_id, &from, &to])?;
    get_col(&row, 0, "cost_cents_sum")
}

pub fn get_company_spend_snapshot(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
) -> Result<Option<CompanySpendSnapshotRow>, CostDbError> {
    let row = tx.query_opt(SQL_GET_COMPANY_SPEND_SNAPSHOT, &[&company_id])?;
    row.map(|r| snapshot_row(&r)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_is_parameterized_and_company_scoped() {
        for sql in [
            SQL_INSERT_COST_EVENT,
            SQL_LIST_COST_EVENTS,
            SQL_SUM_COMPANY_COST_WINDOW,
            SQL_GET_COMPANY_SPEND_SNAPSHOT,
        ] {
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in [SQL_INSERT_COST_EVENT, SQL_LIST_COST_EVENTS, SQL_SUM_COMPANY_COST_WINDOW] {
            assert!(sql.contains("FROM cost_events") || sql.contains("INTO cost_events"), "{sql}");
            assert!(sql.contains("company_id"), "{sql}");
        }
        assert!(SQL_GET_COMPANY_SPEND_SNAPSHOT.contains("FROM companies WHERE id = $1"));
    }

    #[test]
    fn insert_sql_keeps_every_company_fence() {
        assert!(SQL_INSERT_COST_EVENT.contains(
            "EXISTS (SELECT 1 FROM agents a WHERE a.id = $2 AND a.company_id = $1)"
        ));
        for (param, table) in
            [("$3", "issues"), ("$4", "projects"), ("$5", "goals"), ("$6", "heartbeat_runs")]
        {
            let guard = format!("{param}::uuid IS NULL OR EXISTS (SELECT 1 FROM {table} t WHERE t.id = {param} AND t.company_id = $1)");
            assert!(SQL_INSERT_COST_EVENT.contains(&guard), "{guard}");
        }
        assert!(SQL_INSERT_COST_EVENT.contains("RETURNING id, company_id"));
    }

    #[test]
    fn list_sum_snapshot_sql_matches_contract() {
        assert_eq!(
            SQL_LIST_COST_EVENTS,
            "SELECT id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, billing_code, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at, created_at FROM cost_events WHERE company_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) AND ($3::timestamptz IS NULL OR occurred_at >= $3) AND ($4::timestamptz IS NULL OR occurred_at <= $4) ORDER BY occurred_at DESC, id DESC LIMIT $5"
        );
        assert_eq!(
            SQL_SUM_COMPANY_COST_WINDOW,
            "SELECT COALESCE(SUM(cost_cents), 0)::bigint FROM cost_events WHERE company_id = $1 AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at <= $3)"
        );
        assert_eq!(
            SQL_GET_COMPANY_SPEND_SNAPSHOT,
            "SELECT id, budget_monthly_cents, spent_monthly_cents FROM companies WHERE id = $1"
        );
        assert!(SQL_LIST_COST_EVENTS.contains("IS NULL OR occurred_at >= $3"));
        assert!(SQL_LIST_COST_EVENTS.contains("IS NULL OR occurred_at <= $4"));
        assert!(SQL_LIST_COST_EVENTS.contains("ORDER BY occurred_at DESC, id DESC LIMIT $5"));
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(1), 1);
        assert_eq!(clamp_list_limit(250), 250);
        assert_eq!(clamp_list_limit(500), 500);
        assert_eq!(clamp_list_limit(501), 500);
        assert_eq!(clamp_list_limit(-9), 1);
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn pg_fencing_defaults_windows_and_snapshot() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (c1, c2) = (Uuid::new_v4(), Uuid::new_v4());
        let (a1, a1b, a2) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        for (cid, name) in [(c1, "pc1"), (c2, "pc2")] {
            let prefix = format!("P{cid}");
            tx.execute(
                "INSERT INTO companies (id, name, issue_prefix) VALUES ($1,$2,$3)",
                &[&cid, &name, &prefix],
            )
            .unwrap();
        }
        for (aid, cid) in [(a1, c1), (a1b, c1), (a2, c2)] {
            tx.execute("INSERT INTO agents (id, company_id, name) VALUES ($1,$2,'a')", &[&aid, &cid])
                .unwrap();
        }
        let now = Utc::now();
        let (t_old, t_new) = (now - chrono::Duration::hours(2), now - chrono::Duration::hours(1));
        let ev = |company: Uuid, agent: Uuid, at: DateTime<Utc>, cents: i64| RecordCostEventInput {
            company_id: company, agent_id: agent, issue_id: None, project_id: None,
            goal_id: None, heartbeat_run_id: None, billing_code: None,
            provider: "openai".to_string(), biller: None, billing_type: None,
            model: "m".to_string(), input_tokens: 1, cached_input_tokens: 0,
            output_tokens: 1, cost_cents: cents, occurred_at: at,
        };
        assert!(matches!(
            record_cost_event(&mut tx, &ev(c1, a2, now, 5)),
            Err(CostDbError::CrossCompanyReference)
        ));
        let e1 = record_cost_event(&mut tx, &ev(c1, a1, t_old, 5)).unwrap();
        assert_eq!(e1.biller, "openai");
        assert_eq!(e1.billing_type, BillingType::Unknown);
        let e2 = record_cost_event(&mut tx, &ev(c1, a1b, t_new, 7)).unwrap();
        let ids = |rows: Vec<CostEventRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(
            ids(list_cost_events(&mut tx, c1, None, None, None, 50).unwrap()),
            vec![e2.id, e1.id]
        );
        assert_eq!(
            ids(list_cost_events(&mut tx, c1, Some(a1), None, None, 50).unwrap()),
            vec![e1.id]
        );
        assert_eq!(
            ids(list_cost_events(&mut tx, c1, None, Some(t_new), Some(t_new), 50).unwrap()),
            vec![e2.id]
        );
        assert!(matches!(
            list_cost_events(&mut tx, c1, None, Some(t_new), Some(t_old), 50),
            Err(CostDbError::InvalidWindow { .. })
        ));
        assert_eq!(summarize_company_cost_window(&mut tx, c1, None, None).unwrap(), 12);
        assert_eq!(summarize_company_cost_window(&mut tx, c1, Some(t_new), None).unwrap(), 7);
        assert_eq!(summarize_company_cost_window(&mut tx, c2, None, None).unwrap(), 0);
        tx.execute(
            "UPDATE companies SET budget_monthly_cents = 1000, spent_monthly_cents = 250 WHERE id = $1",
            &[&c1],
        )
        .unwrap();
        let snap = get_company_spend_snapshot(&mut tx, c1).unwrap().unwrap();
        assert_eq!(
            (snap.company_id, snap.budget_monthly_cents, snap.spent_monthly_cents),
            (c1, 1000, 250)
        );
        assert!(get_company_spend_snapshot(&mut tx, Uuid::new_v4()).unwrap().is_none());
        tx.rollback().unwrap();
    }
}

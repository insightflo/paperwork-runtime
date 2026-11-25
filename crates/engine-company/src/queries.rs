use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{CompanyDbError, CompanyDefaultLanguage, CompanyKind, CompanyStatus};

macro_rules! COMPANY_COLUMNS {
    () => {
        "id, name, description, status, pause_reason, paused_at, issue_prefix, issue_counter, budget_monthly_cents, spent_monthly_cents, require_board_approval_for_new_agents, timezone, work_product_root, default_language, brand_color, company_kind, allows_code_modify, created_at, updated_at"
    };
}

pub const COMPANY_COLUMNS: &str = COMPANY_COLUMNS!();

pub const SQL_LIST_COMPANIES: &str = concat!("SELECT ", COMPANY_COLUMNS!(), " FROM companies ORDER BY created_at ASC, id ASC LIMIT $1");
pub const SQL_GET_COMPANY_BY_ID: &str = concat!("SELECT ", COMPANY_COLUMNS!(), " FROM companies WHERE id = $1");
pub const SQL_GET_COMPANY_BY_ISSUE_PREFIX: &str = concat!("SELECT ", COMPANY_COLUMNS!(), " FROM companies WHERE issue_prefix = $1");
pub const SQL_CREATE_COMPANY: &str = concat!("INSERT INTO companies (name, description, issue_prefix, budget_monthly_cents, spent_monthly_cents, require_board_approval_for_new_agents, timezone, work_product_root, default_language, brand_color, company_kind, allows_code_modify) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ", COMPANY_COLUMNS!());
pub const SQL_UPDATE_COMPANY: &str = concat!("UPDATE companies SET name = COALESCE($2, name), status = COALESCE($3, status), description = COALESCE($4, description), timezone = COALESCE($5, timezone), work_product_root = COALESCE($6, work_product_root), default_language = COALESCE($7, default_language), brand_color = COALESCE($8, brand_color), budget_monthly_cents = COALESCE($9, budget_monthly_cents), spent_monthly_cents = COALESCE($10, spent_monthly_cents), require_board_approval_for_new_agents = COALESCE($11, require_board_approval_for_new_agents), allows_code_modify = COALESCE($12, allows_code_modify), updated_at = now() WHERE id = $1 RETURNING ", COMPANY_COLUMNS!());
pub const SQL_PAUSE_COMPANY_FENCED: &str = concat!("UPDATE companies SET status = 'paused', pause_reason = $2, paused_at = now(), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING ", COMPANY_COLUMNS!());
pub const SQL_RESUME_COMPANY_FENCED: &str = concat!("UPDATE companies SET status = 'active', pause_reason = NULL, paused_at = NULL, updated_at = now() WHERE id = $1 AND status = 'paused' RETURNING ", COMPANY_COLUMNS!());
pub const SQL_NEXT_ISSUE_COUNTER: &str = "UPDATE companies SET issue_counter = issue_counter + 1, updated_at = now() WHERE id = $1 RETURNING issue_prefix, issue_counter";

#[derive(Debug, Clone)]
pub struct CompanyRow {
    pub id: Uuid, pub name: String, pub description: Option<String>,
    pub status: CompanyStatus, pub pause_reason: Option<String>,
    pub paused_at: Option<DateTime<Utc>>, pub issue_prefix: String, pub issue_counter: i32,
    pub budget_monthly_cents: i32, pub spent_monthly_cents: i32,
    pub require_board_approval_for_new_agents: bool,
    pub timezone: Option<String>, pub work_product_root: Option<String>,
    pub default_language: CompanyDefaultLanguage, pub brand_color: Option<String>,
    pub company_kind: CompanyKind, pub allows_code_modify: bool,
    pub created_at: DateTime<Utc>, pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateCompanyInput {
    pub name: String, pub description: Option<String>, pub issue_prefix: String,
    pub budget_monthly_cents: i32, pub spent_monthly_cents: i32,
    pub require_board_approval_for_new_agents: bool,
    pub timezone: Option<String>, pub work_product_root: Option<String>,
    pub default_language: CompanyDefaultLanguage, pub brand_color: Option<String>,
    pub company_kind: CompanyKind, pub allows_code_modify: bool,
}

#[derive(Debug, Clone)]
pub struct UpdateCompanyInput {
    pub name: Option<String>, pub description: Option<String>, pub status: Option<CompanyStatus>,
    pub timezone: Option<String>, pub work_product_root: Option<String>,
    pub default_language: Option<CompanyDefaultLanguage>, pub brand_color: Option<String>,
    pub budget_monthly_cents: Option<i32>, pub spent_monthly_cents: Option<i32>,
    pub require_board_approval_for_new_agents: Option<bool>, pub allows_code_modify: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct PauseCompanyInput {
    pub pause_reason: Option<String>,
}

impl CreateCompanyInput {
    fn validate(&self) -> Result<(), CompanyDbError> {
        if self.name.trim().is_empty() { return Err(CompanyDbError::InvalidName); }
        if self.issue_prefix.trim().is_empty() { return Err(CompanyDbError::InvalidIssuePrefix); }
        if self.budget_monthly_cents < 0 || self.spent_monthly_cents < 0 {
            return Err(CompanyDbError::NegativeCents);
        }
        Ok(())
    }
}

impl UpdateCompanyInput {
    fn validate(&self) -> Result<(), CompanyDbError> {
        if self.name.as_deref().is_some_and(|name| name.trim().is_empty()) {
            return Err(CompanyDbError::InvalidName);
        }
        if self.budget_monthly_cents.is_some_and(|v| v < 0)
            || self.spent_monthly_cents.is_some_and(|v| v < 0)
        {
            return Err(CompanyDbError::NegativeCents);
        }
        Ok(())
    }
}

fn decode_enums(
    raw_status: &str, raw_kind: &str, raw_language: &str,
) -> Result<(CompanyStatus, CompanyKind, CompanyDefaultLanguage), CompanyDbError> {
    Ok((
        CompanyStatus::parse(raw_status)?,
        CompanyKind::parse(raw_kind)?,
        CompanyDefaultLanguage::parse(raw_language)?,
    ))
}

fn company_from_row(row: &Row) -> Result<CompanyRow, CompanyDbError> {
    // Indexes fixed by COMPANY_COLUMNS: 0 id, 1 name, 2 description, 3 status,
    // 4 pause_reason, 5 paused_at, 6 issue_prefix, 7 issue_counter, 8 budget_monthly_cents,
    // 9 spent_monthly_cents, 10 require_board_approval_for_new_agents, 11 timezone,
    // 12 work_product_root, 13 default_language, 14 brand_color, 15 company_kind,
    // 16 allows_code_modify, 17 created_at, 18 updated_at.
    let raw_status: String = row.get(3);
    let raw_language: String = row.get(13);
    let raw_kind: String = row.get(15);
    let (status, company_kind, default_language) =
        decode_enums(&raw_status, &raw_kind, &raw_language)?;
    Ok(CompanyRow {
        id: row.get(0), name: row.get(1), description: row.get(2), status,
        pause_reason: row.get(4), paused_at: row.get(5), issue_prefix: row.get(6),
        issue_counter: row.get(7), budget_monthly_cents: row.get(8),
        spent_monthly_cents: row.get(9), require_board_approval_for_new_agents: row.get(10),
        timezone: row.get(11), work_product_root: row.get(12), default_language,
        brand_color: row.get(14), company_kind, allows_code_modify: row.get(16),
        created_at: row.get(17), updated_at: row.get(18),
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn list_companies(
    tx: &mut Transaction<'_>, limit: i64,
) -> Result<Vec<CompanyRow>, CompanyDbError> {
    let rows = tx.query(SQL_LIST_COMPANIES, &[&clamp_list_limit(limit)])?;
    rows.iter().map(company_from_row).collect()
}

pub fn get_company_by_id(
    tx: &mut Transaction<'_>, company_id: Uuid,
) -> Result<Option<CompanyRow>, CompanyDbError> {
    let row = tx.query_opt(SQL_GET_COMPANY_BY_ID, &[&company_id])?;
    row.map(|r| company_from_row(&r)).transpose()
}

pub fn get_company_by_issue_prefix(
    tx: &mut Transaction<'_>, issue_prefix: &str,
) -> Result<Option<CompanyRow>, CompanyDbError> {
    let row = tx.query_opt(SQL_GET_COMPANY_BY_ISSUE_PREFIX, &[&issue_prefix])?;
    row.map(|r| company_from_row(&r)).transpose()
}

pub fn create_company(
    tx: &mut Transaction<'_>, input: &CreateCompanyInput,
) -> Result<CompanyRow, CompanyDbError> {
    input.validate()?;
    let default_language = input.default_language.as_str();
    let company_kind = input.company_kind.as_str();
    let row = tx.query_one(SQL_CREATE_COMPANY, &[
        &input.name, &input.description, &input.issue_prefix, &input.budget_monthly_cents,
        &input.spent_monthly_cents, &input.require_board_approval_for_new_agents,
        &input.timezone, &input.work_product_root, &default_language, &input.brand_color,
        &company_kind, &input.allows_code_modify,
    ])?;
    company_from_row(&row)
}

pub fn update_company(
    tx: &mut Transaction<'_>, company_id: Uuid, input: &UpdateCompanyInput,
) -> Result<CompanyRow, CompanyDbError> {
    input.validate()?;
    let status = input.status.map(|value| value.as_str());
    let default_language = input.default_language.map(|value| value.as_str());
    let row = tx.query_opt(SQL_UPDATE_COMPANY, &[
        &company_id, &input.name, &status, &input.description, &input.timezone,
        &input.work_product_root, &default_language, &input.brand_color,
        &input.budget_monthly_cents, &input.spent_monthly_cents,
        &input.require_board_approval_for_new_agents, &input.allows_code_modify,
    ])?;
    company_from_row(&row.ok_or(CompanyDbError::NotFound)?)
}

pub fn pause_company_fenced(
    tx: &mut Transaction<'_>, company_id: Uuid, input: &PauseCompanyInput,
) -> Result<Option<CompanyRow>, CompanyDbError> {
    let row = tx.query_opt(SQL_PAUSE_COMPANY_FENCED, &[&company_id, &input.pause_reason])?;
    row.map(|r| company_from_row(&r)).transpose()
}

pub fn resume_company_fenced(
    tx: &mut Transaction<'_>, company_id: Uuid,
) -> Result<Option<CompanyRow>, CompanyDbError> {
    let row = tx.query_opt(SQL_RESUME_COMPANY_FENCED, &[&company_id])?;
    row.map(|r| company_from_row(&r)).transpose()
}

pub fn next_issue_counter(
    tx: &mut Transaction<'_>, company_id: Uuid,
) -> Result<Option<(String, i32)>, CompanyDbError> {
    let row = tx.query_opt(SQL_NEXT_ISSUE_COUNTER, &[&company_id])?;
    Ok(row.map(|r| (r.get(0), r.get(1))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_input() -> CreateCompanyInput {
        CreateCompanyInput {
            name: "Acme".to_string(), description: None, issue_prefix: "ACM".to_string(), budget_monthly_cents: 10, spent_monthly_cents: 0,
            require_board_approval_for_new_agents: true, timezone: None, work_product_root: None, default_language: CompanyDefaultLanguage::En,
            brand_color: None, company_kind: CompanyKind::Business, allows_code_modify: false,
        }
    }

    fn update_input() -> UpdateCompanyInput {
        UpdateCompanyInput {
            name: None, description: None, status: None, timezone: None, work_product_root: None, default_language: None,
            brand_color: None, budget_monthly_cents: None, spent_monthly_cents: None, require_board_approval_for_new_agents: None, allows_code_modify: None,
        }
    }

    #[test]
    fn sql_constants_have_fences_counter_and_full_returning_lists() {
        for sql in [
            SQL_LIST_COMPANIES, SQL_GET_COMPANY_BY_ID, SQL_GET_COMPANY_BY_ISSUE_PREFIX, SQL_CREATE_COMPANY,
            SQL_UPDATE_COMPANY, SQL_PAUSE_COMPANY_FENCED, SQL_RESUME_COMPANY_FENCED,
        ] {
            assert!(sql.contains(COMPANY_COLUMNS), "{sql}");
        }
        for sql in [SQL_CREATE_COMPANY, SQL_UPDATE_COMPANY, SQL_PAUSE_COMPANY_FENCED, SQL_RESUME_COMPANY_FENCED] {
            assert!(sql.contains(concat!("RETURNING ", COMPANY_COLUMNS!())), "{sql}");
        }
        assert!(SQL_LIST_COMPANIES.contains("ORDER BY created_at ASC, id ASC LIMIT $1"));
        assert!(SQL_PAUSE_COMPANY_FENCED.contains("AND status = 'active'"));
        assert!(SQL_RESUME_COMPANY_FENCED.contains("AND status = 'paused'"));
        assert!(SQL_NEXT_ISSUE_COUNTER.contains("issue_counter = issue_counter + 1"));
        assert!(SQL_NEXT_ISSUE_COUNTER.contains("RETURNING issue_prefix, issue_counter"));
    }

    #[test]
    fn enum_decode_rejects_unknown_status_kind_and_language() {
        assert!(matches!(decode_enums("bogus", "business", "en"), Err(CompanyDbError::InvalidStatus(raw)) if raw == "bogus"));
        assert!(matches!(decode_enums("active", "bogus", "en"), Err(CompanyDbError::InvalidKind(raw)) if raw == "bogus"));
        assert!(matches!(decode_enums("active", "business", "bogus"), Err(CompanyDbError::InvalidLanguage(raw)) if raw == "bogus"));
    }

    #[test]
    fn input_validation_rejects_empty_names_prefixes_and_negative_cents() {
        assert!(matches!(CreateCompanyInput { name: " ".to_string(), ..create_input() }.validate(), Err(CompanyDbError::InvalidName)));
        assert!(matches!(CreateCompanyInput { issue_prefix: " ".to_string(), ..create_input() }.validate(), Err(CompanyDbError::InvalidIssuePrefix)));
        for input in [
            CreateCompanyInput { budget_monthly_cents: -1, ..create_input() },
            CreateCompanyInput { spent_monthly_cents: -1, ..create_input() },
        ] {
            assert!(matches!(input.validate(), Err(CompanyDbError::NegativeCents)));
        }
        assert!(matches!(UpdateCompanyInput { name: Some(" ".to_string()), ..update_input() }.validate(), Err(CompanyDbError::InvalidName)));
        for input in [
            UpdateCompanyInput { budget_monthly_cents: Some(-1), ..update_input() },
            UpdateCompanyInput { spent_monthly_cents: Some(-1), ..update_input() },
        ] {
            assert!(matches!(input.validate(), Err(CompanyDbError::NegativeCents)));
        }
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(-9), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(10_000), 200);
    }

    #[test]
    #[ignore = "requires COMPANY_TEST_DATABASE_URL"]
    fn live_pg_crud_fences_and_counter() {
        let url = std::env::var("COMPANY_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return; }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let prefix = format!("T{}", Uuid::new_v4().simple());
        let input = CreateCompanyInput { issue_prefix: prefix.clone(), ..create_input() };
        let created = create_company(&mut tx, &input).unwrap();
        assert_eq!(created.status, CompanyStatus::Active);
        assert_eq!(get_company_by_id(&mut tx, created.id).unwrap().unwrap().id, created.id);
        assert_eq!(get_company_by_issue_prefix(&mut tx, &prefix).unwrap().unwrap().id, created.id);
        let patch = UpdateCompanyInput {
            name: Some("Acme Updated".to_string()), budget_monthly_cents: Some(20), ..update_input()
        };
        let updated = update_company(&mut tx, created.id, &patch).unwrap();
        assert_eq!((updated.name.as_str(), updated.budget_monthly_cents), ("Acme Updated", 20));
        let pause = PauseCompanyInput { pause_reason: Some("test".to_string()) };
        let paused = pause_company_fenced(&mut tx, created.id, &pause).unwrap().unwrap();
        assert_eq!(paused.status, CompanyStatus::Paused);
        assert!(pause_company_fenced(&mut tx, created.id, &pause).unwrap().is_none());
        assert_eq!(resume_company_fenced(&mut tx, created.id).unwrap().unwrap().status, CompanyStatus::Active);
        assert!(resume_company_fenced(&mut tx, created.id).unwrap().is_none());
        let first = next_issue_counter(&mut tx, created.id).unwrap().unwrap();
        let second = next_issue_counter(&mut tx, created.id).unwrap().unwrap();
        assert_eq!((first.0.as_str(), second.0.as_str()), (prefix.as_str(), prefix.as_str()));
        assert_eq!(second.1, first.1 + 1);
        assert!(next_issue_counter(&mut tx, Uuid::new_v4()).unwrap().is_none());
        tx.rollback().unwrap();
    }
}

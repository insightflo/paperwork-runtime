#![forbid(unsafe_code)]

use chrono::{DateTime, Duration, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{clamp_list_limit, WikiAudience, WikiDbError, WikiStatus};

pub const WIKI_INJECTION_FRESH_DAYS: i64 = 14;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WikiEntryRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub mission_id: Option<Uuid>,
    pub pattern: String,
    pub cause: String,
    pub solution: String,
    pub error_code: Option<String>,
    pub step_id: Option<String>,
    pub frequency: i32,
    pub status: WikiStatus,
    pub audience: WikiAudience,
    pub last_seen_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct RecordFailureInput {
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub mission_id: Option<Uuid>,
    pub pattern: String,
    pub cause: String,
    pub solution: String,
    pub error_code: String,
    pub step_id: Option<String>,
    pub audience: Option<WikiAudience>,
}

pub const SQL_RECORD_FAILURE: &str = "INSERT INTO agent_wiki_entries (company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at) SELECT $1, $2, $3, $4, $5, $6, $7, $8, 1, 'active', $9, NOW(), NULL, NOW(), NOW() WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = $2 AND a.company_id = $1) ON CONFLICT (company_id, agent_id, pattern, error_code) DO UPDATE SET frequency = agent_wiki_entries.frequency + 1, last_seen_at = NOW(), updated_at = NOW(), mission_id = $3, step_id = $8, cause = $5, solution = $6, audience = $9, status = 'active', resolved_at = NULL RETURNING id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at";
pub const SQL_SEARCH_RELEVANT: &str = "SELECT id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at FROM agent_wiki_entries WHERE company_id = $1 AND agent_id = $2 AND status = 'active' AND audience = 'agent' AND last_seen_at >= $3 AND ($4::text IS NULL OR step_id = $4) ORDER BY frequency DESC, last_seen_at DESC LIMIT $5";
pub const SQL_LIST_WIKI_ENTRIES: &str = "SELECT id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at FROM agent_wiki_entries WHERE company_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2";
pub const SQL_MARK_RESOLVED_FENCED: &str = "UPDATE agent_wiki_entries SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at";
pub const SQL_CLOSE_ENTRY_FENCED: &str = "UPDATE agent_wiki_entries SET status = 'closed', updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status IN ('active', 'resolved') RETURNING id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at";

fn decode_col<'a, T>(row: &'a Row, idx: usize, column: &'static str) -> Result<T, WikiDbError>
where
    T: postgres::types::FromSql<'a>,
{
    row.try_get(idx).map_err(|err| WikiDbError::UndecodableRow {
        column: column.to_string(),
        detail: err.to_string(),
    })
}

// Column positions in every SELECT/RETURNING projection above:
// 0 id, 1 company_id, 2 agent_id, 3 mission_id, 4 pattern, 5 cause, 6 solution,
// 7 error_code, 8 step_id, 9 frequency, 10 status, 11 audience, 12 last_seen_at,
// 13 resolved_at, 14 created_at, 15 updated_at.
fn wiki_entry_from_row(row: &Row) -> Result<WikiEntryRow, WikiDbError> {
    let frequency: i32 = decode_col(row, 9, "frequency")?;
    if frequency < 1 {
        return Err(WikiDbError::InvalidFrequency(frequency));
    }
    let raw_status: String = decode_col(row, 10, "status")?;
    let raw_audience: String = decode_col(row, 11, "audience")?;
    Ok(WikiEntryRow {
        id: decode_col(row, 0, "id")?,
        company_id: decode_col(row, 1, "company_id")?,
        agent_id: decode_col(row, 2, "agent_id")?,
        mission_id: decode_col(row, 3, "mission_id")?,
        pattern: decode_col(row, 4, "pattern")?,
        cause: decode_col(row, 5, "cause")?,
        solution: decode_col(row, 6, "solution")?,
        error_code: decode_col(row, 7, "error_code")?,
        step_id: decode_col(row, 8, "step_id")?,
        frequency,
        status: WikiStatus::parse(&raw_status)?,
        audience: WikiAudience::parse(&raw_audience)?,
        last_seen_at: decode_col(row, 12, "last_seen_at")?,
        resolved_at: decode_col(row, 13, "resolved_at")?,
        created_at: decode_col(row, 14, "created_at")?,
        updated_at: decode_col(row, 15, "updated_at")?,
    })
}

fn validate_record_input(input: &RecordFailureInput) -> Result<(), WikiDbError> {
    for (field, value) in [
        ("pattern", input.pattern.as_str()),
        ("cause", input.cause.as_str()),
        ("solution", input.solution.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(WikiDbError::EmptyField(field));
        }
    }
    if input.error_code.trim().is_empty() {
        return Err(WikiDbError::MissingErrorCode);
    }
    Ok(())
}

fn checked_list_limit(limit: i64) -> Result<i64, WikiDbError> {
    if limit < 1 {
        return Err(WikiDbError::InvalidLimit(limit));
    }
    Ok(clamp_list_limit(limit))
}

pub fn record_failure(
    tx: &mut Transaction<'_>,
    input: &RecordFailureInput,
) -> Result<WikiEntryRow, WikiDbError> {
    validate_record_input(input)?;
    let audience = input.audience.unwrap_or(WikiAudience::Ops).as_str();
    let row = tx.query_opt(
        SQL_RECORD_FAILURE,
        &[
            &input.company_id,
            &input.agent_id,
            &input.mission_id,
            &input.pattern,
            &input.cause,
            &input.solution,
            &input.error_code,
            &input.step_id,
            &audience,
        ],
    )?;
    wiki_entry_from_row(&row.ok_or(WikiDbError::CrossCompanyReference)?)
}

pub fn search_relevant(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Uuid,
    now: DateTime<Utc>,
    step_id: Option<&str>,
    limit: i64,
) -> Result<Vec<WikiEntryRow>, WikiDbError> {
    let fresh_since = now - Duration::days(WIKI_INJECTION_FRESH_DAYS);
    let rows = tx.query(
        SQL_SEARCH_RELEVANT,
        &[&company_id, &agent_id, &fresh_since, &step_id, &checked_list_limit(limit)?],
    )?;
    rows.iter().map(wiki_entry_from_row).collect()
}

pub fn list_wiki_entries(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    limit: i64,
) -> Result<Vec<WikiEntryRow>, WikiDbError> {
    let rows = tx.query(
        SQL_LIST_WIKI_ENTRIES,
        &[&company_id, &checked_list_limit(limit)?],
    )?;
    rows.iter().map(wiki_entry_from_row).collect()
}

pub fn mark_resolved(
    tx: &mut Transaction<'_>,
    entry_id: Uuid,
    company_id: Uuid,
) -> Result<Option<WikiEntryRow>, WikiDbError> {
    let row = tx.query_opt(SQL_MARK_RESOLVED_FENCED, &[&entry_id, &company_id])?;
    row.map(|r| wiki_entry_from_row(&r)).transpose()
}

pub fn close_entry(
    tx: &mut Transaction<'_>,
    entry_id: Uuid,
    company_id: Uuid,
) -> Result<Option<WikiEntryRow>, WikiDbError> {
    let row = tx.query_opt(SQL_CLOSE_ENTRY_FENCED, &[&entry_id, &company_id])?;
    row.map(|r| wiki_entry_from_row(&r)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(company_id: Uuid, agent_id: Uuid, code: &str, audience: Option<WikiAudience>) -> RecordFailureInput {
        RecordFailureInput {
            company_id,
            agent_id,
            mission_id: None,
            pattern: format!("pattern-{code}"),
            cause: format!("cause-{code}"),
            solution: format!("solution-{code}"),
            error_code: code.to_string(),
            step_id: None,
            audience,
        }
    }

    #[test]
    fn record_input_validation_fails_closed_before_io() {
        let mut bad = input(Uuid::new_v4(), Uuid::new_v4(), "E", None);
        bad.pattern = "  ".to_string();
        assert!(matches!(validate_record_input(&bad), Err(WikiDbError::EmptyField("pattern"))));
        let mut missing = input(Uuid::new_v4(), Uuid::new_v4(), "E", None);
        missing.error_code = " \t ".to_string();
        assert!(matches!(validate_record_input(&missing), Err(WikiDbError::MissingErrorCode)));
        assert!(matches!(checked_list_limit(0), Err(WikiDbError::InvalidLimit(0))));
        assert_eq!(checked_list_limit(501).unwrap(), 500);
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_wiki_dedup_fencing_and_injection_gate() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (company_a, company_b) = (Uuid::new_v4(), Uuid::new_v4());
        let (agent_a, agent_b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut tx = client.transaction().unwrap();
        for (company_id, prefix) in [(company_a, format!("WA{company_a}")), (company_b, format!("WB{company_b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'wiki-test',$2)", &[&company_id, &prefix]).unwrap();
        }
        for (agent_id, company_id) in [(agent_a, company_a), (agent_b, company_b)] {
            tx.execute("INSERT INTO agents (id,company_id,name) VALUES ($1,$2,'wiki-agent')", &[&agent_id, &company_id]).unwrap();
        }
        assert!(matches!(
            record_failure(&mut tx, &input(company_a, agent_b, "cross", None)),
            Err(WikiDbError::CrossCompanyReference)
        ));
        let mut main_input = input(company_a, agent_a, "dedup", Some(WikiAudience::Agent));
        main_input.step_id = Some("step-main".to_string());
        let first = record_failure(&mut tx, &main_input).unwrap();
        assert_eq!(first.frequency, 1);
        assert_eq!(first.audience, WikiAudience::Agent);
        main_input.cause = "refreshed-cause".to_string();
        main_input.solution = "refreshed-solution".to_string();
        let second = record_failure(&mut tx, &main_input).unwrap();
        let third = record_failure(&mut tx, &main_input).unwrap();
        assert_eq!((second.id, second.frequency), (first.id, 2));
        assert_eq!(third.frequency, 3);
        assert_eq!(third.cause, "refreshed-cause");
        assert_eq!(third.solution, "refreshed-solution");
        let mut recurrence = input(company_a, agent_a, "recur", Some(WikiAudience::Ops));
        recurrence.step_id = Some("step-recur".to_string());
        let recurrent = record_failure(&mut tx, &recurrence).unwrap();
        let resolved = mark_resolved(&mut tx, recurrent.id, company_a).unwrap().unwrap();
        assert_eq!(resolved.status, WikiStatus::Resolved);
        recurrence.cause = "recurred-cause".to_string();
        let reactivated = record_failure(&mut tx, &recurrence).unwrap();
        assert_eq!((reactivated.frequency, reactivated.status, reactivated.resolved_at), (2, WikiStatus::Active, None));
        assert_eq!(reactivated.cause, "recurred-cause");
        let mut low = input(company_a, agent_a, "low", Some(WikiAudience::Agent));
        low.step_id = Some("step-x".to_string());
        let low_row = record_failure(&mut tx, &low).unwrap();
        let ops_input = input(company_a, agent_a, "ops-only", Some(WikiAudience::Ops));
        record_failure(&mut tx, &ops_input).unwrap();
        record_failure(&mut tx, &ops_input).unwrap();
        let resolved_input = input(company_a, agent_a, "resolved-only", Some(WikiAudience::Agent));
        let resolved_row = record_failure(&mut tx, &resolved_input).unwrap();
        mark_resolved(&mut tx, resolved_row.id, company_a).unwrap().unwrap();
        let stale_input = input(company_a, agent_a, "stale", Some(WikiAudience::Agent));
        let stale = record_failure(&mut tx, &stale_input).unwrap();
        let stale_time = Utc::now() - Duration::days(WIKI_INJECTION_FRESH_DAYS + 2);
        tx.execute("UPDATE agent_wiki_entries SET last_seen_at = $2 WHERE id = $1", &[&stale.id, &stale_time]).unwrap();
        let found = search_relevant(&mut tx, company_a, agent_a, Utc::now(), None, 20).unwrap();
        assert_eq!(found.iter().map(|row| row.error_code.as_deref()).collect::<Vec<_>>(), vec![Some("dedup"), Some("low")]);
        assert!(found.iter().all(|row| row.status == WikiStatus::Active && row.audience == WikiAudience::Agent));
        let stepped = search_relevant(&mut tx, company_a, agent_a, Utc::now(), Some("step-x"), 20).unwrap();
        assert_eq!(stepped.iter().map(|row| row.id).collect::<Vec<_>>(), vec![low_row.id]);
        let limited = search_relevant(&mut tx, company_a, agent_a, Utc::now(), None, 1).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].error_code.as_deref(), Some("dedup"));
        let other_input = input(company_b, agent_b, "other-company", Some(WikiAudience::Agent));
        let other = record_failure(&mut tx, &other_input).unwrap();
        let list_a = list_wiki_entries(&mut tx, company_a, 100).unwrap();
        assert!(list_a.iter().any(|row| row.id == first.id));
        assert!(!list_a.iter().any(|row| row.id == other.id));
        assert_eq!(list_wiki_entries(&mut tx, company_b, 100).unwrap().len(), 1);
        let marked = mark_resolved(&mut tx, low_row.id, company_a).unwrap().unwrap();
        assert_eq!(marked.status, WikiStatus::Resolved);
        assert!(mark_resolved(&mut tx, low_row.id, company_a).unwrap().is_none());
        assert!(mark_resolved(&mut tx, low_row.id, company_b).unwrap().is_none());
        let closed_resolved = close_entry(&mut tx, low_row.id, company_a).unwrap().unwrap();
        assert_eq!(closed_resolved.status, WikiStatus::Closed);
        let closed_active = close_entry(&mut tx, first.id, company_a).unwrap().unwrap();
        assert_eq!(closed_active.status, WikiStatus::Closed);
        assert!(close_entry(&mut tx, first.id, company_a).unwrap().is_none());
        tx.rollback().unwrap();
    }
}

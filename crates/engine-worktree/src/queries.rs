#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{RuleAction, RuleSeverity, WorktreeRuleDbError};

#[derive(Debug, Clone)]
pub struct WorktreeRuleRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub name: String,
    pub severity: RuleSeverity,
    pub action: RuleAction,
    pub predicate: serde_json::Value,
    pub decision_map: serde_json::Value,
    pub message: String,
    pub enabled: bool,
    pub version: i32,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateWorktreeRuleInput {
    pub company_id: Uuid,
    pub name: String,
    pub severity: RuleSeverity,
    pub action: RuleAction,
    pub predicate: serde_json::Value,
    pub decision_map: serde_json::Value,
    pub message: String,
    pub enabled: bool,
    pub created_by: String,
}

impl CreateWorktreeRuleInput {
    pub fn validate(&self) -> Result<(), WorktreeRuleDbError> {
        if self.name.trim().is_empty() {
            return Err(WorktreeRuleDbError::InvalidName);
        }
        if self.created_by.trim().is_empty() {
            return Err(WorktreeRuleDbError::InvalidCreatedBy);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct UpdateWorktreeRuleInput {
    pub name: Option<String>,
    pub severity: Option<RuleSeverity>,
    pub action: Option<RuleAction>,
    pub predicate: Option<serde_json::Value>,
    pub decision_map: Option<serde_json::Value>,
    pub message: Option<String>,
}

impl UpdateWorktreeRuleInput {
    pub fn validate(&self) -> Result<(), WorktreeRuleDbError> {
        if self.name.as_deref().is_some_and(|name| name.trim().is_empty()) {
            return Err(WorktreeRuleDbError::InvalidName);
        }
        Ok(())
    }
}

pub const SQL_LIST_WORKTREE_RULES: &str = "SELECT id, company_id, name, severity, action, predicate, decision_map, message, enabled, version, created_by, created_at, updated_at FROM worktree_rules WHERE company_id = $1 AND ($2::boolean IS NULL OR enabled = $2) ORDER BY created_at ASC, id ASC";
pub const SQL_GET_WORKTREE_RULE_BY_ID: &str = "SELECT id, company_id, name, severity, action, predicate, decision_map, message, enabled, version, created_by, created_at, updated_at FROM worktree_rules WHERE id = $1 AND company_id = $2";
pub const SQL_CREATE_WORKTREE_RULE: &str = "INSERT INTO worktree_rules (company_id, name, severity, action, predicate, decision_map, message, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, company_id, name, severity, action, predicate, decision_map, message, enabled, version, created_by, created_at, updated_at";
pub const SQL_UPDATE_WORKTREE_RULE_FENCED: &str = "UPDATE worktree_rules SET name = COALESCE($4::text, name), severity = COALESCE($5::text, severity), action = COALESCE($6::text, action), predicate = COALESCE($7::jsonb, predicate), decision_map = COALESCE($8::jsonb, decision_map), message = COALESCE($9::text, message), version = version + 1, updated_at = now() WHERE id = $1 AND company_id = $2 AND version = $3 RETURNING id, company_id, name, severity, action, predicate, decision_map, message, enabled, version, created_by, created_at, updated_at";
pub const SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED: &str = "UPDATE worktree_rules SET enabled = NOT enabled, version = version + 1, updated_at = now() WHERE id = $1 AND company_id = $2 AND version = $3 RETURNING id, company_id, name, severity, action, predicate, decision_map, message, enabled, version, created_by, created_at, updated_at";
pub const SQL_DELETE_WORKTREE_RULE: &str = "DELETE FROM worktree_rules WHERE id = $1 AND company_id = $2 RETURNING id";

// Column positions shared by every SELECT list and RETURNING list above:
// 0 id, 1 company_id, 2 name, 3 severity, 4 action, 5 predicate,
// 6 decision_map, 7 message, 8 enabled, 9 version, 10 created_by,
// 11 created_at, 12 updated_at.
pub fn worktree_rule_from_row(row: &Row) -> Result<WorktreeRuleRow, WorktreeRuleDbError> {
    let raw_severity: String = row.try_get(3)?;
    let raw_action: String = row.try_get(4)?;
    let (severity, action) = decode_rule_texts(&raw_severity, &raw_action)?;
    Ok(WorktreeRuleRow {
        id: row.try_get(0)?, company_id: row.try_get(1)?, name: row.try_get(2)?,
        severity, action, predicate: row.try_get(5)?, decision_map: row.try_get(6)?,
        message: row.try_get(7)?, enabled: row.try_get(8)?, version: row.try_get(9)?,
        created_by: row.try_get(10)?, created_at: row.try_get(11)?, updated_at: row.try_get(12)?,
    })
}

fn decode_rule_texts(raw_severity: &str, raw_action: &str) -> Result<(RuleSeverity, RuleAction), WorktreeRuleDbError> {
    Ok((RuleSeverity::parse(raw_severity)?, RuleAction::parse(raw_action)?))
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

fn validate_expected_version(expected_version: i32) -> Result<(), WorktreeRuleDbError> {
    if expected_version < 1 {
        return Err(WorktreeRuleDbError::InvalidVersion);
    }
    Ok(())
}

pub fn list_worktree_rules(tx: &mut Transaction<'_>, company_id: Uuid, enabled_only: Option<bool>) -> Result<Vec<WorktreeRuleRow>, WorktreeRuleDbError> {
    let rows = tx.query(SQL_LIST_WORKTREE_RULES, &[&company_id, &enabled_only])?;
    rows.iter().map(worktree_rule_from_row).collect()
}

pub fn get_worktree_rule_by_id(tx: &mut Transaction<'_>, rule_id: Uuid, company_id: Uuid) -> Result<Option<WorktreeRuleRow>, WorktreeRuleDbError> {
    let row = tx.query_opt(SQL_GET_WORKTREE_RULE_BY_ID, &[&rule_id, &company_id])?;
    row.map(|r| worktree_rule_from_row(&r)).transpose()
}

pub fn create_worktree_rule(tx: &mut Transaction<'_>, input: &CreateWorktreeRuleInput) -> Result<WorktreeRuleRow, WorktreeRuleDbError> {
    input.validate()?;
    let severity = input.severity.as_str();
    let action = input.action.as_str();
    let row = tx.query_one(SQL_CREATE_WORKTREE_RULE, &[
        &input.company_id, &input.name, &severity, &action, &input.predicate,
        &input.decision_map, &input.message, &input.enabled, &input.created_by,
    ])?;
    worktree_rule_from_row(&row)
}

fn fenced_miss_error(tx: &mut Transaction<'_>, rule_id: Uuid, company_id: Uuid, expected_version: i32) -> Result<WorktreeRuleDbError, WorktreeRuleDbError> {
    Ok(match get_worktree_rule_by_id(tx, rule_id, company_id)? {
        Some(row) => WorktreeRuleDbError::VersionConflict { expected: expected_version, actual: row.version },
        None => WorktreeRuleDbError::NotFound,
    })
}

pub fn update_worktree_rule_fenced(tx: &mut Transaction<'_>, rule_id: Uuid, company_id: Uuid, expected_version: i32, input: &UpdateWorktreeRuleInput) -> Result<WorktreeRuleRow, WorktreeRuleDbError> {
    validate_expected_version(expected_version)?;
    input.validate()?;
    let severity = input.severity.map(|value| value.as_str());
    let action = input.action.map(|value| value.as_str());
    let predicate = input.predicate.clone();
    let decision_map = input.decision_map.clone();
    let updated = tx.query_opt(SQL_UPDATE_WORKTREE_RULE_FENCED, &[
        &rule_id, &company_id, &expected_version, &input.name, &severity,
        &action, &predicate, &decision_map, &input.message,
    ])?;
    if let Some(row) = updated {
        return worktree_rule_from_row(&row);
    }
    Err(fenced_miss_error(tx, rule_id, company_id, expected_version)?)
}

pub fn toggle_worktree_rule_enabled_fenced(tx: &mut Transaction<'_>, rule_id: Uuid, company_id: Uuid, expected_version: i32) -> Result<WorktreeRuleRow, WorktreeRuleDbError> {
    validate_expected_version(expected_version)?;
    let updated = tx.query_opt(SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED, &[&rule_id, &company_id, &expected_version])?;
    if let Some(row) = updated {
        return worktree_rule_from_row(&row);
    }
    Err(fenced_miss_error(tx, rule_id, company_id, expected_version)?)
}

pub fn delete_worktree_rule(tx: &mut Transaction<'_>, rule_id: Uuid, company_id: Uuid) -> Result<bool, WorktreeRuleDbError> {
    let row = tx.query_opt(SQL_DELETE_WORKTREE_RULE, &[&rule_id, &company_id])?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenced_sql_contains_company_and_version_guards() {
        for sql in [SQL_UPDATE_WORKTREE_RULE_FENCED, SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED] {
            assert!(sql.contains("id = $1 AND company_id = $2 AND version = $3"), "{sql}");
            assert!(sql.contains("AND version = $"), "{sql}");
            assert!(sql.contains("version = version + 1"), "{sql}");
            assert!(sql.contains("RETURNING id, company_id, name, severity, action"), "{sql}");
        }
    }

    #[test]
    fn sql_is_company_scoped_deterministic_and_parameterized() {
        for sql in [SQL_LIST_WORKTREE_RULES, SQL_GET_WORKTREE_RULE_BY_ID, SQL_CREATE_WORKTREE_RULE, SQL_UPDATE_WORKTREE_RULE_FENCED, SQL_TOGGLE_WORKTREE_RULE_ENABLED_FENCED, SQL_DELETE_WORKTREE_RULE] {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        assert!(SQL_LIST_WORKTREE_RULES.contains("($2::boolean IS NULL OR enabled = $2)"));
        assert!(SQL_LIST_WORKTREE_RULES.contains("ORDER BY created_at ASC, id ASC"));
    }

    #[test]
    fn row_text_decode_rejects_unknown_enum_strings() {
        assert!(matches!(
            decode_rule_texts("sometimes", "tool_call"),
            Err(WorktreeRuleDbError::InvalidSeverity(raw)) if raw == "sometimes"
        ));
        assert!(matches!(
            decode_rule_texts("MUST", "shell_exec"),
            Err(WorktreeRuleDbError::InvalidAction(raw)) if raw == "shell_exec"
        ));
        assert!(decode_rule_texts("MUST", "tool_call").is_ok());
    }

    #[test]
    fn input_validation_rejects_invalid_values_before_io() {
        let create = CreateWorktreeRuleInput {
            company_id: Uuid::new_v4(), name: " ".to_string(), severity: RuleSeverity::Must,
            action: RuleAction::ToolCall, predicate: serde_json::json!({}), decision_map: serde_json::json!({}),
            message: String::new(), enabled: true, created_by: "tester".to_string(),
        };
        assert!(matches!(create.validate(), Err(WorktreeRuleDbError::InvalidName)));
        let update = UpdateWorktreeRuleInput { name: Some("\n".to_string()), ..UpdateWorktreeRuleInput::default() };
        assert!(matches!(update.validate(), Err(WorktreeRuleDbError::InvalidName)));
        assert!(matches!(validate_expected_version(0), Err(WorktreeRuleDbError::InvalidVersion)));
        assert!(validate_expected_version(1).is_ok());
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(500), 200);
    }

    #[test]
    #[ignore = "requires WORKTREE_TEST_DATABASE_URL"]
    fn live_pg_crud_and_version_guards() {
        let url = std::env::var("WORKTREE_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (company_a, company_b) = (Uuid::new_v4(), Uuid::new_v4());
        for (company_id, prefix) in [(company_a, format!("A{company_a}")), (company_b, format!("B{company_b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&company_id, &prefix]).unwrap();
        }
        let input = CreateWorktreeRuleInput {
            company_id: company_a, name: "rule".to_string(), severity: RuleSeverity::Must,
            action: RuleAction::ToolCall, predicate: serde_json::json!({"resource":"src/**"}),
            decision_map: serde_json::json!({"deny":"blocked"}), message: "message".to_string(),
            enabled: true, created_by: "tester".to_string(),
        };
        let created = create_worktree_rule(&mut tx, &input).unwrap();
        assert_eq!((created.version, created.severity), (1, RuleSeverity::Must));
        assert_eq!(list_worktree_rules(&mut tx, company_a, None).unwrap().len(), 1);
        assert_eq!(list_worktree_rules(&mut tx, company_a, Some(true)).unwrap().len(), 1);
        assert!(list_worktree_rules(&mut tx, company_a, Some(false)).unwrap().is_empty());
        assert!(get_worktree_rule_by_id(&mut tx, created.id, company_b).unwrap().is_none());
        let patch = UpdateWorktreeRuleInput {
            name: Some("renamed".to_string()), severity: Some(RuleSeverity::Should),
            action: Some(RuleAction::FileWrite), predicate: Some(serde_json::json!({"resource":"other/**"})),
            decision_map: None, message: Some("updated".to_string()),
        };
        let updated = update_worktree_rule_fenced(&mut tx, created.id, company_a, 1, &patch).unwrap();
        assert_eq!((updated.version, updated.name.as_str(), updated.severity), (2, "renamed", RuleSeverity::Should));
        assert!(matches!(
            update_worktree_rule_fenced(&mut tx, created.id, company_a, 1, &patch),
            Err(WorktreeRuleDbError::VersionConflict { expected: 1, actual: 2 })
        ));
        let toggled = toggle_worktree_rule_enabled_fenced(&mut tx, created.id, company_a, 2).unwrap();
        assert_eq!((toggled.enabled, toggled.version), (false, 3));
        assert!(matches!(
            toggle_worktree_rule_enabled_fenced(&mut tx, created.id, company_a, 2),
            Err(WorktreeRuleDbError::VersionConflict { expected: 2, actual: 3 })
        ));
        assert!(matches!(
            toggle_worktree_rule_enabled_fenced(&mut tx, created.id, company_b, 3),
            Err(WorktreeRuleDbError::NotFound)
        ));
        assert!(!delete_worktree_rule(&mut tx, created.id, company_b).unwrap());
        assert!(delete_worktree_rule(&mut tx, created.id, company_a).unwrap());
        assert!(get_worktree_rule_by_id(&mut tx, created.id, company_a).unwrap().is_none());
        tx.rollback().unwrap();
    }
}

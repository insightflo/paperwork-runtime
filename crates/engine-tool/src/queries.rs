#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{
    clamp_list_limit, validate_idempotency_key, CompanySkillCompatibility, CompanySkillSourceType,
    CompanySkillTrustLevel, ToolDbError, ToolReceiptStatus,
};

#[derive(Debug, Clone)]
pub struct ToolDefinitionRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub adapter_type: String,
    pub adapter_config: serde_json::Value,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CompanySkillRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub key: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub markdown: String,
    pub source_type: CompanySkillSourceType,
    pub source_locator: Option<String>,
    pub source_ref: Option<String>,
    pub trust_level: CompanySkillTrustLevel,
    pub compatibility: CompanySkillCompatibility,
    pub file_inventory: serde_json::Value,
    pub metadata: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ToolExecutionReceiptRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub run_id: String,
    pub tool: String,
    pub idempotency_key: String,
    pub status: ToolReceiptStatus,
    pub request_parameters: serde_json::Value,
    pub result_status: Option<i32>,
    pub result_body: Option<serde_json::Value>,
    pub claimed_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub workflow_run_id: Option<Uuid>,
    pub step_id: Option<String>,
}

#[derive(Debug)]
pub struct ClaimToolExecutionReceiptInput {
    pub company_id: Uuid,
    pub run_id: String,
    pub tool: String,
    pub idempotency_key: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug)]
pub enum ReceiptClaimOutcome {
    Claimed(ToolExecutionReceiptRow),
    Replay(ToolExecutionReceiptRow),
    InProgress(ToolExecutionReceiptRow),
}

pub const TOOL_DEFINITION_COLUMNS: &str = "id, company_id, name, description, input_schema, adapter_type, adapter_config, enabled, created_at, updated_at";
pub const COMPANY_SKILL_COLUMNS: &str = "id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at";
pub const TOOL_RECEIPT_COLUMNS: &str = "id, company_id, run_id, tool, idempotency_key, status, request_parameters, result_status, result_body, claimed_at, completed_at, workflow_run_id, step_id";

pub const SQL_GET_TOOL_DEFINITION: &str = "SELECT id, company_id, name, description, input_schema, adapter_type, adapter_config, enabled, created_at, updated_at FROM tool_definitions WHERE id = $1 AND company_id = $2";
pub const SQL_LIST_TOOL_DEFINITIONS: &str = "SELECT id, company_id, name, description, input_schema, adapter_type, adapter_config, enabled, created_at, updated_at FROM tool_definitions WHERE company_id = $1 AND ($2::boolean IS NULL OR enabled = $2) ORDER BY name ASC, id ASC LIMIT $3";
pub const SQL_LIST_COMPANY_SKILLS: &str = "SELECT id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at FROM company_skills WHERE company_id = $1 ORDER BY key ASC, id ASC LIMIT $2";
pub const SQL_LIST_TOOL_EXECUTION_RECEIPTS: &str = "SELECT id, company_id, run_id, tool, idempotency_key, status, request_parameters, result_status, result_body, claimed_at, completed_at, workflow_run_id, step_id FROM plugin_tool_execution_receipts WHERE company_id = $1 AND ($2::text IS NULL OR run_id = $2) ORDER BY claimed_at DESC, id DESC LIMIT $3";
pub const SQL_CLAIM_TOOL_EXECUTION_RECEIPT: &str = "INSERT INTO plugin_tool_execution_receipts (company_id, run_id, tool, idempotency_key, status, request_parameters, claimed_at) VALUES ($1, $2, $3, $4, 'executing', $5, now()) ON CONFLICT (company_id, run_id, tool, idempotency_key) DO NOTHING RETURNING id, company_id, run_id, tool, idempotency_key, status, request_parameters, result_status, result_body, claimed_at, completed_at, workflow_run_id, step_id";
pub const SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY: &str = "SELECT id, company_id, run_id, tool, idempotency_key, status, request_parameters, result_status, result_body, claimed_at, completed_at, workflow_run_id, step_id FROM plugin_tool_execution_receipts WHERE company_id = $1 AND run_id = $2 AND tool = $3 AND idempotency_key = $4";

fn tool_definition_from_row(row: &Row) -> Result<ToolDefinitionRow, ToolDbError> {
    Ok(ToolDefinitionRow {
        id: row.get(0),
        company_id: row.get(1),
        name: row.get(2),
        description: row.get(3),
        input_schema: row.get(4),
        adapter_type: row.get(5),
        adapter_config: row.get(6),
        enabled: row.get(7),
        created_at: row.get(8),
        updated_at: row.get(9),
    })
}

fn company_skill_from_row(row: &Row) -> Result<CompanySkillRow, ToolDbError> {
    let raw_source_type: String = row.get(7);
    let raw_trust_level: String = row.get(10);
    let raw_compatibility: String = row.get(11);
    Ok(CompanySkillRow {
        id: row.get(0),
        company_id: row.get(1),
        key: row.get(2),
        slug: row.get(3),
        name: row.get(4),
        description: row.get(5),
        markdown: row.get(6),
        source_type: CompanySkillSourceType::parse(&raw_source_type)?,
        source_locator: row.get(8),
        source_ref: row.get(9),
        trust_level: CompanySkillTrustLevel::parse(&raw_trust_level)?,
        compatibility: CompanySkillCompatibility::parse(&raw_compatibility)?,
        file_inventory: row.get(12),
        metadata: row.get(13),
        created_at: row.get(14),
        updated_at: row.get(15),
    })
}

fn tool_receipt_from_row(row: &Row) -> Result<ToolExecutionReceiptRow, ToolDbError> {
    let raw_status: String = row.get(5);
    Ok(ToolExecutionReceiptRow {
        id: row.get(0),
        company_id: row.get(1),
        run_id: row.get(2),
        tool: row.get(3),
        idempotency_key: row.get(4),
        status: ToolReceiptStatus::parse(&raw_status)?,
        request_parameters: row.get(6),
        result_status: row.get(7),
        result_body: row.get(8),
        claimed_at: row.get(9),
        completed_at: row.get(10),
        workflow_run_id: row.get(11),
        step_id: row.get(12),
    })
}

pub fn list_tool_definitions(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    enabled_filter: Option<bool>,
    limit: i64,
) -> Result<Vec<ToolDefinitionRow>, ToolDbError> {
    let rows = tx.query(
        SQL_LIST_TOOL_DEFINITIONS,
        &[&company_id, &enabled_filter, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(tool_definition_from_row).collect()
}

pub fn get_tool_definition(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    tool_id: Uuid,
) -> Result<Option<ToolDefinitionRow>, ToolDbError> {
    let row = tx.query_opt(SQL_GET_TOOL_DEFINITION, &[&tool_id, &company_id])?;
    row.map(|r| tool_definition_from_row(&r)).transpose()
}

pub fn list_company_skills(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    limit: i64,
) -> Result<Vec<CompanySkillRow>, ToolDbError> {
    let rows = tx.query(
        SQL_LIST_COMPANY_SKILLS,
        &[&company_id, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(company_skill_from_row).collect()
}

pub fn list_tool_execution_receipts(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    run_id_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<ToolExecutionReceiptRow>, ToolDbError> {
    let rows = tx.query(
        SQL_LIST_TOOL_EXECUTION_RECEIPTS,
        &[&company_id, &run_id_filter, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(tool_receipt_from_row).collect()
}

pub fn classify_receipt_claim(
    inserted: Option<ToolExecutionReceiptRow>,
    existing: Option<ToolExecutionReceiptRow>,
) -> Result<ReceiptClaimOutcome, ToolDbError> {
    match (inserted, existing) {
        (Some(row), _) => Ok(ReceiptClaimOutcome::Claimed(row)),
        (None, Some(row)) => Ok(match row.status {
            ToolReceiptStatus::Completed => ReceiptClaimOutcome::Replay(row),
            ToolReceiptStatus::Executing => ReceiptClaimOutcome::InProgress(row),
        }),
        (None, None) => Err(ToolDbError::ReceiptCollision),
    }
}

pub fn record_tool_execution_receipt_idempotent(
    tx: &mut Transaction<'_>,
    input: &ClaimToolExecutionReceiptInput,
) -> Result<ReceiptClaimOutcome, ToolDbError> {
    if input.run_id.trim().is_empty() {
        return Err(ToolDbError::InvalidInput("run_id"));
    }
    if input.tool.trim().is_empty() {
        return Err(ToolDbError::InvalidInput("tool"));
    }
    let idempotency_key = validate_idempotency_key(&input.idempotency_key)?;
    let inserted = tx
        .query_opt(
            SQL_CLAIM_TOOL_EXECUTION_RECEIPT,
            &[
                &input.company_id,
                &input.run_id,
                &input.tool,
                &idempotency_key,
                &input.parameters,
            ],
        )?
        .map(|row| tool_receipt_from_row(&row))
        .transpose()?;
    let existing = if inserted.is_none() {
        tx.query_opt(
            SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY,
            &[
                &input.company_id,
                &input.run_id,
                &input.tool,
                &idempotency_key,
            ],
        )?
        .map(|row| tool_receipt_from_row(&row))
        .transpose()?
    } else {
        None
    };
    classify_receipt_claim(inserted, existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_claim_sql_carries_identity_and_columns() {
        assert!(SQL_CLAIM_TOOL_EXECUTION_RECEIPT
            .contains("ON CONFLICT (company_id, run_id, tool, idempotency_key) DO NOTHING"));
        assert!(SQL_CLAIM_TOOL_EXECUTION_RECEIPT.contains("'executing'"));
        assert!(SQL_CLAIM_TOOL_EXECUTION_RECEIPT.contains(TOOL_RECEIPT_COLUMNS));
        assert!(SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY
            .contains("company_id = $1 AND run_id = $2 AND tool = $3 AND idempotency_key = $4"));
        assert!(SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY.contains(TOOL_RECEIPT_COLUMNS));
    }

    #[test]
    fn list_sql_is_deterministic_with_optional_filters() {
        assert!(SQL_LIST_TOOL_DEFINITIONS.contains("$2::boolean IS NULL OR enabled = $2"));
        assert!(SQL_LIST_TOOL_DEFINITIONS.contains("ORDER BY name ASC, id ASC LIMIT $3"));
        assert!(SQL_LIST_TOOL_DEFINITIONS.contains(TOOL_DEFINITION_COLUMNS));
        assert!(SQL_LIST_COMPANY_SKILLS.contains("ORDER BY key ASC, id ASC LIMIT $2"));
        assert!(SQL_LIST_COMPANY_SKILLS.contains(COMPANY_SKILL_COLUMNS));
        assert!(SQL_LIST_TOOL_EXECUTION_RECEIPTS.contains("$2::text IS NULL OR run_id = $2"));
        assert!(
            SQL_LIST_TOOL_EXECUTION_RECEIPTS.contains("ORDER BY claimed_at DESC, id DESC LIMIT $3")
        );
    }
}

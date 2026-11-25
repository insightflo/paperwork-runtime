#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

mod queries;

pub use queries::*;

/// Mirrors `operator_decisions_status_check` (pending|resolved|cancelled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    Pending,
    Resolved,
    Cancelled,
}

const ALL_DECISION_STATUSES: [DecisionStatus; 3] = [DecisionStatus::Pending, DecisionStatus::Resolved, DecisionStatus::Cancelled];
const DECISION_STATUS_NAMES: [&str; 3] = ["pending", "resolved", "cancelled"];

impl DecisionStatus {
    pub fn as_str(&self) -> &'static str {
        DECISION_STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<DecisionStatus, DecisionDbError> {
        ALL_DECISION_STATUSES.into_iter().find(|s| s.as_str() == raw).ok_or_else(|| DecisionDbError::InvalidStatus(raw.to_string()))
    }
}

/// Mirrors `operator_decisions_priority_check` (critical|high|medium|low).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionPriority {
    Critical,
    High,
    Medium,
    Low,
}

const ALL_PRIORITIES: [DecisionPriority; 4] = [DecisionPriority::Critical, DecisionPriority::High, DecisionPriority::Medium, DecisionPriority::Low];
const PRIORITY_NAMES: [&str; 4] = ["critical", "high", "medium", "low"];

impl DecisionPriority {
    pub fn as_str(&self) -> &'static str {
        PRIORITY_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<DecisionPriority, DecisionDbError> {
        ALL_PRIORITIES.into_iter().find(|s| s.as_str() == raw).ok_or_else(|| DecisionDbError::InvalidPriority(raw.to_string()))
    }
}

/// Mirrors `operator_decisions_interaction_check` (single_select|multi_select|action).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionType {
    SingleSelect,
    MultiSelect,
    Action,
}

const ALL_INTERACTION_TYPES: [InteractionType; 3] = [InteractionType::SingleSelect, InteractionType::MultiSelect, InteractionType::Action];
const INTERACTION_TYPE_NAMES: [&str; 3] = ["single_select", "multi_select", "action"];

impl InteractionType {
    pub fn as_str(&self) -> &'static str {
        INTERACTION_TYPE_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<InteractionType, DecisionDbError> {
        ALL_INTERACTION_TYPES.into_iter().find(|s| s.as_str() == raw).ok_or_else(|| DecisionDbError::InvalidInteractionType(raw.to_string()))
    }
}

/// Mirrors `operator_decisions_continuation_mode_check` (none|issue_current_assignee).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinuationMode {
    None,
    IssueCurrentAssignee,
}

const ALL_CONTINUATION_MODES: [ContinuationMode; 2] = [ContinuationMode::None, ContinuationMode::IssueCurrentAssignee];
const CONTINUATION_MODE_NAMES: [&str; 2] = ["none", "issue_current_assignee"];

impl ContinuationMode {
    pub fn as_str(&self) -> &'static str {
        CONTINUATION_MODE_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<ContinuationMode, DecisionDbError> {
        ALL_CONTINUATION_MODES.into_iter().find(|s| s.as_str() == raw).ok_or_else(|| DecisionDbError::InvalidContinuationMode(raw.to_string()))
    }
}

/// Mirrors `operator_decisions_schema_version_check` (`schema_version = 1`).
pub const SCHEMA_VERSION: i32 = 1;

pub fn validate_schema_version(value: i32) -> Result<(), DecisionDbError> {
    if value != SCHEMA_VERSION { return Err(DecisionDbError::InvalidSchemaVersion(value)); }
    Ok(())
}

/// Fail-closed errors for company-scoped operator-decision ops. No panic path:
/// every invalid input, unexpected DB value, or fence miss maps to a variant.
#[derive(Debug)]
pub enum DecisionDbError {
    /// A required free-text field was empty after trimming.
    EmptyField(&'static str),
    InvalidStatus(String),
    InvalidPriority(String),
    InvalidInteractionType(String),
    InvalidContinuationMode(String),
    /// `schema_version` was not `SCHEMA_VERSION`.
    InvalidSchemaVersion(i32),
    /// `quality_action_id` set while `continuation_mode <> 'none'`
    /// (`operator_decisions_quality_continuation_check`).
    QualityContinuationConflict,
    /// A jsonb field that must hold an object did not (`definition`,
    /// `source_context`, `result`, `quality_binding`).
    NotAnObject(&'static str),
    /// Same `(company_id, request_key)` with a different `request_hash`
    /// (mirrors `loadReplay` in operator-decision-create.ts).
    RequestKeyConflict,
    /// A row column failed to decode into its Rust type.
    UndecodableRow { column: String, detail: String },
    /// postgres driver/transport failure.
    Db(postgres::Error),
}

impl fmt::Display for DecisionDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecisionDbError::EmptyField(field) => write!(f, "required field must not be empty: {field}"),
            DecisionDbError::InvalidStatus(raw) => write!(f, "invalid decision status: {raw}"),
            DecisionDbError::InvalidPriority(raw) => write!(f, "invalid decision priority: {raw}"),
            DecisionDbError::InvalidInteractionType(raw) => write!(f, "invalid interaction type: {raw}"),
            DecisionDbError::InvalidContinuationMode(raw) => write!(f, "invalid continuation mode: {raw}"),
            DecisionDbError::InvalidSchemaVersion(value) => write!(f, "invalid schema version: {value} (require {SCHEMA_VERSION})"),
            DecisionDbError::QualityContinuationConflict => write!(f, "quality_action_id requires continuation_mode = 'none'"),
            DecisionDbError::NotAnObject(field) => write!(f, "field must be a JSON object: {field}"),
            DecisionDbError::RequestKeyConflict => write!(f, "request_key conflict for (company_id, request_key)"),
            DecisionDbError::UndecodableRow { column, detail } => write!(f, "undecodable row at column {column}: {detail}"),
            DecisionDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for DecisionDbError {}

impl From<postgres::Error> for DecisionDbError {
    fn from(err: postgres::Error) -> Self {
        DecisionDbError::Db(err)
    }
}

fn validate_non_empty(field: &'static str, value: &str) -> Result<(), DecisionDbError> {
    if value.trim().is_empty() { return Err(DecisionDbError::EmptyField(field)); }
    Ok(())
}

pub fn validate_request_key(value: &str) -> Result<(), DecisionDbError> {
    validate_non_empty("request_key", value)
}

pub fn validate_request_hash(value: &str) -> Result<(), DecisionDbError> {
    validate_non_empty("request_hash", value)
}

pub fn validate_title(value: &str) -> Result<(), DecisionDbError> {
    validate_non_empty("title", value)
}

pub fn validate_source(source_type: &str, source_id: &str) -> Result<(), DecisionDbError> {
    validate_non_empty("source_type", source_type)?;
    validate_non_empty("source_id", source_id)
}

pub fn validate_resolved_by(value: &str) -> Result<(), DecisionDbError> {
    validate_non_empty("resolved_by_user_id", value)
}

/// Mirrors `operator_decisions_quality_continuation_check`: a quality-linked
/// decision must keep `continuation_mode = 'none'`. Checked before any PG I/O.
pub fn validate_quality_continuation(
    quality_action_id: Option<Uuid>,
    mode: ContinuationMode,
) -> Result<(), DecisionDbError> {
    if quality_action_id.is_some() && mode != ContinuationMode::None {
        return Err(DecisionDbError::QualityContinuationConflict);
    }
    Ok(())
}

pub fn validate_object_field(
    field: &'static str,
    value: &serde_json::Value,
) -> Result<(), DecisionDbError> {
    if !value.is_object() { return Err(DecisionDbError::NotAnObject(field)); }
    Ok(())
}

pub fn validate_optional_object_field(
    field: &'static str,
    value: Option<&serde_json::Value>,
) -> Result<(), DecisionDbError> {
    match value {
        Some(v) => validate_object_field(field, v),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_parse_and_serde_roundtrip() {
        for v in ALL_DECISION_STATUSES {
            assert_eq!(serde_json::to_value(v).unwrap(), serde_json::json!(v.as_str()));
            assert_eq!(serde_json::from_value::<DecisionStatus>(serde_json::json!(v.as_str())).unwrap(), v);
            assert_eq!(DecisionStatus::parse(v.as_str()).unwrap(), v);
        }
        for v in ALL_PRIORITIES {
            assert_eq!(serde_json::to_value(v).unwrap(), serde_json::json!(v.as_str()));
            assert_eq!(serde_json::from_value::<DecisionPriority>(serde_json::json!(v.as_str())).unwrap(), v);
            assert_eq!(DecisionPriority::parse(v.as_str()).unwrap(), v);
        }
        for v in ALL_INTERACTION_TYPES {
            assert_eq!(serde_json::to_value(v).unwrap(), serde_json::json!(v.as_str()));
            assert_eq!(serde_json::from_value::<InteractionType>(serde_json::json!(v.as_str())).unwrap(), v);
            assert_eq!(InteractionType::parse(v.as_str()).unwrap(), v);
        }
        for v in ALL_CONTINUATION_MODES {
            assert_eq!(serde_json::to_value(v).unwrap(), serde_json::json!(v.as_str()));
            assert_eq!(serde_json::from_value::<ContinuationMode>(serde_json::json!(v.as_str())).unwrap(), v);
            assert_eq!(ContinuationMode::parse(v.as_str()).unwrap(), v);
        }
    }

    #[test]
    fn enum_parse_rejects_unknown_and_case_mismatch() {
        assert!(matches!(DecisionStatus::parse("open"), Err(DecisionDbError::InvalidStatus(s)) if s == "open"));
        assert!(matches!(DecisionStatus::parse("PENDING"), Err(DecisionDbError::InvalidStatus(_))));
        assert!(matches!(DecisionPriority::parse("URGENT"), Err(DecisionDbError::InvalidPriority(_))));
        assert!(matches!(DecisionPriority::parse("Medium"), Err(DecisionDbError::InvalidPriority(_))));
        assert!(matches!(InteractionType::parse("checkbox"), Err(DecisionDbError::InvalidInteractionType(_))));
        assert!(matches!(ContinuationMode::parse("always"), Err(DecisionDbError::InvalidContinuationMode(_))));
    }

    #[test]
    fn error_display_matching_and_from() {
        assert!(DecisionDbError::EmptyField("title").to_string().contains("title"));
        assert!(DecisionDbError::InvalidStatus("x".to_string()).to_string().contains('x'));
        assert!(DecisionDbError::InvalidSchemaVersion(2).to_string().contains('2'));
        assert!(DecisionDbError::QualityContinuationConflict.to_string().contains("continuation_mode"));
        assert!(DecisionDbError::NotAnObject("definition").to_string().contains("definition"));
        assert!(DecisionDbError::RequestKeyConflict.to_string().contains("request_key"));
        let undecodable = DecisionDbError::UndecodableRow { column: "status".to_string(), detail: "boom".to_string() };
        assert!(undecodable.to_string().contains("status"));
        let as_error: &dyn std::error::Error = &undecodable;
        assert!(as_error.source().is_none());
        let _convert: fn(postgres::Error) -> DecisionDbError = DecisionDbError::from;
    }

    #[test]
    fn validation_matrix() {
        for blank in ["", "   ", "\t\n"] {
            assert!(matches!(validate_request_key(blank), Err(DecisionDbError::EmptyField("request_key"))));
            assert!(matches!(validate_request_hash(blank), Err(DecisionDbError::EmptyField("request_hash"))));
            assert!(matches!(validate_title(blank), Err(DecisionDbError::EmptyField("title"))));
            assert!(matches!(validate_source(blank, "s"), Err(DecisionDbError::EmptyField("source_type"))));
            assert!(matches!(validate_source("t", blank), Err(DecisionDbError::EmptyField("source_id"))));
            assert!(matches!(validate_resolved_by(blank), Err(DecisionDbError::EmptyField("resolved_by_user_id"))));
        }
        assert!(validate_schema_version(SCHEMA_VERSION).is_ok());
        for v in [0, 2, -1, i32::MAX] {
            assert!(matches!(validate_schema_version(v), Err(DecisionDbError::InvalidSchemaVersion(got)) if got == v));
        }
        assert!(validate_quality_continuation(None, ContinuationMode::None).is_ok());
        assert!(validate_quality_continuation(None, ContinuationMode::IssueCurrentAssignee).is_ok());
        assert!(validate_quality_continuation(Some(Uuid::new_v4()), ContinuationMode::None).is_ok());
        assert!(matches!(validate_quality_continuation(Some(Uuid::new_v4()), ContinuationMode::IssueCurrentAssignee), Err(DecisionDbError::QualityContinuationConflict)));
        for bad in [serde_json::json!(5), serde_json::json!("x"), serde_json::json!([])] {
            assert!(matches!(validate_object_field("definition", &bad), Err(DecisionDbError::NotAnObject("definition"))));
            assert!(matches!(validate_optional_object_field("quality_binding", Some(&bad)), Err(DecisionDbError::NotAnObject("quality_binding"))));
        }
        assert!(validate_object_field("result", &serde_json::json!({})).is_ok());
        assert!(validate_optional_object_field("quality_binding", None).is_ok());
        assert!(validate_optional_object_field("quality_binding", Some(&serde_json::json!({}))).is_ok());
    }
}

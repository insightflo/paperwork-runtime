#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

/// Closed enum mirroring `CompanySkillSourceType` in
/// `packages/shared/src/types/company-skill.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSourceType {
    LocalPath,
    Github,
    Url,
    Catalog,
    SkillsSh,
}

const ALL_SOURCE_TYPES: [SkillSourceType; 5] = [
    SkillSourceType::LocalPath, SkillSourceType::Github, SkillSourceType::Url,
    SkillSourceType::Catalog, SkillSourceType::SkillsSh,
];
const SOURCE_TYPE_NAMES: [&str; 5] = ["local_path", "github", "url", "catalog", "skills_sh"];

impl SkillSourceType {
    pub fn as_str(&self) -> &'static str {
        SOURCE_TYPE_NAMES[*self as usize]
    }
    /// Fail-closed: text outside the closed enum is an error, never a default.
    pub fn parse(raw: &str) -> Result<SkillSourceType, SkillDbError> {
        ALL_SOURCE_TYPES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| SkillDbError::InvalidSourceType(raw.to_string()))
    }
}

/// Closed enum mirroring `CompanySkillTrustLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillTrustLevel {
    MarkdownOnly,
    Assets,
    ScriptsExecutables,
}

const ALL_TRUST_LEVELS: [SkillTrustLevel; 3] = [SkillTrustLevel::MarkdownOnly, SkillTrustLevel::Assets, SkillTrustLevel::ScriptsExecutables];
const TRUST_LEVEL_NAMES: [&str; 3] = ["markdown_only", "assets", "scripts_executables"];

impl SkillTrustLevel {
    pub fn as_str(&self) -> &'static str {
        TRUST_LEVEL_NAMES[*self as usize]
    }
    /// Fail-closed: text outside the closed enum is an error, never a default.
    pub fn parse(raw: &str) -> Result<SkillTrustLevel, SkillDbError> {
        ALL_TRUST_LEVELS
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| SkillDbError::InvalidTrustLevel(raw.to_string()))
    }
}

/// Closed enum mirroring `CompanySkillCompatibility`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillCompatibility {
    Compatible,
    Unknown,
    Invalid,
}

const ALL_COMPATIBILITIES: [SkillCompatibility; 3] = [SkillCompatibility::Compatible, SkillCompatibility::Unknown, SkillCompatibility::Invalid];
const COMPATIBILITY_NAMES: [&str; 3] = ["compatible", "unknown", "invalid"];

impl SkillCompatibility {
    pub fn as_str(&self) -> &'static str {
        COMPATIBILITY_NAMES[*self as usize]
    }
    /// Fail-closed: text outside the closed enum is an error, never a default.
    pub fn parse(raw: &str) -> Result<SkillCompatibility, SkillDbError> {
        ALL_COMPATIBILITIES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| SkillDbError::InvalidCompatibility(raw.to_string()))
    }
}

/// Fail-closed errors for company-scoped company-skill domain ops: unknown
/// enum text, empty fields, and malformed JSON columns are errors, never
/// fabricated defaults.
#[derive(Debug)]
pub enum SkillDbError {
    /// Required key/slug/name/markdown was empty after trimming.
    EmptyField(&'static str),
    /// `source_type` text outside the closed enum.
    InvalidSourceType(String),
    /// `trust_level` text outside the closed enum.
    InvalidTrustLevel(String),
    /// `compatibility` text outside the closed enum.
    InvalidCompatibility(String),
    /// `file_inventory` was not a JSON array.
    InvalidFileInventory,
    /// `metadata` was neither a JSON object nor null.
    InvalidMetadata,
    /// A row column failed to decode into its Rust type or closed enum.
    UndecodableRow { column: String, detail: String },
    /// postgres driver/transport failure.
    Db(postgres::Error),
}

impl fmt::Display for SkillDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SkillDbError::EmptyField(field) => write!(f, "required field must not be empty: {field}"),
            SkillDbError::InvalidSourceType(raw) => write!(f, "invalid source_type: {raw}"),
            SkillDbError::InvalidTrustLevel(raw) => write!(f, "invalid trust_level: {raw}"),
            SkillDbError::InvalidCompatibility(raw) => write!(f, "invalid compatibility: {raw}"),
            SkillDbError::InvalidFileInventory => write!(f, "file_inventory must be a JSON array"),
            SkillDbError::InvalidMetadata => write!(f, "metadata must be a JSON object or null"),
            SkillDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable row at column {column}: {detail}")
            }
            SkillDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for SkillDbError {}

impl From<postgres::Error> for SkillDbError {
    fn from(err: postgres::Error) -> Self {
        SkillDbError::Db(err)
    }
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), SkillDbError> {
    if value.trim().is_empty() {
        return Err(SkillDbError::EmptyField(field));
    }
    Ok(())
}

/// The `validate_*` helpers run BEFORE any PG I/O: required text fields must
/// be non-empty after trim; `file_inventory` must be a JSON array; `metadata`
/// must be `None`/null/JSON-object.
pub fn validate_skill_key(value: &str) -> Result<(), SkillDbError> {
    require_non_empty(value, "key")
}
pub fn validate_skill_slug(value: &str) -> Result<(), SkillDbError> {
    require_non_empty(value, "slug")
}
pub fn validate_skill_name(value: &str) -> Result<(), SkillDbError> {
    require_non_empty(value, "name")
}
pub fn validate_skill_markdown(value: &str) -> Result<(), SkillDbError> {
    require_non_empty(value, "markdown")
}
pub fn validate_file_inventory(value: &serde_json::Value) -> Result<(), SkillDbError> {
    if value.is_array() {
        Ok(())
    } else {
        Err(SkillDbError::InvalidFileInventory)
    }
}
pub fn validate_metadata(value: Option<&serde_json::Value>) -> Result<(), SkillDbError> {
    match value {
        None => Ok(()),
        Some(v) if v.is_object() || v.is_null() => Ok(()),
        Some(_) => Err(SkillDbError::InvalidMetadata),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAD: [&str; 6] = ["local", "team", "partial", "SYSTEM", "Markdown_Only", ""];

    #[test]
    fn source_type_parse_and_serde_roundtrip() {
        for s in ALL_SOURCE_TYPES {
            let json = serde_json::to_value(s).unwrap();
            assert_eq!(json, serde_json::json!(s.as_str()));
            assert_eq!(serde_json::from_value::<SkillSourceType>(json).unwrap(), s);
            assert_eq!(SkillSourceType::parse(s.as_str()).unwrap(), s);
        }
        for bad in BAD {
            assert!(matches!(
                SkillSourceType::parse(bad),
                Err(SkillDbError::InvalidSourceType(raw)) if raw == bad
            ));
            assert!(serde_json::from_value::<SkillSourceType>(serde_json::json!(bad)).is_err());
        }
        assert!(SkillSourceType::parse("local-path").is_err());
    }

    #[test]
    fn trust_level_parse_and_serde_roundtrip() {
        for t in ALL_TRUST_LEVELS {
            let json = serde_json::to_value(t).unwrap();
            assert_eq!(json, serde_json::json!(t.as_str()));
            assert_eq!(serde_json::from_value::<SkillTrustLevel>(json).unwrap(), t);
            assert_eq!(SkillTrustLevel::parse(t.as_str()).unwrap(), t);
        }
        for bad in BAD {
            assert!(matches!(
                SkillTrustLevel::parse(bad),
                Err(SkillDbError::InvalidTrustLevel(raw)) if raw == bad
            ));
            assert!(serde_json::from_value::<SkillTrustLevel>(serde_json::json!(bad)).is_err());
        }
        assert!(SkillTrustLevel::parse("markdown-only").is_err());
    }

    #[test]
    fn compatibility_parse_and_serde_roundtrip() {
        for c in ALL_COMPATIBILITIES {
            let json = serde_json::to_value(c).unwrap();
            assert_eq!(json, serde_json::json!(c.as_str()));
            assert_eq!(serde_json::from_value::<SkillCompatibility>(json).unwrap(), c);
            assert_eq!(SkillCompatibility::parse(c.as_str()).unwrap(), c);
        }
        for bad in BAD {
            assert!(matches!(
                SkillCompatibility::parse(bad),
                Err(SkillDbError::InvalidCompatibility(raw)) if raw == bad
            ));
            assert!(serde_json::from_value::<SkillCompatibility>(serde_json::json!(bad)).is_err());
        }
        assert!(SkillCompatibility::parse("valid").is_err());
    }

    #[test]
    fn error_display_matching_and_from_postgres() {
        assert!(SkillDbError::EmptyField("key").to_string().contains("key"));
        assert!(SkillDbError::InvalidSourceType("x".to_string()).to_string().contains('x'));
        assert!(SkillDbError::InvalidTrustLevel("x".to_string()).to_string().contains('x'));
        assert!(SkillDbError::InvalidCompatibility("x".to_string()).to_string().contains('x'));
        assert!(!SkillDbError::InvalidFileInventory.to_string().is_empty());
        assert!(!SkillDbError::InvalidMetadata.to_string().is_empty());
        let undecodable = SkillDbError::UndecodableRow {
            column: "name".to_string(),
            detail: "boom".to_string(),
        };
        assert!(undecodable.to_string().contains("name"));
        let as_error: &dyn std::error::Error = &undecodable;
        assert!(as_error.source().is_none());
        let _convert: fn(postgres::Error) -> SkillDbError = SkillDbError::from;
    }

    #[test]
    fn required_fields_reject_empty_and_whitespace() {
        for (validate, name) in [
            (validate_skill_key as fn(&str) -> Result<(), SkillDbError>, "key"),
            (validate_skill_slug, "slug"),
            (validate_skill_name, "name"),
            (validate_skill_markdown, "markdown"),
        ] {
            assert!(validate("ok").is_ok(), "{name}");
            assert!(validate(" padded ").is_ok(), "{name}");
            for empty in ["", "   ", "\t\n"] {
                assert!(
                    matches!(validate(empty), Err(SkillDbError::EmptyField(f)) if f == name),
                    "{name} empty={empty:?}"
                );
            }
        }
    }

    #[test]
    fn file_inventory_and_metadata_validation() {
        assert!(validate_file_inventory(&serde_json::json!([])).is_ok());
        assert!(validate_file_inventory(&serde_json::json!([{"path": "SKILL.md", "kind": "skill"}])).is_ok());
        for bad in [serde_json::json!({}), serde_json::json!("x"), serde_json::json!(5)] {
            assert!(matches!(validate_file_inventory(&bad), Err(SkillDbError::InvalidFileInventory)));
        }
        assert!(validate_metadata(None).is_ok());
        assert!(validate_metadata(Some(&serde_json::json!({}))).is_ok());
        assert!(validate_metadata(Some(&serde_json::Value::Null)).is_ok());
        for bad in [serde_json::json!(5), serde_json::json!("x"), serde_json::json!([])] {
            assert!(matches!(validate_metadata(Some(&bad)), Err(SkillDbError::InvalidMetadata)));
        }
    }
}

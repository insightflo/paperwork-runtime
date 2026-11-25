#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiStatus {
    Active,
    Resolved,
    Closed,
}

const ALL_WIKI_STATUSES: [WikiStatus; 3] = [
    WikiStatus::Active,
    WikiStatus::Resolved,
    WikiStatus::Closed,
];

impl WikiStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WikiStatus::Active => "active",
            WikiStatus::Resolved => "resolved",
            WikiStatus::Closed => "closed",
        }
    }

    pub fn parse(raw: &str) -> Result<WikiStatus, WikiDbError> {
        ALL_WIKI_STATUSES
            .into_iter()
            .find(|status| status.as_str() == raw)
            .ok_or_else(|| WikiDbError::UndecodableRow {
                column: "status".to_string(),
                detail: format!("unknown wiki status: {raw}"),
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiAudience {
    Agent,
    Ops,
}

const ALL_WIKI_AUDIENCES: [WikiAudience; 2] = [WikiAudience::Agent, WikiAudience::Ops];

impl WikiAudience {
    pub fn as_str(&self) -> &'static str {
        match self {
            WikiAudience::Agent => "agent",
            WikiAudience::Ops => "ops",
        }
    }

    pub fn parse(raw: &str) -> Result<WikiAudience, WikiDbError> {
        ALL_WIKI_AUDIENCES
            .into_iter()
            .find(|audience| audience.as_str() == raw)
            .ok_or_else(|| WikiDbError::UndecodableRow {
                column: "audience".to_string(),
                detail: format!("unknown wiki audience: {raw}"),
            })
    }
}

#[derive(Debug)]
pub enum WikiDbError {
    EmptyField(&'static str),
    MissingErrorCode,
    InvalidFrequency(i32),
    InvalidLimit(i64),
    CrossCompanyReference,
    UndecodableRow { column: String, detail: String },
    Db(postgres::Error),
}

impl fmt::Display for WikiDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WikiDbError::EmptyField(field) => {
                write!(f, "required field must not be empty: {field}")
            }
            WikiDbError::MissingErrorCode => {
                write!(f, "error_code is required for wiki dedup integrity")
            }
            WikiDbError::InvalidFrequency(frequency) => {
                write!(f, "invalid wiki entry frequency: {frequency}")
            }
            WikiDbError::InvalidLimit(limit) => write!(f, "invalid wiki list limit: {limit}"),
            WikiDbError::CrossCompanyReference => {
                write!(f, "agent_id belongs to a different company")
            }
            WikiDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable wiki row at column {column}: {detail}")
            }
            WikiDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for WikiDbError {}

impl From<postgres::Error> for WikiDbError {
    fn from(err: postgres::Error) -> Self {
        WikiDbError::Db(err)
    }
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 500)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_status_parse_and_serde_roundtrip() {
        for status in ALL_WIKI_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<WikiStatus>(json).unwrap(), status);
            assert_eq!(WikiStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(matches!(
            WikiStatus::parse("done"),
            Err(WikiDbError::UndecodableRow { column, .. }) if column == "status"
        ));
        assert!(serde_json::from_value::<WikiStatus>(serde_json::json!("done")).is_err());
    }

    #[test]
    fn wiki_audience_parse_and_serde_roundtrip() {
        for audience in ALL_WIKI_AUDIENCES {
            let json = serde_json::to_value(audience).unwrap();
            assert_eq!(json, serde_json::json!(audience.as_str()));
            assert_eq!(serde_json::from_value::<WikiAudience>(json).unwrap(), audience);
            assert_eq!(WikiAudience::parse(audience.as_str()).unwrap(), audience);
        }
        assert!(matches!(
            WikiAudience::parse("public"),
            Err(WikiDbError::UndecodableRow { column, .. }) if column == "audience"
        ));
        assert!(serde_json::from_value::<WikiAudience>(serde_json::json!("public")).is_err());
    }

    #[test]
    fn error_display_and_matching() {
        assert!(WikiDbError::EmptyField("pattern").to_string().contains("pattern"));
        assert!(WikiDbError::MissingErrorCode.to_string().contains("error_code"));
        assert!(WikiDbError::InvalidFrequency(0).to_string().contains('0'));
        assert!(WikiDbError::InvalidLimit(0).to_string().contains('0'));
        assert!(matches!(
            WikiDbError::CrossCompanyReference,
            WikiDbError::CrossCompanyReference
        ));
        let undecodable = WikiDbError::UndecodableRow {
            column: "status".to_string(),
            detail: "bad".to_string(),
        };
        assert!(undecodable.to_string().contains("status"));
        let as_error: &dyn std::error::Error = &undecodable;
        assert!(as_error.source().is_none());
    }

    #[test]
    fn postgres_error_converts_via_from() {
        let err = match postgres::Client::connect("bogus", postgres::NoTls) {
            Ok(_) => panic!("bogus connection must fail synchronously"),
            Err(err) => err,
        };
        assert!(matches!(WikiDbError::from(err), WikiDbError::Db(_)));
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(1), 1);
        assert_eq!(clamp_list_limit(500), 500);
        assert_eq!(clamp_list_limit(501), 500);
    }

    const ALL_SQL: [&str; 5] = [
        SQL_RECORD_FAILURE,
        SQL_SEARCH_RELEVANT,
        SQL_LIST_WIKI_ENTRIES,
        SQL_MARK_RESOLVED_FENCED,
        SQL_CLOSE_ENTRY_FENCED,
    ];
    const COLUMN_LIST: &str = "id, company_id, agent_id, mission_id, pattern, cause, solution, error_code, step_id, frequency, status, audience, last_seen_at, resolved_at, created_at, updated_at";

    #[test]
    fn sql_is_company_scoped_parameterized_and_not_interpolated() {
        for sql in ALL_SQL {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
    }

    #[test]
    fn record_failure_sql_has_exact_dedup_fence_and_recurrence_shape() {
        assert!(SQL_RECORD_FAILURE.contains("ON CONFLICT (company_id, agent_id, pattern, error_code) DO UPDATE SET"));
        assert!(SQL_RECORD_FAILURE.contains("frequency = agent_wiki_entries.frequency + 1"));
        assert!(SQL_RECORD_FAILURE.contains("last_seen_at = NOW()"));
        assert!(SQL_RECORD_FAILURE.contains("updated_at = NOW()"));
        assert!(SQL_RECORD_FAILURE.contains("EXISTS (SELECT 1 FROM agents a WHERE a.id = $2 AND a.company_id = $1)"));
        assert!(SQL_RECORD_FAILURE.contains("status = 'active', resolved_at = NULL"));
        assert_eq!(SQL_RECORD_FAILURE.rsplit(" RETURNING ").next().unwrap(), COLUMN_LIST);
    }

    #[test]
    fn search_relevant_sql_is_agent_audience_only_and_fresh() {
        assert!(SQL_SEARCH_RELEVANT.contains("status = 'active' AND audience = 'agent'"));
        assert!(SQL_SEARCH_RELEVANT.contains("last_seen_at >= $3"));
        assert!(SQL_SEARCH_RELEVANT.contains("($4::text IS NULL OR step_id = $4)"));
        assert!(SQL_SEARCH_RELEVANT.contains("ORDER BY frequency DESC, last_seen_at DESC LIMIT $5"));
    }

    #[test]
    fn list_and_terminal_transition_sql_shapes_are_fenced() {
        assert!(SQL_LIST_WIKI_ENTRIES.contains("WHERE company_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2"));
        assert!(SQL_MARK_RESOLVED_FENCED.contains("AND status = 'active'"));
        assert!(SQL_MARK_RESOLVED_FENCED.contains("resolved_at = NOW()"));
        assert!(SQL_CLOSE_ENTRY_FENCED.contains("status IN ('active', 'resolved')"));
        assert!(!SQL_CLOSE_ENTRY_FENCED.contains("resolved_at = NOW()"));
        for sql in [SQL_SEARCH_RELEVANT, SQL_LIST_WIKI_ENTRIES, SQL_MARK_RESOLVED_FENCED, SQL_CLOSE_ENTRY_FENCED] {
            assert!(sql.contains(COLUMN_LIST), "{sql}");
        }
    }
}

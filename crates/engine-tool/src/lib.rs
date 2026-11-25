#![forbid(unsafe_code)]

use std::fmt;

mod queries;

pub use queries::*;

macro_rules! closed_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(&self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            pub fn parse(raw: &str) -> Result<$name, ToolDbError> {
                $(if raw == $text {
                    return Ok($name::$variant);
                })+
                Err(ToolDbError::InvalidStatus(raw.to_string()))
            }
        }
    };
}

closed_enum! { ToolReceiptStatus { Executing => "executing", Completed => "completed" } }

closed_enum! {
    CompanySkillSourceType {
        LocalPath => "local_path", Github => "github", Url => "url", Catalog => "catalog",
        SkillsSh => "skills_sh",
    }
}

closed_enum! {
    CompanySkillTrustLevel {
        MarkdownOnly => "markdown_only", Assets => "assets",
        ScriptsExecutables => "scripts_executables",
    }
}

closed_enum! { CompanySkillCompatibility { Compatible => "compatible", Unknown => "unknown", Invalid => "invalid" } }

#[derive(Debug)]
pub enum ToolDbError {
    InvalidStatus(String),
    InvalidIdempotencyKey,
    InvalidInput(&'static str),
    ReceiptCollision,
    Db(postgres::Error),
}

impl fmt::Display for ToolDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ToolDbError::InvalidStatus(raw) => write!(f, "invalid tool-domain status: {raw}"),
            ToolDbError::InvalidIdempotencyKey => {
                write!(f, "empty or overlong idempotency_key")
            }
            ToolDbError::InvalidInput(field) => write!(f, "empty required input: {field}"),
            ToolDbError::ReceiptCollision => {
                write!(f, "receipt identity vanished between claim and readback")
            }
            ToolDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for ToolDbError {}

impl From<postgres::Error> for ToolDbError {
    fn from(err: postgres::Error) -> Self {
        ToolDbError::Db(err)
    }
}

pub const IDEMPOTENCY_KEY_MAX_LEN: usize = 200;

pub fn validate_idempotency_key(key: &str) -> Result<&str, ToolDbError> {
    let trimmed = key.trim();
    if trimmed.is_empty() || trimmed.chars().count() > IDEMPOTENCY_KEY_MAX_LEN {
        return Err(ToolDbError::InvalidIdempotencyKey);
    }
    Ok(trimmed)
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    macro_rules! assert_enum_contract {
        ($ty:ty, $unknown:literal) => {{
            for v in <$ty>::ALL {
                let json = serde_json::to_value(v).unwrap();
                assert_eq!(json, serde_json::json!(v.as_str()));
                assert_eq!(serde_json::from_value::<$ty>(json).unwrap(), *v);
                assert_eq!(<$ty>::parse(v.as_str()).unwrap(), *v);
            }
            assert!(
                matches!(<$ty>::parse($unknown), Err(ToolDbError::InvalidStatus(raw)) if raw == $unknown)
            );
            assert!(serde_json::from_value::<$ty>(serde_json::json!($unknown)).is_err());
        }};
    }

    #[test]
    fn closed_enums_serde_roundtrip_and_fail_closed_parse() {
        assert_enum_contract!(ToolReceiptStatus, "done");
        assert_enum_contract!(CompanySkillSourceType, "ftp");
        assert_enum_contract!(CompanySkillTrustLevel, "root");
        assert_enum_contract!(CompanySkillCompatibility, "maybe");
    }

    #[test]
    fn idempotency_key_validation_matrix() {
        for bad in ["", "   ", "k".repeat(201).as_str()] {
            assert!(matches!(
                validate_idempotency_key(bad),
                Err(ToolDbError::InvalidIdempotencyKey)
            ));
        }
        assert_eq!(validate_idempotency_key("k").unwrap(), "k");
        assert_eq!(validate_idempotency_key("  padded  ").unwrap(), "padded");
        assert_eq!(
            validate_idempotency_key("k".repeat(200).as_str())
                .unwrap()
                .len(),
            200
        );
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(-9), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(10_000), 200);
    }

    #[test]
    fn sql_consts_are_parameterized_and_company_scoped() {
        let selects = [
            SQL_GET_TOOL_DEFINITION,
            SQL_LIST_TOOL_DEFINITIONS,
            SQL_LIST_COMPANY_SKILLS,
            SQL_LIST_TOOL_EXECUTION_RECEIPTS,
            SQL_GET_TOOL_EXECUTION_RECEIPT_BY_IDENTITY,
        ];
        for sql in selects
            .iter()
            .chain([SQL_CLAIM_TOOL_EXECUTION_RECEIPT].iter())
        {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in selects {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
    }

    fn receipt_row(status: ToolReceiptStatus) -> ToolExecutionReceiptRow {
        let ts = Utc::now();
        ToolExecutionReceiptRow {
            id: Uuid::new_v4(),
            company_id: Uuid::new_v4(),
            run_id: "run".to_string(),
            tool: "ns.tool".to_string(),
            idempotency_key: "k".to_string(),
            status,
            request_parameters: serde_json::json!({}),
            result_status: None,
            result_body: None,
            claimed_at: ts,
            completed_at: None,
            workflow_run_id: None,
            step_id: None,
        }
    }

    #[test]
    fn classify_receipt_claim_matrix() {
        let row = receipt_row(ToolReceiptStatus::Executing);
        let id = row.id;
        let ReceiptClaimOutcome::Claimed(got) = classify_receipt_claim(Some(row), None).unwrap()
        else {
            panic!("expected Claimed")
        };
        assert_eq!(got.id, id);
        let row = receipt_row(ToolReceiptStatus::Completed);
        let id = row.id;
        let ReceiptClaimOutcome::Replay(got) = classify_receipt_claim(None, Some(row)).unwrap()
        else {
            panic!("expected Replay")
        };
        assert_eq!(got.id, id);
        let row = receipt_row(ToolReceiptStatus::Executing);
        let id = row.id;
        let ReceiptClaimOutcome::InProgress(got) = classify_receipt_claim(None, Some(row)).unwrap()
        else {
            panic!("expected InProgress")
        };
        assert_eq!(got.id, id);
        assert!(matches!(
            classify_receipt_claim(None, None),
            Err(ToolDbError::ReceiptCollision)
        ));
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_tool_domain() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut tx = client.transaction().unwrap();
        for (cid, prefix) in [(a, format!("TA{a}")), (b, format!("TB{b}"))] {
            tx.execute(
                "INSERT INTO companies (id, name, issue_prefix) VALUES ($1, 't', $2)",
                &[&cid, &prefix],
            )
            .unwrap();
        }
        let tool_id = Uuid::new_v4();
        tx.execute(
            "INSERT INTO tool_definitions (id, company_id, name, adapter_type) VALUES ($1, $2, 't1', 'http')",
            &[&tool_id, &a],
        )
        .unwrap();
        let defs = list_tool_definitions(&mut tx, a, None, 10).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].id, tool_id);
        assert!(get_tool_definition(&mut tx, b, tool_id).unwrap().is_none());
        assert_eq!(
            list_tool_definitions(&mut tx, a, Some(true), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(list_tool_definitions(&mut tx, a, Some(false), 10)
            .unwrap()
            .is_empty());
        tx.execute(
            "INSERT INTO company_skills (id, company_id, key, slug, name, markdown) VALUES ($1, $2, 'k1', 's1', 'n1', '# m')",
            &[&Uuid::new_v4(), &a],
        )
        .unwrap();
        assert_eq!(list_company_skills(&mut tx, a, 10).unwrap().len(), 1);
        assert!(list_company_skills(&mut tx, b, 10).unwrap().is_empty());
        let input = ClaimToolExecutionReceiptInput {
            company_id: a,
            run_id: "r1".to_string(),
            tool: "ns.tool".to_string(),
            idempotency_key: "key-1".to_string(),
            parameters: serde_json::json!({"x": 1}),
        };
        assert!(matches!(
            record_tool_execution_receipt_idempotent(&mut tx, &input).unwrap(),
            ReceiptClaimOutcome::Claimed(_)
        ));
        assert!(matches!(
            record_tool_execution_receipt_idempotent(&mut tx, &input).unwrap(),
            ReceiptClaimOutcome::InProgress(_)
        ));
        tx.execute(
            "UPDATE plugin_tool_execution_receipts SET status = 'completed', result_status = 200, result_body = '{}'::jsonb, completed_at = now() WHERE company_id = $1 AND run_id = 'r1' AND tool = 'ns.tool' AND idempotency_key = 'key-1'",
            &[&a],
        )
        .unwrap();
        assert!(matches!(
            record_tool_execution_receipt_idempotent(&mut tx, &input).unwrap(),
            ReceiptClaimOutcome::Replay(_)
        ));
        tx.rollback().unwrap();
    }
}

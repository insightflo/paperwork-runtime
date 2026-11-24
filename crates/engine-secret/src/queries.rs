#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{validate_version_bump, SecretDbError};

/// Metadata-only projection of `company_secrets` — the 11 allowed columns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretMetadataRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub name: String,
    /// Registry-driven free text (see `server/src/secrets/provider-registry.ts`);
    /// intentionally NOT a closed enum.
    pub provider: String,
    pub external_ref: Option<String>,
    pub latest_version: i32,
    pub description: Option<String>,
    pub created_by_agent_id: Option<Uuid>,
    pub created_by_user_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Metadata-only projection of `company_secret_versions` — 7 of 9 columns;
/// `material` and `value_sha256` are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretVersionMetadataRow {
    pub id: Uuid,
    pub secret_id: Uuid,
    pub version: i32,
    pub created_by_agent_id: Option<Uuid>,
    pub created_by_user_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// Newest-first company listing, mirrors `secretService.list` in
/// `server/src/services/secrets.ts` (`created_at DESC`).
pub const SQL_LIST_SECRET_METADATA: &str = "SELECT id, company_id, name, provider, external_ref, latest_version, description, created_by_agent_id, created_by_user_id, created_at, updated_at FROM company_secrets WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2";
pub const SQL_GET_SECRET_METADATA_BY_ID: &str = "SELECT id, company_id, name, provider, external_ref, latest_version, description, created_by_agent_id, created_by_user_id, created_at, updated_at FROM company_secrets WHERE id = $1 AND company_id = $2";
/// Unique per `(company_id, name)` via `company_secrets_company_name_uq`.
pub const SQL_GET_SECRET_METADATA_BY_NAME: &str = "SELECT id, company_id, name, provider, external_ref, latest_version, description, created_by_agent_id, created_by_user_id, created_at, updated_at FROM company_secrets WHERE company_id = $1 AND name = $2";
/// The EXISTS subquery is the company-scope fence: a secret_id owned by another
/// company yields zero rows, never that company's versions.
pub const SQL_LIST_SECRET_VERSION_METADATA: &str = "SELECT sv.id, sv.secret_id, sv.version, sv.created_by_agent_id, sv.created_by_user_id, sv.created_at, sv.revoked_at FROM company_secret_versions sv WHERE sv.secret_id = $2 AND EXISTS (SELECT 1 FROM company_secrets s WHERE s.id = sv.secret_id AND s.company_id = $1) ORDER BY sv.version DESC, sv.id DESC LIMIT $3";
/// Optimistic-concurrency bump: `AND latest_version = $3` fences stale
/// expectations; zero rows means the version moved, the secret is missing, or
/// it belongs to another company — never fabricated success.
pub const SQL_BUMP_SECRET_LATEST_VERSION_FENCED: &str = "UPDATE company_secrets SET latest_version = $4, updated_at = now() WHERE id = $1 AND company_id = $2 AND latest_version = $3 RETURNING id, company_id, name, provider, external_ref, latest_version, description, created_by_agent_id, created_by_user_id, created_at, updated_at";

fn decode_col<'a, T>(row: &'a Row, idx: usize, column: &'static str) -> Result<T, SecretDbError>
where
    T: postgres::types::FromSql<'a>,
{
    row.try_get(idx).map_err(|err| SecretDbError::UndecodableRow {
        column: column.to_string(),
        detail: err.to_string(),
    })
}

// Column positions for the shared 11-column secret metadata projection used by
// every SELECT list and the bump RETURNING list in this file:
//   0 id, 1 company_id, 2 name, 3 provider, 4 external_ref, 5 latest_version,
//   6 description, 7 created_by_agent_id, 8 created_by_user_id, 9 created_at,
//   10 updated_at
fn secret_metadata_from_row(row: &Row) -> Result<SecretMetadataRow, SecretDbError> {
    Ok(SecretMetadataRow {
        id: decode_col(row, 0, "id")?,
        company_id: decode_col(row, 1, "company_id")?,
        name: decode_col(row, 2, "name")?,
        provider: decode_col(row, 3, "provider")?,
        external_ref: decode_col(row, 4, "external_ref")?,
        latest_version: decode_col(row, 5, "latest_version")?,
        description: decode_col(row, 6, "description")?,
        created_by_agent_id: decode_col(row, 7, "created_by_agent_id")?,
        created_by_user_id: decode_col(row, 8, "created_by_user_id")?,
        created_at: decode_col(row, 9, "created_at")?,
        updated_at: decode_col(row, 10, "updated_at")?,
    })
}

// Column positions for SQL_LIST_SECRET_VERSION_METADATA:
//   0 sv.id, 1 sv.secret_id, 2 sv.version, 3 sv.created_by_agent_id,
//   4 sv.created_by_user_id, 5 sv.created_at, 6 sv.revoked_at
fn secret_version_metadata_from_row(
    row: &Row,
) -> Result<SecretVersionMetadataRow, SecretDbError> {
    Ok(SecretVersionMetadataRow {
        id: decode_col(row, 0, "id")?,
        secret_id: decode_col(row, 1, "secret_id")?,
        version: decode_col(row, 2, "version")?,
        created_by_agent_id: decode_col(row, 3, "created_by_agent_id")?,
        created_by_user_id: decode_col(row, 4, "created_by_user_id")?,
        created_at: decode_col(row, 5, "created_at")?,
        revoked_at: decode_col(row, 6, "revoked_at")?,
    })
}

pub fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

pub fn list_secret_metadata(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    limit: i64,
) -> Result<Vec<SecretMetadataRow>, SecretDbError> {
    let rows = tx.query(
        SQL_LIST_SECRET_METADATA,
        &[&company_id, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(secret_metadata_from_row).collect()
}

pub fn get_secret_metadata_by_id(
    tx: &mut Transaction<'_>,
    secret_id: Uuid,
    company_id: Uuid,
) -> Result<Option<SecretMetadataRow>, SecretDbError> {
    let row = tx.query_opt(SQL_GET_SECRET_METADATA_BY_ID, &[&secret_id, &company_id])?;
    row.map(|r| secret_metadata_from_row(&r)).transpose()
}

/// Validates `name` non-empty (trimmed) BEFORE any PG I/O (`EmptyName`).
pub fn get_secret_metadata_by_name(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    name: &str,
) -> Result<Option<SecretMetadataRow>, SecretDbError> {
    if name.trim().is_empty() {
        return Err(SecretDbError::EmptyName);
    }
    let row = tx.query_opt(SQL_GET_SECRET_METADATA_BY_NAME, &[&company_id, &name])?;
    row.map(|r| secret_metadata_from_row(&r)).transpose()
}

pub fn list_secret_version_metadata(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    secret_id: Uuid,
    limit: i64,
) -> Result<Vec<SecretVersionMetadataRow>, SecretDbError> {
    let rows = tx.query(
        SQL_LIST_SECRET_VERSION_METADATA,
        &[&company_id, &secret_id, &clamp_list_limit(limit)],
    )?;
    rows.iter().map(secret_version_metadata_from_row).collect()
}

/// Validates the version arithmetic BEFORE any PG I/O, then relies on the
/// `AND latest_version = $3` fence. Zero rows => `Ok(None)` (fenced miss:
/// version moved / not found / cross-company — never fabricated success).
pub fn bump_secret_latest_version_fenced(
    tx: &mut Transaction<'_>,
    secret_id: Uuid,
    company_id: Uuid,
    expected_latest_version: i32,
    new_version: i32,
) -> Result<Option<SecretMetadataRow>, SecretDbError> {
    validate_version_bump(expected_latest_version, new_version)?;
    let row = tx.query_opt(
        SQL_BUMP_SECRET_LATEST_VERSION_FENCED,
        &[&secret_id, &company_id, &expected_latest_version, &new_version],
    )?;
    row.map(|r| secret_metadata_from_row(&r)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_SQL: [&str; 5] = [
        SQL_LIST_SECRET_METADATA,
        SQL_GET_SECRET_METADATA_BY_ID,
        SQL_GET_SECRET_METADATA_BY_NAME,
        SQL_LIST_SECRET_VERSION_METADATA,
        SQL_BUMP_SECRET_LATEST_VERSION_FENCED,
    ];

    #[test]
    fn sql_never_selects_material_or_value_sha256() {
        // SECURITY INVARIANT: metadata-only. The forbidden substrings must not
        // appear in any statement — SELECT lists, RETURNING lists, or subqueries.
        for sql in ALL_SQL {
            assert!(!sql.contains("material"), "{sql}");
            assert!(!sql.contains("value_sha256"), "{sql}");
        }
    }

    #[test]
    fn sql_is_company_scoped_and_parameterized() {
        for sql in ALL_SQL {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        for sql in [
            SQL_LIST_SECRET_METADATA,
            SQL_GET_SECRET_METADATA_BY_ID,
            SQL_GET_SECRET_METADATA_BY_NAME,
            SQL_BUMP_SECRET_LATEST_VERSION_FENCED,
        ] {
            assert!(sql.contains("company_id = $"), "{sql}");
        }
        // The version listing fences company scope through an EXISTS subquery.
        assert!(SQL_LIST_SECRET_VERSION_METADATA.contains(
            "EXISTS (SELECT 1 FROM company_secrets s WHERE s.id = sv.secret_id AND s.company_id = $1)"
        ));
    }

    #[test]
    fn bump_fence_predicate_and_returning_shape() {
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("latest_version = $3"));
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("SET latest_version = $4"));
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("updated_at = now()"));
        assert!(SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("RETURNING id, company_id, name"));
        assert!(!SQL_BUMP_SECRET_LATEST_VERSION_FENCED.contains("RETURNING *"));
    }

    #[test]
    fn order_directions_and_limit_positions() {
        assert!(SQL_LIST_SECRET_METADATA.contains("ORDER BY created_at DESC, id DESC LIMIT $2"));
        assert!(
            SQL_LIST_SECRET_VERSION_METADATA
                .contains("ORDER BY sv.version DESC, sv.id DESC LIMIT $3")
        );
    }

    #[test]
    fn list_limit_is_clamped() {
        assert_eq!(clamp_list_limit(0), 1);
        assert_eq!(clamp_list_limit(1), 1);
        assert_eq!(clamp_list_limit(200), 200);
        assert_eq!(clamp_list_limit(500), 200);
        assert_eq!(clamp_list_limit(-7), 1);
        assert_eq!(clamp_list_limit(i64::MAX), 200);
    }
}

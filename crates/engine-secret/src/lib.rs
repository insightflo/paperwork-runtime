#![forbid(unsafe_code)]

use std::fmt;

mod queries;

pub use queries::*;

/// Fail-closed errors for the metadata-only secret registry. No variant carries
/// secret material or digests: `material` and `value_sha256` are never
/// selected, stored, logged, or returned anywhere in this crate.
#[derive(Debug)]
pub enum SecretDbError {
    /// A required secret name was empty after trimming.
    EmptyName,
    /// A required free-text field was empty.
    EmptyField(&'static str),
    /// Version-bump arithmetic violated `expected >= 1` or
    /// `new_version == expected_latest_version + 1` (checked before any PG I/O).
    InvalidVersion {
        expected_latest_version: i32,
        new_version: i32,
    },
    /// A company-scope or version fence rejected the operation.
    Fenced,
    /// A row column failed to decode into its Rust type.
    UndecodableRow { column: String, detail: String },
    /// postgres driver/transport failure.
    Db(postgres::Error),
}

impl fmt::Display for SecretDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretDbError::EmptyName => write!(f, "secret name must not be empty"),
            SecretDbError::EmptyField(field) => {
                write!(f, "required field must not be empty: {field}")
            }
            SecretDbError::InvalidVersion {
                expected_latest_version,
                new_version,
            } => write!(
                f,
                "invalid secret version bump: expected_latest_version={expected_latest_version}, new_version={new_version} (require expected >= 1 and new == expected + 1)"
            ),
            SecretDbError::Fenced => {
                write!(f, "operation fenced by company scope or version guard")
            }
            SecretDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable row at column {column}: {detail}")
            }
            SecretDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for SecretDbError {}

impl From<postgres::Error> for SecretDbError {
    fn from(err: postgres::Error) -> Self {
        SecretDbError::Db(err)
    }
}

/// Validates the rotate-style version arithmetic (`next_version =
/// latest_version + 1`, mirroring `rotate` in
/// `server/src/services/secrets.ts`) BEFORE any PG I/O so a stale or
/// non-positive expectation fails closed instead of reaching the database.
pub fn validate_version_bump(
    expected_latest_version: i32,
    new_version: i32,
) -> Result<(), SecretDbError> {
    if expected_latest_version < 1 || expected_latest_version.checked_add(1) != Some(new_version) {
        return Err(SecretDbError::InvalidVersion {
            expected_latest_version,
            new_version,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_and_matching() {
        assert_eq!(
            SecretDbError::EmptyName.to_string(),
            "secret name must not be empty"
        );
        assert!(SecretDbError::EmptyField("provider")
            .to_string()
            .contains("provider"));
        let invalid = SecretDbError::InvalidVersion {
            expected_latest_version: 2,
            new_version: 4,
        };
        let message = invalid.to_string();
        assert!(message.contains("expected_latest_version=2"));
        assert!(message.contains("new_version=4"));
        assert!(matches!(
            invalid,
            SecretDbError::InvalidVersion {
                expected_latest_version: 2,
                new_version: 4
            }
        ));
        assert!(!SecretDbError::Fenced.to_string().is_empty());
        let undecodable = SecretDbError::UndecodableRow {
            column: "name".to_string(),
            detail: "boom".to_string(),
        };
        assert!(undecodable.to_string().contains("name"));
        let as_error: &dyn std::error::Error = &undecodable;
        assert!(as_error.source().is_none());
    }

    #[test]
    fn postgres_error_converts_via_from() {
        let _convert: fn(postgres::Error) -> SecretDbError = SecretDbError::from;
    }

    #[test]
    fn version_bump_accepts_exact_successor() {
        assert!(validate_version_bump(1, 2).is_ok());
        assert!(validate_version_bump(41, 42).is_ok());
    }

    #[test]
    fn version_bump_rejects_nonpositive_and_non_successor() {
        for (expected, new) in [
            (0, 1),
            (-1, 0),
            (i32::MIN, i32::MIN + 1),
            (1, 1),
            (1, 3),
            (2, 2),
            (2, 4),
            (3, 1),
            (5, 7),
        ] {
            assert!(
                matches!(
                    validate_version_bump(expected, new),
                    Err(SecretDbError::InvalidVersion {
                        expected_latest_version: e,
                        new_version: n
                    }) if e == expected && n == new
                ),
                "expected={expected} new={new}"
            );
        }
        // Overflow edge: i32::MAX has no successor and must fail closed.
        assert!(matches!(
            validate_version_bump(i32::MAX, i32::MAX),
            Err(SecretDbError::InvalidVersion { .. })
        ));
    }

    const SECRET_METADATA_KEYS: [&str; 11] = [
        "id", "company_id", "name", "provider", "external_ref", "latest_version",
        "description", "created_by_agent_id", "created_by_user_id", "created_at",
        "updated_at",
    ];

    const SECRET_VERSION_METADATA_KEYS: [&str; 7] = [
        "id", "secret_id", "version", "created_by_agent_id", "created_by_user_id",
        "created_at", "revoked_at",
    ];

    fn assert_metadata_only(row: &impl serde::Serialize, expected_keys: &[&str]) {
        let value = serde_json::to_value(row).unwrap();
        let json = value.to_string();
        assert!(!json.contains("material"), "{json}");
        assert!(!json.contains("value_sha256"), "{json}");
        assert!(!json.contains("fixture-sha256"), "{json}");
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = expected_keys.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected);
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_metadata_only_and_fencing() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (company_a, company_b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        for (company_id, prefix) in [
            (company_a, format!("P{company_a}")),
            (company_b, format!("P{company_b}")),
        ] {
            tx.execute(
                "INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)",
                &[&company_id, &prefix],
            )
            .unwrap();
        }
        let (secret_a1, secret_a2) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        for (id, name) in [(secret_a1, "api-key"), (secret_a2, "db-url")] {
            tx.execute(
                "INSERT INTO company_secrets (id, company_id, name, provider, latest_version) VALUES ($1,$2,$3,'local_encrypted',2)",
                &[&id, &company_a, &name],
            )
            .unwrap();
        }
        // Fixture material/digest values satisfy NOT NULL columns so rows exist;
        // the crate must never surface them in any output.
        for (secret_id, version) in [(secret_a1, 1i32), (secret_a1, 2i32)] {
            tx.execute(
                "INSERT INTO company_secret_versions (secret_id, version, material, value_sha256) VALUES ($1,$2,$3,$4)",
                &[
                    &secret_id,
                    &version,
                    &serde_json::json!({ "fixture": true }),
                    &format!("fixture-sha256-v{version}"),
                ],
            )
            .unwrap();
        }

        let listed = list_secret_metadata(&mut tx, company_a, 100).unwrap();
        assert_eq!(listed.len(), 2);
        for row in &listed {
            assert_metadata_only(row, &SECRET_METADATA_KEYS);
        }
        let by_id = get_secret_metadata_by_id(&mut tx, secret_a1, company_a)
            .unwrap()
            .unwrap();
        assert_metadata_only(&by_id, &SECRET_METADATA_KEYS);
        let by_name = get_secret_metadata_by_name(&mut tx, company_a, "api-key")
            .unwrap()
            .unwrap();
        assert_eq!(by_id, by_name);
        assert!(matches!(
            get_secret_metadata_by_name(&mut tx, company_a, "   "),
            Err(SecretDbError::EmptyName)
        ));

        // Company-scope fence: the other company sees nothing.
        assert!(list_secret_metadata(&mut tx, company_b, 100)
            .unwrap()
            .is_empty());
        assert!(get_secret_metadata_by_id(&mut tx, secret_a1, company_b)
            .unwrap()
            .is_none());
        assert!(get_secret_metadata_by_name(&mut tx, company_b, "api-key")
            .unwrap()
            .is_none());

        let versions = list_secret_version_metadata(&mut tx, company_a, secret_a1, 100).unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions[0].version >= versions[1].version);
        for row in &versions {
            assert_metadata_only(row, &SECRET_VERSION_METADATA_KEYS);
        }
        assert!(list_secret_version_metadata(&mut tx, company_b, secret_a1, 100)
            .unwrap()
            .is_empty());

        // Bump applies once; replay, stale, cross-company => Ok(None).
        let bumped = bump_secret_latest_version_fenced(&mut tx, secret_a1, company_a, 2, 3)
            .unwrap()
            .unwrap();
        assert_eq!(bumped.latest_version, 3);
        assert_metadata_only(&bumped, &SECRET_METADATA_KEYS);
        assert!(bump_secret_latest_version_fenced(&mut tx, secret_a1, company_a, 2, 3)
            .unwrap()
            .is_none());
        assert!(bump_secret_latest_version_fenced(&mut tx, secret_a1, company_b, 3, 4)
            .unwrap()
            .is_none());
        assert!(matches!(
            bump_secret_latest_version_fenced(&mut tx, secret_a1, company_a, 3, 5),
            Err(SecretDbError::InvalidVersion { .. })
        ));
        tx.rollback().unwrap();
    }
}

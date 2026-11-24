#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use postgres::{Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    validate_file_inventory, validate_metadata, validate_skill_key, validate_skill_markdown,
    validate_skill_name, validate_skill_slug, SkillCompatibility, SkillDbError, SkillSourceType,
    SkillTrustLevel,
};

/// Full 16-column projection of `company_skills`, mirroring
/// `packages/db/src/schema/company_skills.ts` and `toCompanySkill` in
/// `server/src/services/company-skills.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub key: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub markdown: String,
    pub source_type: SkillSourceType,
    pub source_locator: Option<String>,
    pub source_ref: Option<String>,
    pub trust_level: SkillTrustLevel,
    pub compatibility: SkillCompatibility,
    pub file_inventory: serde_json::Value,
    pub metadata: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Writable field set for `upsert_company_skill`: enums are closed at
/// construction; `id`/`created_at`/`updated_at` stay DB-owned.
#[derive(Debug)]
pub struct UpsertSkillInput {
    pub company_id: Uuid,
    pub key: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub markdown: String,
    pub source_type: SkillSourceType,
    pub source_locator: Option<String>,
    pub source_ref: Option<String>,
    pub trust_level: SkillTrustLevel,
    pub compatibility: SkillCompatibility,
    pub file_inventory: serde_json::Value,
    pub metadata: Option<serde_json::Value>,
}

// Every SELECT/RETURNING list below names the same 16 columns in the same
// order as `SkillRow` and `skill_from_row` (id .. updated_at).
pub const SQL_LIST_COMPANY_SKILLS: &str = "SELECT id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at FROM company_skills WHERE company_id = $1 ORDER BY name ASC, key ASC";
pub const SQL_GET_SKILL_BY_ID: &str = "SELECT id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at FROM company_skills WHERE id = $1 AND company_id = $2";
pub const SQL_GET_SKILL_BY_KEY: &str = "SELECT id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at FROM company_skills WHERE company_id = $1 AND key = $2";
pub const SQL_UPSERT_SKILL: &str = "INSERT INTO company_skills (company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (company_id, key) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, description = EXCLUDED.description, markdown = EXCLUDED.markdown, source_type = EXCLUDED.source_type, source_locator = EXCLUDED.source_locator, source_ref = EXCLUDED.source_ref, trust_level = EXCLUDED.trust_level, compatibility = EXCLUDED.compatibility, file_inventory = EXCLUDED.file_inventory, metadata = EXCLUDED.metadata, updated_at = now() RETURNING id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at";
pub const SQL_DELETE_SKILL: &str = "DELETE FROM company_skills WHERE id = $1 AND company_id = $2 RETURNING id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at";

fn decode_col<'a, T>(row: &'a Row, idx: usize, column: &'static str) -> Result<T, SkillDbError>
where
    T: postgres::types::FromSql<'a>,
{
    row.try_get(idx).map_err(|err| SkillDbError::UndecodableRow {
        column: column.to_string(),
        detail: err.to_string(),
    })
}

fn enum_decode_err(column: &'static str, raw: &str) -> SkillDbError {
    SkillDbError::UndecodableRow {
        column: column.to_string(),
        detail: format!("unrecognized value {raw:?}"),
    }
}

// Column positions for the shared 16-column projection used by every SELECT
// and RETURNING list: 0 id, 1 company_id, 2 key, 3 slug, 4 name, 5 description,
// 6 markdown, 7 source_type, 8 source_locator, 9 source_ref, 10 trust_level,
// 11 compatibility, 12 file_inventory, 13 metadata, 14 created_at, 15 updated_at
fn skill_from_row(row: &Row) -> Result<SkillRow, SkillDbError> {
    let raw_source_type: String = decode_col(row, 7, "source_type")?;
    let raw_trust_level: String = decode_col(row, 10, "trust_level")?;
    let raw_compatibility: String = decode_col(row, 11, "compatibility")?;
    Ok(SkillRow {
        id: decode_col(row, 0, "id")?,
        company_id: decode_col(row, 1, "company_id")?,
        key: decode_col(row, 2, "key")?,
        slug: decode_col(row, 3, "slug")?,
        name: decode_col(row, 4, "name")?,
        description: decode_col(row, 5, "description")?,
        markdown: decode_col(row, 6, "markdown")?,
        source_type: SkillSourceType::parse(&raw_source_type)
            .map_err(|_| enum_decode_err("source_type", &raw_source_type))?,
        source_locator: decode_col(row, 8, "source_locator")?,
        source_ref: decode_col(row, 9, "source_ref")?,
        trust_level: SkillTrustLevel::parse(&raw_trust_level)
            .map_err(|_| enum_decode_err("trust_level", &raw_trust_level))?,
        compatibility: SkillCompatibility::parse(&raw_compatibility)
            .map_err(|_| enum_decode_err("compatibility", &raw_compatibility))?,
        file_inventory: decode_col(row, 12, "file_inventory")?,
        metadata: decode_col(row, 13, "metadata")?,
        created_at: decode_col(row, 14, "created_at")?,
        updated_at: decode_col(row, 15, "updated_at")?,
    })
}

/// Mirrors `listFull` in `server/src/services/company-skills.ts`:
/// `ORDER BY name ASC, key ASC`, company-fenced, no LIMIT.
pub fn list_company_skills(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
) -> Result<Vec<SkillRow>, SkillDbError> {
    let rows = tx.query(SQL_LIST_COMPANY_SKILLS, &[&company_id])?;
    rows.iter().map(skill_from_row).collect()
}

/// Id + company fence: `Ok(None)` when absent or owned by another company.
pub fn get_company_skill_by_id(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    skill_id: Uuid,
) -> Result<Option<SkillRow>, SkillDbError> {
    let row = tx.query_opt(SQL_GET_SKILL_BY_ID, &[&skill_id, &company_id])?;
    row.map(|r| skill_from_row(&r)).transpose()
}

/// Mirrors `getByKey`; validates `key` non-empty BEFORE any PG I/O.
pub fn get_company_skill_by_key(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    key: &str,
) -> Result<Option<SkillRow>, SkillDbError> {
    validate_skill_key(key)?;
    let row = tx.query_opt(SQL_GET_SKILL_BY_KEY, &[&company_id, &key])?;
    row.map(|r| skill_from_row(&r)).transpose()
}

/// Mirrors `upsertImportedSkills` insert-or-update-by-`(company_id, key)`.
/// Validates key/slug/name/markdown non-empty, file_inventory a JSON array,
/// and metadata object-or-null BEFORE any PG I/O; `updated_at` bumps on
/// update while `id`/`created_at`/`company_id`/`key` stay immutable.
pub fn upsert_company_skill(
    tx: &mut Transaction<'_>,
    input: &UpsertSkillInput,
) -> Result<SkillRow, SkillDbError> {
    validate_skill_key(&input.key)?;
    validate_skill_slug(&input.slug)?;
    validate_skill_name(&input.name)?;
    validate_skill_markdown(&input.markdown)?;
    validate_file_inventory(&input.file_inventory)?;
    validate_metadata(input.metadata.as_ref())?;
    let row = tx.query_one(
        SQL_UPSERT_SKILL,
        &[
            &input.company_id,
            &input.key,
            &input.slug,
            &input.name,
            &input.description,
            &input.markdown,
            &input.source_type.as_str(),
            &input.source_locator,
            &input.source_ref,
            &input.trust_level.as_str(),
            &input.compatibility.as_str(),
            &input.file_inventory,
            &input.metadata,
        ],
    )?;
    skill_from_row(&row)
}

/// Mirrors `deleteSkill`: deletes `WHERE id AND company_id` and returns the
/// removed row — `Ok(None)` when absent or owned by another company.
pub fn delete_company_skill(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    skill_id: Uuid,
) -> Result<Option<SkillRow>, SkillDbError> {
    let row = tx.query_opt(SQL_DELETE_SKILL, &[&skill_id, &company_id])?;
    row.map(|r| skill_from_row(&r)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_SQL: [&str; 5] = [SQL_LIST_COMPANY_SKILLS, SQL_GET_SKILL_BY_ID, SQL_GET_SKILL_BY_KEY, SQL_UPSERT_SKILL, SQL_DELETE_SKILL];
    const COLS: &str = "id, company_id, key, slug, name, description, markdown, source_type, source_locator, source_ref, trust_level, compatibility, file_inventory, metadata, created_at, updated_at";

    #[test]
    fn sql_is_company_scoped_and_parameterized() {
        for sql in ALL_SQL {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        assert!(SQL_LIST_COMPANY_SKILLS.contains("company_id = $1"));
        assert!(SQL_GET_SKILL_BY_ID.contains("id = $1 AND company_id = $2"));
        assert!(SQL_GET_SKILL_BY_KEY.contains("company_id = $1 AND key = $2"));
        assert!(SQL_DELETE_SKILL.contains("id = $1 AND company_id = $2"));
    }

    #[test]
    fn column_lists_match_documented_order() {
        for sql in [SQL_LIST_COMPANY_SKILLS, SQL_GET_SKILL_BY_ID, SQL_GET_SKILL_BY_KEY] {
            assert!(sql.contains(&format!("SELECT {COLS} FROM company_skills")), "{sql}");
        }
        for sql in [SQL_UPSERT_SKILL, SQL_DELETE_SKILL] {
            assert!(sql.contains(&format!("RETURNING {COLS}")), "{sql}");
            assert!(!sql.contains("RETURNING *"), "{sql}");
        }
    }

    #[test]
    fn list_ordering_mirrors_ts_list_full() {
        assert!(SQL_LIST_COMPANY_SKILLS.contains("ORDER BY name ASC, key ASC"));
        assert!(!SQL_LIST_COMPANY_SKILLS.contains("LIMIT"));
    }

    #[test]
    fn upsert_conflict_shape_and_immutable_columns() {
        assert!(SQL_UPSERT_SKILL.contains("ON CONFLICT (company_id, key) DO UPDATE"));
        assert!(SQL_UPSERT_SKILL.contains("updated_at = now()"));
        for col in ["id", "created_at", "company_id", "key"] {
            assert!(!SQL_UPSERT_SKILL.contains(&format!("{col} = EXCLUDED.{col}")), "{col}");
        }
        for col in ["slug", "name", "description", "markdown", "source_type", "source_locator", "source_ref", "trust_level", "compatibility", "file_inventory", "metadata"] {
            assert!(SQL_UPSERT_SKILL.contains(&format!("{col} = EXCLUDED.{col}")), "{col}");
        }
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_company_fenced_crud() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (company_a, company_b) = (Uuid::new_v4(), Uuid::new_v4());
        for (cid, prefix) in [(company_a, format!("P{company_a}")), (company_b, format!("P{company_b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix]).unwrap();
        }
        let input = |company: Uuid, key: &str, slug: &str, name: &str| UpsertSkillInput {
            company_id: company, key: key.to_string(), slug: slug.to_string(), name: name.to_string(),
            description: Some("d".to_string()), markdown: "# body".to_string(),
            source_type: SkillSourceType::LocalPath, source_locator: Some("/tmp/s".to_string()), source_ref: None,
            trust_level: SkillTrustLevel::MarkdownOnly, compatibility: SkillCompatibility::Compatible,
            file_inventory: serde_json::json!([]), metadata: Some(serde_json::json!({ "skillKey": key })),
        };
        for company in [company_a, company_b] {
            assert!(get_company_skill_by_key(&mut tx, company, "k1").unwrap().is_none());
        }
        assert!(matches!(
            get_company_skill_by_key(&mut tx, company_a, "   "),
            Err(SkillDbError::EmptyField("key"))
        ));
        assert!(matches!(
            upsert_company_skill(&mut tx, &UpsertSkillInput {
                file_inventory: serde_json::json!({}),
                ..input(company_a, "bad", "bad", "Bad")
            }),
            Err(SkillDbError::InvalidFileInventory)
        ));
        let zulu = upsert_company_skill(&mut tx, &input(company_a, "k1", "zulu", "Zulu")).unwrap();
        let alpha = upsert_company_skill(&mut tx, &input(company_a, "k2", "alpha", "Alpha")).unwrap();
        assert_eq!(zulu.company_id, company_a);
        assert_eq!(zulu.source_type, SkillSourceType::LocalPath);
        let renamed = upsert_company_skill(&mut tx, &UpsertSkillInput {
            name: "Zulu2".to_string(), markdown: "# v2".to_string(),
            ..input(company_a, "k1", "zulu", "unused")
        }).unwrap();
        assert_eq!(renamed.id, zulu.id);
        assert_eq!(renamed.markdown, "# v2");
        assert!(renamed.updated_at >= zulu.updated_at);
        let listed = list_company_skills(&mut tx, company_a).unwrap();
        let names: Vec<&str> = listed.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Zulu2"]);
        assert_eq!(listed[0].id, alpha.id);
        assert!(listed.iter().all(|r| r.company_id == company_a));
        assert_eq!(get_company_skill_by_id(&mut tx, company_a, zulu.id).unwrap().unwrap().id, zulu.id);
        assert!(get_company_skill_by_id(&mut tx, company_b, zulu.id).unwrap().is_none());
        assert_eq!(get_company_skill_by_key(&mut tx, company_a, "k1").unwrap().unwrap().id, zulu.id);
        let removed = delete_company_skill(&mut tx, company_a, alpha.id).unwrap().unwrap();
        assert_eq!(removed.id, alpha.id);
        assert!(delete_company_skill(&mut tx, company_a, alpha.id).unwrap().is_none());
        assert!(delete_company_skill(&mut tx, company_b, zulu.id).unwrap().is_none());
        tx.rollback().unwrap();
    }
}

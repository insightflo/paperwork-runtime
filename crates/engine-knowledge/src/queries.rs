#![forbid(unsafe_code)]

//! SQL constants, row decoders, and query entry points for the knowledge
//! domain. Every statement is scoped by `company_id` — directly in WHERE, or
//! via joins for `agent_kb_grants`, which has no company column of its own.

use postgres::types::{FromSql, ToSql};
use postgres::{Row, Transaction};
use uuid::Uuid;

use crate::{
    AgentKbGrantRow, KnowledgeBaseRow, KnowledgeBaseType, KnowledgeDbError, KnowledgeNodeRow,
    KnowledgeNodeStatus, KnowledgeNodeType, UpdateKnowledgeNodeInput,
};

pub const NODE_COLUMNS: &str = "id, company_id, kb_id, parent_id, slug, title, summary, content, node_type, certified, status, tags, linked_node_ids, source_refs, created_at, updated_at";

pub const SQL_LIST_KNOWLEDGE_BASES: &str = "SELECT id, company_id, name, type, description, max_token_budget, config_json, created_at, updated_at FROM knowledge_bases WHERE company_id = $1 ORDER BY created_at ASC, id ASC";
pub const SQL_GET_KNOWLEDGE_NODE: &str = "SELECT id, company_id, kb_id, parent_id, slug, title, summary, content, node_type, certified, status, tags, linked_node_ids, source_refs, created_at, updated_at FROM knowledge_nodes WHERE company_id = $1 AND kb_id = $2 AND id = $3";
pub const SQL_LIST_KNOWLEDGE_NODES_BY_KB: &str = "SELECT id, company_id, kb_id, parent_id, slug, title, summary, content, node_type, certified, status, tags, linked_node_ids, source_refs, created_at, updated_at FROM knowledge_nodes WHERE company_id = $1 AND kb_id = $2 ORDER BY created_at ASC, id ASC";
pub const SQL_LIST_AGENT_KB_GRANTS: &str = "SELECT g.id, g.agent_id, g.kb_id, g.granted_by, g.created_at FROM agent_kb_grants g JOIN knowledge_bases kb ON kb.id = g.kb_id AND kb.company_id = $1 JOIN agents a ON a.id = g.agent_id AND a.company_id = $1 WHERE ($2::uuid IS NULL OR g.agent_id = $2) ORDER BY g.created_at ASC, g.id ASC";

fn cell<'a, T>(row: &'a Row, idx: usize, column: &'static str) -> Result<T, KnowledgeDbError>
where
    T: FromSql<'a>,
{
    row.try_get(idx)
        .map_err(|err| KnowledgeDbError::UndecodableRow {
            column,
            detail: err.to_string(),
        })
}

/// The fallible half of node decoding: enum columns arrive as raw text and
/// must parse inside the closed sets — anything else fails closed.
fn node_enums(
    node_type: &str,
    status: &str,
) -> Result<(KnowledgeNodeType, KnowledgeNodeStatus), KnowledgeDbError> {
    Ok((
        KnowledgeNodeType::parse(node_type)?,
        KnowledgeNodeStatus::parse(status)?,
    ))
}

fn kb_from_row(row: &Row) -> Result<KnowledgeBaseRow, KnowledgeDbError> {
    Ok(KnowledgeBaseRow {
        id: cell(row, 0, "id")?,
        company_id: cell(row, 1, "company_id")?,
        name: cell(row, 2, "name")?,
        kb_type: KnowledgeBaseType::parse(&cell::<String>(row, 3, "type")?)?,
        description: cell(row, 4, "description")?,
        max_token_budget: cell(row, 5, "max_token_budget")?,
        config_json: cell(row, 6, "config_json")?,
        created_at: cell(row, 7, "created_at")?,
        updated_at: cell(row, 8, "updated_at")?,
    })
}

fn node_from_row(row: &Row) -> Result<KnowledgeNodeRow, KnowledgeDbError> {
    let (node_type, status) = node_enums(
        &cell::<String>(row, 8, "node_type")?,
        &cell::<String>(row, 10, "status")?,
    )?;
    Ok(KnowledgeNodeRow {
        id: cell(row, 0, "id")?,
        company_id: cell(row, 1, "company_id")?,
        kb_id: cell(row, 2, "kb_id")?,
        parent_id: cell(row, 3, "parent_id")?,
        slug: cell(row, 4, "slug")?,
        title: cell(row, 5, "title")?,
        summary: cell(row, 6, "summary")?,
        content: cell(row, 7, "content")?,
        node_type,
        certified: cell(row, 9, "certified")?,
        status,
        tags: cell(row, 11, "tags")?,
        linked_node_ids: cell(row, 12, "linked_node_ids")?,
        source_refs: cell(row, 13, "source_refs")?,
        created_at: cell(row, 14, "created_at")?,
        updated_at: cell(row, 15, "updated_at")?,
    })
}

fn grant_from_row(row: &Row) -> Result<AgentKbGrantRow, KnowledgeDbError> {
    Ok(AgentKbGrantRow {
        id: cell(row, 0, "id")?,
        agent_id: cell(row, 1, "agent_id")?,
        kb_id: cell(row, 2, "kb_id")?,
        granted_by: cell(row, 3, "granted_by")?,
        created_at: cell(row, 4, "created_at")?,
    })
}

/// Column names for the `Some(..)` fields of an update, in fixed declaration
/// order — this order is the parameter order of `update_knowledge_node_fenced`.
fn update_set_columns(input: &UpdateKnowledgeNodeInput) -> Vec<&'static str> {
    [
        ("title", input.new_title.is_some()),
        ("summary", input.new_summary.is_some()),
        ("content", input.new_content.is_some()),
        ("status", input.new_status.is_some()),
        ("certified", input.new_certified.is_some()),
    ]
    .into_iter()
    .filter_map(|(col, set)| set.then_some(col))
    .collect()
}

/// Single guarded UPDATE text: `$1..$4` are company/kb/node/expected
/// `updated_at`; each supplied column takes the next dense index `$5..`.
fn fenced_update_sql(cols: &[&'static str]) -> String {
    let assignments = cols
        .iter()
        .enumerate()
        .map(|(i, col)| format!("{col} = ${}", i + 5))
        .collect::<Vec<_>>()
        .join(", ");
    format!("UPDATE knowledge_nodes SET {assignments}, updated_at = now() WHERE company_id = $1 AND kb_id = $2 AND id = $3 AND updated_at = $4 RETURNING {NODE_COLUMNS}")
}

fn fenced_row(row: Option<Row>) -> Result<KnowledgeNodeRow, KnowledgeDbError> {
    node_from_row(&row.ok_or(KnowledgeDbError::Fenced)?)
}

pub fn list_knowledge_bases(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
) -> Result<Vec<KnowledgeBaseRow>, KnowledgeDbError> {
    let rows = tx.query(SQL_LIST_KNOWLEDGE_BASES, &[&company_id])?;
    rows.iter().map(kb_from_row).collect()
}

pub fn get_knowledge_node(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    kb_id: Uuid,
    node_id: Uuid,
) -> Result<KnowledgeNodeRow, KnowledgeDbError> {
    let row = tx.query_opt(SQL_GET_KNOWLEDGE_NODE, &[&company_id, &kb_id, &node_id])?;
    node_from_row(&row.ok_or(KnowledgeDbError::NotFound)?)
}

pub fn list_knowledge_nodes_by_kb(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    kb_id: Uuid,
) -> Result<Vec<KnowledgeNodeRow>, KnowledgeDbError> {
    let rows = tx.query(SQL_LIST_KNOWLEDGE_NODES_BY_KB, &[&company_id, &kb_id])?;
    rows.iter().map(node_from_row).collect()
}

pub fn list_agent_kb_grants(
    tx: &mut Transaction<'_>,
    company_id: Uuid,
    agent_id: Option<Uuid>,
) -> Result<Vec<AgentKbGrantRow>, KnowledgeDbError> {
    let rows = tx.query(SQL_LIST_AGENT_KB_GRANTS, &[&company_id, &agent_id])?;
    rows.iter().map(grant_from_row).collect()
}

/// Single guarded UPDATE: no `SELECT ... FOR UPDATE` is taken because the
/// `updated_at = $4` predicate is itself the fence. Zero rows => `Fenced`.
/// Params are pushed in the same declaration order as `update_set_columns`.
pub fn update_knowledge_node_fenced(
    tx: &mut Transaction<'_>,
    input: &UpdateKnowledgeNodeInput,
) -> Result<KnowledgeNodeRow, KnowledgeDbError> {
    let cols = update_set_columns(input);
    if cols.is_empty() {
        return Err(KnowledgeDbError::EmptyUpdate);
    }
    let status: Option<&'static str> = input.new_status.map(|s| s.as_str());
    let mut params: Vec<&(dyn ToSql + Sync)> = Vec::with_capacity(4 + cols.len());
    params.push(&input.company_id);
    params.push(&input.kb_id);
    params.push(&input.node_id);
    params.push(&input.expected_updated_at);
    if let Some(v) = &input.new_title {
        params.push(v);
    }
    if let Some(v) = &input.new_summary {
        params.push(v);
    }
    if let Some(v) = &input.new_content {
        params.push(v);
    }
    if status.is_some() {
        params.push(&status);
    }
    if let Some(v) = &input.new_certified {
        params.push(v);
    }
    let sql = fenced_update_sql(&cols);
    let row = tx.query_opt(&sql, &params)?;
    fenced_row(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn input() -> UpdateKnowledgeNodeInput {
        UpdateKnowledgeNodeInput {
            company_id: Uuid::new_v4(),
            kb_id: Uuid::new_v4(),
            node_id: Uuid::new_v4(),
            expected_updated_at: Utc::now(),
            new_title: None,
            new_summary: None,
            new_content: None,
            new_status: None,
            new_certified: None,
        }
    }

    #[test]
    fn fenced_update_sets_only_supplied_fields() {
        let mut full = input();
        full.new_title = Some("t".into());
        full.new_summary = Some("s".into());
        full.new_content = Some("c".into());
        full.new_status = Some(KnowledgeNodeStatus::Retired);
        full.new_certified = Some(true);
        assert_eq!(
            update_set_columns(&full),
            ["title", "summary", "content", "status", "certified"]
        );
        let sql = fenced_update_sql(&update_set_columns(&full));
        assert!(sql.contains(
            "SET title = $5, summary = $6, content = $7, status = $8, certified = $9, updated_at = now()"
        ));
        assert!(sql.contains(
            "WHERE company_id = $1 AND kb_id = $2 AND id = $3 AND updated_at = $4"
        ));
        assert!(sql.contains(NODE_COLUMNS));

        let mut partial = input();
        partial.new_title = Some("t".into());
        partial.new_certified = Some(false);
        let sql = fenced_update_sql(&update_set_columns(&partial));
        assert!(sql.contains("SET title = $5, certified = $6, updated_at = now()"));
        assert!(!sql.contains("summary =") && !sql.contains("status = $"));
    }

    #[test]
    fn fenced_update_requires_a_field_and_maps_zero_rows_to_fenced() {
        // update_knowledge_node_fenced gates EmptyUpdate on this before SQL.
        assert!(update_set_columns(&input()).is_empty());
        assert!(matches!(fenced_row(None), Err(KnowledgeDbError::Fenced)));
    }

    #[test]
    fn grants_sql_scopes_company_through_joins() {
        // agent_kb_grants has no company_id column of its own.
        assert!(SQL_LIST_AGENT_KB_GRANTS
            .contains("JOIN knowledge_bases kb ON kb.id = g.kb_id AND kb.company_id = $1"));
        assert!(SQL_LIST_AGENT_KB_GRANTS
            .contains("JOIN agents a ON a.id = g.agent_id AND a.company_id = $1"));
        assert!(SQL_LIST_AGENT_KB_GRANTS.contains("$2::uuid IS NULL OR g.agent_id = $2"));
        assert!(SQL_LIST_AGENT_KB_GRANTS.contains("ORDER BY g.created_at ASC, g.id ASC"));
    }

    #[test]
    fn node_decoder_rejects_wrong_typed_cells() {
        assert!(matches!(
            node_enums("weird", "active"),
            Err(KnowledgeDbError::InvalidEnumValue {
                column: "knowledge_nodes.node_type",
                ..
            })
        ));
        assert!(matches!(
            node_enums("concept", "archived"),
            Err(KnowledgeDbError::InvalidEnumValue {
                column: "knowledge_nodes.status",
                ..
            })
        ));
        assert_eq!(
            node_enums("policy", "retired").unwrap(),
            (KnowledgeNodeType::Policy, KnowledgeNodeStatus::Retired)
        );
    }
}

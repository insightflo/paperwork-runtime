#![forbid(unsafe_code)]

//! Company-scoped direct-PG access to the knowledge domain: `knowledge_bases`,
//! `knowledge_nodes`, and `agent_kb_grants`, plus one fenced node update.
//! Mirrors `crates/engine-approval`: closed enums parse fail-closed, and every
//! SQL statement carries `company_id` in its WHERE clause — `agent_kb_grants`
//! has no `company_id` column (packages/db/src/schema/agent_kb_grants.ts), so
//! it is scoped through joins to `knowledge_bases` and `agents`.
//!
//! `CompanyMismatch` is intentionally folded into [`KnowledgeDbError::NotFound`]:
//! `company_id` is in every predicate, so a foreign id is indistinguishable
//! from a missing row — no existence signal leaks across companies.
//!
//! `update_knowledge_node_fenced` uses a single guarded `UPDATE` (preferred
//! over `SELECT ... FOR UPDATE` — `kb-nodes.ts`'s upsert sets `updated_at` on
//! every write): `updated_at = $4` is part of the predicate, so zero rows means
//! the node changed or vanished — [`KnowledgeDbError::Fenced`], caller re-reads.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

mod queries;

pub use queries::*;

macro_rules! closed_enum {
    ($ty:ident, $all:ident, $column:literal; $($variant:ident = $name:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $ty {
            $($variant),+
        }

        const $all: &[$ty] = &[$($ty::$variant),+];

        impl $ty {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $($ty::$variant => $name),+
                }
            }

            /// Fail-closed parse: values outside the closed set are an error,
            /// never coerced to a default.
            pub fn parse(raw: &str) -> Result<$ty, KnowledgeDbError> {
                $all.iter()
                    .copied()
                    .find(|s| s.as_str() == raw)
                    .ok_or_else(|| KnowledgeDbError::InvalidEnumValue {
                        column: $column,
                        value: raw.to_string(),
                    })
            }
        }
    };
}

closed_enum!(KnowledgeBaseType, ALL_KB_TYPES, "knowledge_bases.type";
    Static = "static",
    Rag = "rag",
    Ontology = "ontology",
);

closed_enum!(KnowledgeNodeType, ALL_NODE_TYPES, "knowledge_nodes.node_type";
    Concept = "concept",
    Entity = "entity",
    Glossary = "glossary",
    Fact = "fact",
    Index = "index",
    // Beyond the schema comment's five values: Quality RSI canon sync writes
    // "policy" (server/src/services/knowledge/kb-tree-admin.ts:183,200).
    Policy = "policy",
);

closed_enum!(KnowledgeNodeStatus, ALL_NODE_STATUSES, "knowledge_nodes.status";
    Active = "active",
    Retired = "retired",
);

/// Failure modes of the knowledge DB layer. All variants fail closed.
#[derive(Debug)]
pub enum KnowledgeDbError {
    /// Row absent or owned by another company (indistinguishable by design).
    NotFound,
    /// A text cell held a value outside the closed enum for `column`.
    InvalidEnumValue { column: &'static str, value: String },
    /// Fenced update matched zero rows (stale `expected_updated_at` or wrong
    /// company/kb/id); caller must re-read before retrying.
    Fenced,
    /// A returned row had a cell that could not be decoded to the Rust type.
    UndecodableRow { column: &'static str, detail: String },
    /// `update_knowledge_node_fenced` was called with every field `None`.
    EmptyUpdate,
    /// Underlying driver error.
    Db(postgres::Error),
}

impl fmt::Display for KnowledgeDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(f, "knowledge row not found for this company"),
            Self::InvalidEnumValue { column, value } => {
                write!(f, "invalid enum value for {column}: {value}")
            }
            Self::Fenced => write!(f, "fenced update lost the race; re-read and retry"),
            Self::UndecodableRow { column, detail } => {
                write!(f, "could not decode column {column}: {detail}")
            }
            Self::EmptyUpdate => write!(f, "fenced update requires at least one field"),
            Self::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for KnowledgeDbError {}

impl From<postgres::Error> for KnowledgeDbError {
    fn from(err: postgres::Error) -> Self {
        KnowledgeDbError::Db(err)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct KnowledgeBaseRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub name: String,
    pub kb_type: KnowledgeBaseType,
    pub description: String,
    pub max_token_budget: i32,
    pub config_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KnowledgeNodeRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub kb_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub node_type: KnowledgeNodeType,
    pub certified: bool,
    pub status: KnowledgeNodeStatus,
    pub tags: Vec<String>,
    pub linked_node_ids: Vec<String>,
    pub source_refs: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentKbGrantRow {
    pub id: Uuid,
    pub agent_id: Uuid,
    pub kb_id: Uuid,
    pub granted_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct UpdateKnowledgeNodeInput {
    pub company_id: Uuid,
    pub kb_id: Uuid,
    pub node_id: Uuid,
    pub expected_updated_at: DateTime<Utc>,
    pub new_title: Option<String>,
    pub new_summary: Option<String>,
    pub new_content: Option<String>,
    pub new_status: Option<KnowledgeNodeStatus>,
    pub new_certified: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! roundtrip {
        ($all:expr, $ty:ty) => {
            for &v in $all {
                let json = serde_json::to_value(v).unwrap();
                assert_eq!(json, serde_json::json!(v.as_str()));
                assert_eq!(serde_json::from_value::<$ty>(json).unwrap(), v);
                assert_eq!(<$ty>::parse(v.as_str()).unwrap(), v);
            }
        };
    }

    #[test]
    fn enums_parse_and_serde_roundtrip() {
        roundtrip!(ALL_KB_TYPES, KnowledgeBaseType);
        roundtrip!(ALL_NODE_TYPES, KnowledgeNodeType);
        roundtrip!(ALL_NODE_STATUSES, KnowledgeNodeStatus);
    }

    #[test]
    fn enum_parse_fails_closed_on_unknown_values() {
        use KnowledgeDbError::InvalidEnumValue as Bad;
        assert!(matches!(
            KnowledgeBaseType::parse("hybrid"),
            Err(Bad { column: "knowledge_bases.type", value }) if value == "hybrid"
        ));
        assert!(matches!(
            KnowledgeNodeType::parse("chapter"),
            Err(Bad { column: "knowledge_nodes.node_type", .. })
        ));
        assert!(matches!(
            KnowledgeNodeStatus::parse("archived"),
            Err(Bad { column: "knowledge_nodes.status", .. })
        ));
        // "policy" is a live node_type (kb-tree-admin.ts writes it); must parse.
        assert_eq!(KnowledgeNodeType::parse("policy").unwrap(), KnowledgeNodeType::Policy);
    }

    #[test]
    fn sql_constants_are_parameterized_and_company_scoped() {
        for sql in [
            SQL_LIST_KNOWLEDGE_BASES,
            SQL_GET_KNOWLEDGE_NODE,
            SQL_LIST_KNOWLEDGE_NODES_BY_KB,
            SQL_LIST_AGENT_KB_GRANTS,
        ] {
            assert!(sql.contains("company_id"), "{sql}");
            assert!(sql.contains('$'), "{sql}");
            assert!(!sql.contains("${"), "{sql}");
        }
        assert!(SQL_LIST_KNOWLEDGE_BASES.contains("FROM knowledge_bases"));
        assert!(SQL_LIST_KNOWLEDGE_BASES.contains("company_id = $1"));
        for sql in [SQL_LIST_KNOWLEDGE_BASES, SQL_LIST_KNOWLEDGE_NODES_BY_KB] {
            assert!(sql.contains("ORDER BY created_at ASC, id ASC"), "{sql}");
        }
        assert!(SQL_GET_KNOWLEDGE_NODE.contains("WHERE company_id = $1 AND kb_id = $2 AND id = $3"));
        assert!(SQL_LIST_KNOWLEDGE_NODES_BY_KB.contains("WHERE company_id = $1 AND kb_id = $2"));
        for sql in [SQL_GET_KNOWLEDGE_NODE, SQL_LIST_KNOWLEDGE_NODES_BY_KB] {
            assert!(sql.contains(NODE_COLUMNS), "{sql}");
        }
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn pg_company_scope_and_fencing() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (c1, c2, k1, a1, a2, n1) =
            (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut tx = c.transaction().unwrap();
        for (cid, name) in [(c1, "c1"), (c2, "c2")] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,$2,$3)", &[&cid, &name, &format!("K{cid}")]).unwrap();
        }
        for (aid, cid, nm) in [(a1, c1, "a1"), (a2, c2, "a2")] {
            tx.execute("INSERT INTO agents (id,company_id,name) VALUES ($1,$2,$3)", &[&aid, &cid, &nm]).unwrap();
        }
        tx.execute("INSERT INTO knowledge_bases (id,company_id,name,type) VALUES ($1,$2,'kb','static')", &[&k1, &c1]).unwrap();
        for aid in [a1, a2] {
            tx.execute("INSERT INTO agent_kb_grants (agent_id,kb_id,granted_by) VALUES ($1,$2,'u')", &[&aid, &k1]).unwrap();
        }
        tx.execute("INSERT INTO knowledge_nodes (id,company_id,kb_id,slug,title) VALUES ($1,$2,$3,'n1','N1')", &[&n1, &c1, &k1]).unwrap();

        assert_eq!(list_knowledge_bases(&mut tx, c1).unwrap().len(), 1);
        assert!(list_knowledge_bases(&mut tx, c2).unwrap().is_empty());
        let node = get_knowledge_node(&mut tx, c1, k1, n1).unwrap();
        assert!(matches!(get_knowledge_node(&mut tx, c2, k1, n1), Err(KnowledgeDbError::NotFound)));
        assert_eq!(list_knowledge_nodes_by_kb(&mut tx, c1, k1).unwrap().len(), 1);
        // a2 belongs to c2: its grant is filtered by the agents join.
        assert_eq!(list_agent_kb_grants(&mut tx, c1, None).unwrap().len(), 1);
        assert!(list_agent_kb_grants(&mut tx, c1, Some(a2)).unwrap().is_empty());

        let stale = Utc::now() - chrono::Duration::days(1);
        let upd = |expected, title: Option<String>| UpdateKnowledgeNodeInput {
            company_id: c1, kb_id: k1, node_id: n1, expected_updated_at: expected,
            new_title: title, new_summary: None, new_content: None,
            new_status: None, new_certified: None,
        };
        assert!(matches!(update_knowledge_node_fenced(&mut tx, &upd(stale, Some("x".into()))), Err(KnowledgeDbError::Fenced)));
        let updated = update_knowledge_node_fenced(&mut tx, &upd(node.updated_at, Some("N2".into()))).unwrap();
        assert_eq!(updated.title, "N2");
        assert!(updated.updated_at >= node.updated_at);
        // Any expected_updated_at that is not the stored one still loses.
        assert!(matches!(update_knowledge_node_fenced(&mut tx, &upd(stale, Some("N3".into()))), Err(KnowledgeDbError::Fenced)));

        // Illegal raw status fails closed at decode, not silently coerced.
        tx.execute("UPDATE knowledge_nodes SET status='archived' WHERE id = $1", &[&n1]).unwrap();
        assert!(matches!(
            get_knowledge_node(&mut tx, c1, k1, n1),
            Err(KnowledgeDbError::InvalidEnumValue { column: "knowledge_nodes.status", .. })
        ));
        tx.rollback().unwrap();
    }
}

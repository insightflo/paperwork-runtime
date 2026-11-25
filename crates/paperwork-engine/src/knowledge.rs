#![forbid(unsafe_code)]
//! knowledge.* JSON-RPC methods: company-scoped knowledge base, node, and
//! agent-grant reads, plus one fenced node update. All PG I/O reuses
//! heartbeat.rs's hardened direct-PG path (exec_db): loopback-only DSN
//! apply-or-reject, DNS permit cap, deadline-gated commit (-32001..
//! -32005), driver abort. Param gates are fail-closed: non-object params or
//! schema mismatch => -32602; update_node_fenced requires at least one new_*
//! field and non-blank text values before any PG I/O. The fenced update
//! re-implements engine-knowledge's guarded UPDATE over the shared
//! tokio-postgres transaction: dynamic SET list for exactly the supplied
//! fields, updated_at in the predicate as the fence (the domain crate's
//! decode/update helpers are sync-postgres flavored and do not cross).
use chrono::{DateTime, Utc};
use paperclip_provider_auth_core::ProbeEnv;
use paperwork_engine_knowledge::{AgentKbGrantRow, KnowledgeBaseRow, KnowledgeBaseType, KnowledgeNodeRow, KnowledgeNodeStatus, KnowledgeNodeType, NODE_COLUMNS, SQL_GET_KNOWLEDGE_NODE, SQL_LIST_AGENT_KB_GRANTS, SQL_LIST_KNOWLEDGE_BASES, SQL_LIST_KNOWLEDGE_NODES_BY_KB};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_postgres::{types::{FromSql, ToSql}, Client, Row};
use uuid::Uuid;
use crate::heartbeat::{err, exec_db, pre, DbOp, Fail, OpFut, Step, DBERR};

const OP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct BasesP { company_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct NodeP { company_id: Uuid, kb_id: Uuid, node_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct NodesP { company_id: Uuid, kb_id: Uuid }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct GrantsP { company_id: Uuid, #[serde(default)] agent_id: Option<Uuid> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct UpdateP { company_id: Uuid, kb_id: Uuid, node_id: Uuid, expected_updated_at: DateTime<Utc>, #[serde(default)] new_title: Option<String>, #[serde(default)] new_summary: Option<String>, #[serde(default)] new_content: Option<String>, #[serde(default)] new_status: Option<KnowledgeNodeStatus>, #[serde(default)] new_certified: Option<bool> }

enum Db { Bases(BasesP), Node(NodeP), Nodes(NodesP), Grants(GrantsP), Update(UpdateP) }
impl DbOp for Db { fn run<'x>(self, c: &'x mut Client) -> OpFut<'x> { Box::pin(run_op(c, self)) } }

fn col<'x, T: FromSql<'x>>(r: &'x Row, i: usize) -> Result<T, Fail> { r.try_get(i).map_err(|_| DBERR) }
fn to_kb(r: &Row) -> Result<KnowledgeBaseRow, Fail> { Ok(KnowledgeBaseRow {
    id: col(r, 0)?, company_id: col(r, 1)?, name: col(r, 2)?, kb_type: KnowledgeBaseType::parse(&col::<String>(r, 3)?).map_err(|_| DBERR)?,
    description: col(r, 4)?, max_token_budget: col(r, 5)?, config_json: col(r, 6)?, created_at: col(r, 7)?, updated_at: col(r, 8)? }) }
fn to_node(r: &Row) -> Result<KnowledgeNodeRow, Fail> { Ok(KnowledgeNodeRow {
    id: col(r, 0)?, company_id: col(r, 1)?, kb_id: col(r, 2)?, parent_id: col(r, 3)?, slug: col(r, 4)?, title: col(r, 5)?, summary: col(r, 6)?,
    content: col(r, 7)?, node_type: KnowledgeNodeType::parse(&col::<String>(r, 8)?).map_err(|_| DBERR)?, certified: col(r, 9)?,
    status: KnowledgeNodeStatus::parse(&col::<String>(r, 10)?).map_err(|_| DBERR)?, tags: col(r, 11)?, linked_node_ids: col(r, 12)?,
    source_refs: col(r, 13)?, created_at: col(r, 14)?, updated_at: col(r, 15)? }) }
fn to_grant(r: &Row) -> Result<AgentKbGrantRow, Fail> { Ok(AgentKbGrantRow {
    id: col(r, 0)?, agent_id: col(r, 1)?, kb_id: col(r, 2)?, granted_by: col(r, 3)?, created_at: col(r, 4)? }) }
fn kb_json(k: &KnowledgeBaseRow) -> Value { json!({
    "id": k.id, "company_id": k.company_id, "name": k.name, "kb_type": k.kb_type.as_str(), "description": k.description,
    "max_token_budget": k.max_token_budget, "config_json": k.config_json, "created_at": k.created_at, "updated_at": k.updated_at }) }
fn node_json(n: &KnowledgeNodeRow) -> Value { json!({
    "id": n.id, "company_id": n.company_id, "kb_id": n.kb_id, "parent_id": n.parent_id, "slug": n.slug, "title": n.title, "summary": n.summary,
    "content": n.content, "node_type": n.node_type.as_str(), "certified": n.certified, "status": n.status.as_str(), "tags": n.tags,
    "linked_node_ids": n.linked_node_ids, "source_refs": n.source_refs, "created_at": n.created_at, "updated_at": n.updated_at }) }
fn grant_json(g: &AgentKbGrantRow) -> Value { json!({
    "id": g.id, "agent_id": g.agent_id, "kb_id": g.kb_id, "granted_by": g.granted_by, "created_at": g.created_at }) }
fn applied_json(o: Option<KnowledgeNodeRow>) -> Value { match o { Some(n) => json!({"applied": true, "node": node_json(&n)}), None => json!({"applied": false, "reason": "fenced"}) } }

/// Mirror of engine-knowledge's fenced_update_sql: $1..$4 are
/// company/kb/node/expected updated_at; supplied columns take dense $5..
fn update_sql(cols: &[&'static str]) -> String {
    let set = cols.iter().enumerate().map(|(i, c)| format!("{c} = ${}", i + 5)).collect::<Vec<_>>().join(", ");
    format!("UPDATE knowledge_nodes SET {set}, updated_at = now() WHERE company_id = $1 AND kb_id = $2 AND id = $3 AND updated_at = $4 RETURNING {NODE_COLUMNS}")
}

async fn run_op<'x>(c: &'x mut Client, m: Db) -> Result<Step<'x>, Fail> {
    let tx = c.transaction().await.map_err(pre)?;
    Ok(match m {
        Db::Bases(p) => {
            let rows = tx.query(SQL_LIST_KNOWLEDGE_BASES, &[&p.company_id]).await.map_err(pre)?;
            let kbs = rows.iter().map(|r| to_kb(r).map(|k| kb_json(&k))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"kbs": kbs})) // read-only: tx dropped, never committed
        }
        Db::Node(p) => {
            let node = tx.query_opt(SQL_GET_KNOWLEDGE_NODE, &[&p.company_id, &p.kb_id, &p.node_id]).await.map_err(pre)?.map(|r| to_node(&r)).transpose()?;
            Step::Done(json!({"node": node.map(|n| node_json(&n))})) // read-only: tx dropped, never committed
        }
        Db::Nodes(p) => {
            let rows = tx.query(SQL_LIST_KNOWLEDGE_NODES_BY_KB, &[&p.company_id, &p.kb_id]).await.map_err(pre)?;
            let nodes = rows.iter().map(|r| to_node(r).map(|n| node_json(&n))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"nodes": nodes})) // read-only: tx dropped, never committed
        }
        Db::Grants(p) => {
            let rows = tx.query(SQL_LIST_AGENT_KB_GRANTS, &[&p.company_id, &p.agent_id]).await.map_err(pre)?;
            let grants = rows.iter().map(|r| to_grant(r).map(|g| grant_json(&g))).collect::<Result<Vec<_>, _>>()?;
            Step::Done(json!({"grants": grants})) // read-only: tx dropped, never committed
        }
        Db::Update(p) => {
            let status: Option<&'static str> = p.new_status.map(|s| s.as_str());
            let mut cols: Vec<&'static str> = Vec::with_capacity(5);
            let mut params: Vec<&(dyn ToSql + Sync)> = Vec::with_capacity(9);
            params.push(&p.company_id); params.push(&p.kb_id); params.push(&p.node_id); params.push(&p.expected_updated_at);
            if let Some(v) = &p.new_title { cols.push("title"); params.push(v); }
            if let Some(v) = &p.new_summary { cols.push("summary"); params.push(v); }
            if let Some(v) = &p.new_content { cols.push("content"); params.push(v); }
            if status.is_some() { cols.push("status"); params.push(&status); }
            if let Some(v) = &p.new_certified { cols.push("certified"); params.push(v); }
            let row = tx.query_opt(&update_sql(&cols), &params).await.map_err(pre)?.map(|r| to_node(&r)).transpose()?;
            Step::Commit(tx, applied_json(row))
        }
    })
}

/// Strict fail-closed gates: params must be a JSON object matching the method
/// schema exactly (-32602). update_node_fenced also rejects an empty update
/// (no new_* field) and blank text values before any PG I/O.
pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    macro_rules! need { ($t:ty) => { match params.filter(|p| p.is_object()).and_then(|p| serde_json::from_value::<$t>(p.clone()).ok()) { Some(v) => v, None => return err(id, -32602, "invalid_params") } } }
    match method {
        "knowledge.list_bases" => { let p = need!(BasesP); exec_db(id, env, OP_TIMEOUT, Db::Bases(p)) }
        "knowledge.get_node" => { let p = need!(NodeP); exec_db(id, env, OP_TIMEOUT, Db::Node(p)) }
        "knowledge.list_nodes" => { let p = need!(NodesP); exec_db(id, env, OP_TIMEOUT, Db::Nodes(p)) }
        "knowledge.list_agent_grants" => { let p = need!(GrantsP); exec_db(id, env, OP_TIMEOUT, Db::Grants(p)) }
        "knowledge.update_node_fenced" => {
            let p = need!(UpdateP);
            let empty = p.new_title.is_none() && p.new_summary.is_none() && p.new_content.is_none() && p.new_status.is_none() && p.new_certified.is_none();
            let blank = [&p.new_title, &p.new_summary, &p.new_content].iter().any(|s| s.as_deref().is_some_and(|v| v.trim().is_empty()));
            if empty || blank { return err(id, -32602, "invalid_params") }
            exec_db(id, env, OP_TIMEOUT, Db::Update(p))
        }
        _ => err(id, -32601, "method_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(u: &str) -> ProbeEnv { ProbeEnv::from_pairs(&[("DATABASE_URL", u)]) }
    fn call(m: &str, p: Value, e: &ProbeEnv) -> Value { dispatch_with(json!(1), m, Some(&p), e) }
    fn code(v: &Value) -> i64 { v["error"]["code"].as_i64().unwrap_or(0) }

    #[test]
    fn param_gates_and_unknown_method() {
        let (u, e, t) = (Uuid::nil(), env(""), "2026-01-01T00:00:00Z");
        for (m, p) in [
            ("knowledge.list_bases", json!([])), ("knowledge.list_bases", json!({})),
            ("knowledge.list_bases", json!({"company_id":u,"x":0})),
            ("knowledge.get_node", json!({"company_id":u,"kb_id":u})),
            ("knowledge.get_node", json!({"company_id":u,"kb_id":u,"node_id":u,"y":1})),
            ("knowledge.list_nodes", json!({"company_id":u})),
            ("knowledge.list_nodes", json!({"company_id":u,"kb_id":u,"z":2})),
            ("knowledge.list_agent_grants", json!({})),
            ("knowledge.list_agent_grants", json!({"company_id":u,"agent_id":"x","w":1})),
            ("knowledge.update_node_fenced", json!({})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t,"new_title":"  "})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t,"new_status":"bogus"})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":"n/a","new_title":"t"})),
            ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t,"new_certified":true,"v":1})),
        ] { assert_eq!(code(&call(m, p, &e)), -32602, "{m}"); }
        // -32602 with an empty DATABASE_URL proves rejection happened before any PG I/O.
        assert_eq!(code(&dispatch_with(json!(1), "knowledge.list_bases", None, &e)), -32602);
        assert_eq!(code(&call("knowledge.nope", json!({}), &e)), -32601);
    }

    #[test]
    fn db_unconfigured_gate_for_all_methods() {
        let (u, t) = (Uuid::nil(), "2026-01-01T00:00:00Z");
        for e in [ProbeEnv::from_pairs(&[]), env(""), env("host=192.0.2.1 port=1 user=u sslmode=disable")] {
            for (m, p) in [
                ("knowledge.list_bases", json!({"company_id":u})),
                ("knowledge.get_node", json!({"company_id":u,"kb_id":u,"node_id":u})),
                ("knowledge.list_nodes", json!({"company_id":u,"kb_id":u})),
                ("knowledge.list_agent_grants", json!({"company_id":u})),
                ("knowledge.list_agent_grants", json!({"company_id":u,"agent_id":u})),
                ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t,"new_title":"t"})),
                ("knowledge.update_node_fenced", json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":t,"new_status":"retired","new_certified":false})),
            ] { assert_eq!(code(&call(m, p, &e)), -32002, "{m}"); }
        }
    }

    #[test]
    fn every_status_variant_deserializes() {
        let u = Uuid::nil();
        for s in ["active", "retired"] {
            let p = json!({"company_id":u,"kb_id":u,"node_id":u,"expected_updated_at":"2026-01-01T00:00:00Z","new_status":s});
            assert_eq!(code(&call("knowledge.update_node_fenced", p, &env(""))), -32002, "{s}");
        }
    }

    #[test]
    fn enum_roundtrips_sql_constants_and_update_sql() {
        for (v, s) in [(KnowledgeBaseType::Static, "static"), (KnowledgeBaseType::Rag, "rag"), (KnowledgeBaseType::Ontology, "ontology")] {
            assert_eq!(serde_json::from_value::<KnowledgeBaseType>(json!(s)).unwrap(), v);
        }
        for s in ["concept", "entity", "glossary", "fact", "index", "policy"] {
            assert_eq!(serde_json::from_value::<KnowledgeNodeType>(json!(s)).unwrap().as_str(), s);
        }
        for s in ["active", "retired"] {
            assert_eq!(serde_json::to_value(KnowledgeNodeStatus::parse(s).unwrap()).unwrap(), json!(s));
        }
        // Compile-time proof the domain SQL constants are what run_op executes.
        for sql in [SQL_LIST_KNOWLEDGE_BASES, SQL_GET_KNOWLEDGE_NODE, SQL_LIST_KNOWLEDGE_NODES_BY_KB, SQL_LIST_AGENT_KB_GRANTS] {
            assert!(sql.contains("company_id") && sql.contains('$'), "{sql}");
        }
        assert!(update_sql(&["title", "certified"]).contains("SET title = $5, certified = $6, updated_at = now() WHERE company_id = $1 AND kb_id = $2 AND id = $3 AND updated_at = $4"));
    }

    #[test]
    fn health_lists_knowledge_capabilities_and_routes() {
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":1,"method":"engine.health"}"#, &env(""));
        let caps: Vec<&str> = r["result"]["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for m in ["knowledge.list_bases", "knowledge.get_node", "knowledge.list_nodes", "knowledge.list_agent_grants", "knowledge.update_node_fenced"] {
            assert!(caps.contains(&m), "missing {m}");
        }
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":2,"method":"knowledge.list_bases","params":{"company_id":"00000000-0000-0000-0000-000000000000"}}"#, &env(""));
        assert_eq!(code(&r), -32002);
        let r = crate::handle_with(br#"{"jsonrpc":"2.0","id":3,"method":"knowledge.bogus","params":{}}"#, &env(""));
        assert_eq!(code(&r), -32601);
    }
}

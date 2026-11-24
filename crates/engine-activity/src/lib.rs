#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorType {
    System,
    User,
    Agent,
    Plugin,
}

const ALL_ACTOR_TYPES: [ActorType; 4] = [
    ActorType::System,
    ActorType::User,
    ActorType::Agent,
    ActorType::Plugin,
];

impl ActorType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActorType::System => "system",
            ActorType::User => "user",
            ActorType::Agent => "agent",
            ActorType::Plugin => "plugin",
        }
    }

    pub fn parse(raw: &str) -> Result<ActorType, ActivityDbError> {
        ALL_ACTOR_TYPES
            .into_iter()
            .find(|t| t.as_str() == raw)
            .ok_or_else(|| ActivityDbError::InvalidActorType(raw.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperatorDecisionStatus {
    Pending,
    Resolved,
    Cancelled,
}

const ALL_DECISION_STATUSES: [OperatorDecisionStatus; 3] = [
    OperatorDecisionStatus::Pending,
    OperatorDecisionStatus::Resolved,
    OperatorDecisionStatus::Cancelled,
];

impl OperatorDecisionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OperatorDecisionStatus::Pending => "pending",
            OperatorDecisionStatus::Resolved => "resolved",
            OperatorDecisionStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Result<OperatorDecisionStatus, ActivityDbError> {
        ALL_DECISION_STATUSES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| ActivityDbError::InvalidDecisionStatus(raw.to_string()))
    }

    pub fn is_resolvable(&self) -> bool {
        matches!(self, OperatorDecisionStatus::Pending)
    }
}

#[derive(Debug)]
pub enum ActivityDbError {
    InvalidActorType(String),
    InvalidDecisionStatus(String),
    EmptyActorId,
    EmptyResolvedBy,
    EmptyField(&'static str),
    InvalidDetails,
    Fenced,
    UndecodableRow { column: String, detail: String },
    Db(postgres::Error),
}

impl fmt::Display for ActivityDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ActivityDbError::InvalidActorType(raw) => write!(f, "invalid actor_type: {raw}"),
            ActivityDbError::InvalidDecisionStatus(raw) => {
                write!(f, "invalid operator_decisions.status: {raw}")
            }
            ActivityDbError::EmptyActorId => write!(f, "empty actor_id"),
            ActivityDbError::EmptyResolvedBy => write!(f, "empty resolved_by_user_id"),
            ActivityDbError::EmptyField(name) => write!(f, "empty {name}"),
            ActivityDbError::InvalidDetails => write!(f, "details must be a JSON object"),
            ActivityDbError::Fenced => write!(f, "fenced write precondition failed"),
            ActivityDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable row column {column}: {detail}")
            }
            ActivityDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for ActivityDbError {}

impl From<postgres::Error> for ActivityDbError {
    fn from(err: postgres::Error) -> Self {
        ActivityDbError::Db(err)
    }
}

pub fn ensure_decision_resolvable(status: OperatorDecisionStatus) -> Result<(), ActivityDbError> {
    if status.is_resolvable() { Ok(()) } else { Err(ActivityDbError::Fenced) }
}

#[derive(Debug)]
pub struct AppendActivityEventInput {
    pub company_id: Uuid,
    pub actor_type: ActorType,
    pub actor_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub agent_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug)]
pub struct ResolveOperatorDecisionInput {
    pub decision_id: Uuid,
    pub company_id: Uuid,
    pub result: serde_json::Value,
    pub resolved_by_user_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_type_parse_and_serde_roundtrip() {
        for actor in ALL_ACTOR_TYPES {
            let json = serde_json::to_value(actor).unwrap();
            assert_eq!(json, serde_json::json!(actor.as_str()));
            assert_eq!(serde_json::from_value::<ActorType>(json).unwrap(), actor);
            assert_eq!(ActorType::parse(actor.as_str()).unwrap(), actor);
        }
        for bad in ["", "board", "SYSTEM", "mission_owner", "ghost"] {
            assert!(matches!(
                ActorType::parse(bad),
                Err(ActivityDbError::InvalidActorType(raw)) if raw == bad
            ));
        }
        assert!(serde_json::from_value::<ActorType>(serde_json::json!("board")).is_err());
    }

    #[test]
    fn decision_status_parse_serde_and_resolvable() {
        for status in ALL_DECISION_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<OperatorDecisionStatus>(json).unwrap(), status);
            assert_eq!(OperatorDecisionStatus::parse(status.as_str()).unwrap(), status);
        }
        for bad in ["", "approved", "PENDING", "done"] {
            assert!(matches!(
                OperatorDecisionStatus::parse(bad),
                Err(ActivityDbError::InvalidDecisionStatus(raw)) if raw == bad
            ));
        }
        let resolvable: Vec<bool> = ALL_DECISION_STATUSES.iter().map(|s| s.is_resolvable()).collect();
        assert_eq!(resolvable, [true, false, false]);
    }

    #[test]
    fn ensure_decision_resolvable_fences_terminal_states() {
        assert!(ensure_decision_resolvable(OperatorDecisionStatus::Pending).is_ok());
        for s in [OperatorDecisionStatus::Resolved, OperatorDecisionStatus::Cancelled] {
            assert!(matches!(ensure_decision_resolvable(s), Err(ActivityDbError::Fenced)));
        }
    }

    #[test]
    fn error_display_covers_every_variant() {
        let cases: Vec<(ActivityDbError, &str)> = vec![
            (ActivityDbError::InvalidActorType("x".into()), "invalid actor_type: x"),
            (
                ActivityDbError::InvalidDecisionStatus("x".into()),
                "invalid operator_decisions.status: x",
            ),
            (ActivityDbError::EmptyActorId, "empty actor_id"),
            (ActivityDbError::EmptyResolvedBy, "empty resolved_by_user_id"),
            (ActivityDbError::EmptyField("action"), "empty action"),
            (ActivityDbError::InvalidDetails, "details must be a JSON object"),
            (ActivityDbError::Fenced, "fenced write precondition failed"),
            (
                ActivityDbError::UndecodableRow { column: "id".into(), detail: "boom".into() },
                "undecodable row column id: boom",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
            let _: &dyn std::error::Error = &err;
        }
    }

    fn event_input(company_id: Uuid, entity_id: &str) -> AppendActivityEventInput {
        AppendActivityEventInput {
            company_id,
            actor_type: ActorType::System,
            actor_id: "engine-test".to_string(),
            action: "engine.test_appended".to_string(),
            entity_type: "issue".to_string(),
            entity_id: entity_id.to_string(),
            agent_id: None,
            run_id: None,
            details: Some(serde_json::json!({"k": 1})),
        }
    }

    fn resolve_input(decision_id: Uuid, company_id: Uuid) -> ResolveOperatorDecisionInput {
        ResolveOperatorDecisionInput {
            decision_id,
            company_id,
            result: serde_json::json!({"actionId": "a1", "outcome": "approve"}),
            resolved_by_user_id: "u1".to_string(),
        }
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_company_scoping_and_resolve_fencing() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() { return; }
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut tx = c.transaction().unwrap();
        for (cid, prefix) in [(a, format!("A{a}")), (b, format!("B{b}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix]).unwrap();
        }
        // append: validation errors must fire before any PG I/O
        let mut bad = event_input(a, "X");
        bad.details = Some(serde_json::json!([1, 2]));
        assert!(matches!(
            append_activity_event(&mut tx, &bad),
            Err(ActivityDbError::InvalidDetails)
        ));
        bad.details = None; bad.actor_id = "  ".to_string();
        assert!(matches!(
            append_activity_event(&mut tx, &bad),
            Err(ActivityDbError::EmptyActorId)
        ));
        let appended = append_activity_event(&mut tx, &event_input(a, "ISS-1")).unwrap();
        append_activity_event(&mut tx, &event_input(b, "ISS-2")).unwrap();
        let list_a = list_activity_events(&mut tx, a, None, Some("issue"), Some("ISS-1"), 50).unwrap();
        assert!(list_a.iter().any(|r| r.id == appended.id) && list_a.iter().all(|r| r.company_id == a));
        assert!(list_activity_events(&mut tx, b, None, None, Some("ISS-1"), 50).unwrap().is_empty());
        // operator_decisions scratch cards (schema-free minimal columns)
        let insert_card = "INSERT INTO operator_decisions (id, company_id, request_key, request_hash, status, priority, interaction_type, title, source_type, source_id, definition) VALUES ($1,$2,$3,'h','pending','medium','action','t','test','s','{}'::jsonb)";
        let (d1, d2, d3) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        for (did, cid, key) in [(d1, a, "k1"), (d2, a, "k2"), (d3, b, "k3")] {
            tx.execute(insert_card, &[&did, &cid, &key]).unwrap();
        }
        // resolve: validation errors must fire before any PG I/O
        let mut blocked = resolve_input(d2, a);
        blocked.resolved_by_user_id = " ".to_string();
        assert!(matches!(
            resolve_operator_decision_fenced(&mut tx, &blocked),
            Err(ActivityDbError::EmptyResolvedBy)
        ));
        blocked.resolved_by_user_id = "u".to_string(); blocked.result = serde_json::json!(["x"]);
        assert!(matches!(
            resolve_operator_decision_fenced(&mut tx, &blocked),
            Err(ActivityDbError::InvalidDetails)
        ));
        let resolved = resolve_operator_decision_fenced(&mut tx, &resolve_input(d1, a)).unwrap()
            .expect("pending card must resolve");
        assert_eq!(resolved.status, OperatorDecisionStatus::Resolved);
        assert!(resolved.resolved_by_user_id.as_deref() == Some("u1") && resolved.resolved_at.is_some());
        // fenced miss: replay, cross-company, and unknown id all yield None
        for input in [resolve_input(d1, a), resolve_input(d2, b), resolve_input(Uuid::new_v4(), a)] {
            assert!(resolve_operator_decision_fenced(&mut tx, &input).unwrap().is_none());
        }
        let pending_a = list_operator_decisions(&mut tx, a, Some(OperatorDecisionStatus::Pending), 50).unwrap();
        assert!(pending_a.iter().all(|r| r.company_id == a && r.status == OperatorDecisionStatus::Pending));
        assert!(pending_a.iter().any(|r| r.id == d2) && pending_a.iter().all(|r| r.id != d1));
        assert!(list_operator_decisions(&mut tx, a, None, 50).unwrap().iter().all(|r| r.company_id == a));
        tx.rollback().unwrap();
    }
}

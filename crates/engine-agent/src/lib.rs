#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Active,
    Paused,
    Idle,
    Running,
    Error,
    PendingApproval,
    Terminated,
}

const ALL_STATUSES: [AgentStatus; 7] = [
    AgentStatus::Active,
    AgentStatus::Paused,
    AgentStatus::Idle,
    AgentStatus::Running,
    AgentStatus::Error,
    AgentStatus::PendingApproval,
    AgentStatus::Terminated,
];

const STATUS_NAMES: [&str; 7] = [
    "active",
    "paused",
    "idle",
    "running",
    "error",
    "pending_approval",
    "terminated",
];

impl AgentStatus {
    pub fn as_str(&self) -> &'static str {
        STATUS_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<AgentStatus, AgentDbError> {
        ALL_STATUSES
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or_else(|| AgentDbError::InvalidStatus(raw.to_string()))
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, AgentStatus::Terminated)
    }
}

#[derive(Debug)]
pub enum AgentDbError {
    InvalidStatus(String),
    InvalidTransition { from: AgentStatus, to: AgentStatus },
    NotFound,
    Fenced,
    UndecodableRow { column: &'static str, detail: String },
    Db(postgres::Error),
}

impl fmt::Display for AgentDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentDbError::InvalidStatus(raw) => write!(f, "invalid agent status: {raw}"),
            AgentDbError::InvalidTransition { from, to } => write!(
                f,
                "illegal agent status transition: {} -> {}",
                from.as_str(),
                to.as_str()
            ),
            AgentDbError::NotFound => write!(f, "agent not found"),
            AgentDbError::Fenced => write!(f, "agent did not match company/id/status fence"),
            AgentDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable row column {column}: {detail}")
            }
            AgentDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for AgentDbError {}

impl From<postgres::Error> for AgentDbError {
    fn from(err: postgres::Error) -> Self {
        AgentDbError::Db(err)
    }
}

// Legality matrix for agents.status transitions, mirroring
// server/src/services/agents.ts:
// - terminated is terminal: updateAgent/pause/resume all refuse it.
// - pending_approval is gated: it leaves only through the approve path
//   (activatePendingApproval -> idle) or the terminate path. TS pause() guards
//   only terminated, but this crate treats pending_approval as gated
//   end-to-end and stays fail-closed.
// - the operational set {active, paused, idle, running, error} is fully
//   connected minus self-loops: pause() accepts every non-terminal source,
//   resume() lands on idle or running from any non-gated source including
//   error recovery, and runtime failures may set error from any operational
//   state. active is treated as an idle-equivalent display state.
// - pending_approval is never a legal target: no service path assigns it
//   after row creation.
// - self-transitions are rejected: they are no-ops and fail-closed keeps
//   callers explicit about expected current state.
pub fn validate_agent_transition(
    from: AgentStatus,
    to: AgentStatus,
) -> Result<(), AgentDbError> {
    use AgentStatus::*;
    let legal = match from {
        Terminated => false,
        PendingApproval => matches!(to, Idle | Terminated),
        Active | Paused | Idle | Running | Error => {
            from != to && !matches!(to, PendingApproval)
        }
    };
    if !legal {
        return Err(AgentDbError::InvalidTransition { from, to });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AgentStatus::*;
    use super::*;

    const LEGAL: &[(AgentStatus, AgentStatus)] = &[
        (Active, Paused), (Active, Idle), (Active, Running), (Active, Error), (Active, Terminated),
        (Paused, Active), (Paused, Idle), (Paused, Running), (Paused, Error), (Paused, Terminated),
        (Idle, Active), (Idle, Paused), (Idle, Running), (Idle, Error), (Idle, Terminated),
        (Running, Active), (Running, Paused), (Running, Idle), (Running, Error), (Running, Terminated),
        (Error, Active), (Error, Paused), (Error, Idle), (Error, Running), (Error, Terminated),
        (PendingApproval, Idle), (PendingApproval, Terminated),
    ];

    #[test]
    fn legal_transition_matrix() {
        for from in ALL_STATUSES {
            for to in ALL_STATUSES {
                assert_eq!(
                    validate_agent_transition(from, to).is_ok(),
                    LEGAL.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn invalid_transition_reports_from_to() {
        assert!(matches!(
            validate_agent_transition(Terminated, Idle),
            Err(AgentDbError::InvalidTransition { from: Terminated, to: Idle })
        ));
        assert!(matches!(
            validate_agent_transition(Paused, PendingApproval),
            Err(AgentDbError::InvalidTransition { from: Paused, to: PendingApproval })
        ));
        assert!(matches!(
            validate_agent_transition(PendingApproval, Paused),
            Err(AgentDbError::InvalidTransition { from: PendingApproval, to: Paused })
        ));
        assert!(matches!(
            validate_agent_transition(Idle, Idle),
            Err(AgentDbError::InvalidTransition { from: Idle, to: Idle })
        ));
    }

    #[test]
    fn status_parse_and_serde_roundtrip() {
        for status in ALL_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<AgentStatus>(json).unwrap(), status);
            assert_eq!(AgentStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(matches!(
            AgentStatus::parse("done"),
            Err(AgentDbError::InvalidStatus(raw)) if raw == "done"
        ));
        assert!(Terminated.is_terminal());
        assert!(!Idle.is_terminal() && !Error.is_terminal());
    }

    #[test]
    fn error_variants_match_and_display() {
        let undecodable = AgentDbError::UndecodableRow {
            column: "status",
            detail: "boom".to_string(),
        };
        assert!(matches!(undecodable, AgentDbError::UndecodableRow { column: "status", .. }));
        assert!(undecodable.to_string().contains("status"));
        assert!(matches!(AgentDbError::Fenced, AgentDbError::Fenced));
        assert!(matches!(AgentDbError::NotFound, AgentDbError::NotFound));
        let invalid = AgentDbError::InvalidStatus("x".to_string());
        assert_eq!(invalid.to_string(), "invalid agent status: x");
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn live_pg_company_scoping_fencing_and_transitions() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let (ca, cb, ga, gb) =
            (uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let mut tx = c.transaction().unwrap();
        for (cid, prefix) in [(ca, format!("A{ca}")), (cb, format!("B{cb}"))] {
            tx.execute("INSERT INTO companies (id,name,issue_prefix) VALUES ($1,'t',$2)", &[&cid, &prefix])
                .unwrap();
        }
        for (aid, cid) in [(ga, ca), (gb, cb)] {
            tx.execute("INSERT INTO agents (id,company_id,name) VALUES ($1,$2,'x')", &[&aid, &cid])
                .unwrap();
        }
        let input = |from: AgentStatus, to: AgentStatus, company, reason: Option<&str>| {
            TransitionAgentStatusInput {
                company_id: company,
                agent_id: ga,
                from_status: from,
                to_status: to,
                pause_reason: reason.map(String::from),
            }
        };
        assert!(get_agent(&mut tx, ca, ga).unwrap().is_some());
        assert!(get_agent(&mut tx, ca, gb).unwrap().is_none());
        assert_eq!(list_agents_by_company(&mut tx, ca).unwrap().len(), 1);
        let paused =
            transition_agent_status_fenced(&mut tx, &input(Idle, Paused, ca, None)).unwrap();
        assert_eq!(paused.status, Paused);
        assert_eq!(paused.pause_reason.as_deref(), Some("manual"));
        assert!(paused.paused_at.is_some());
        let idle =
            transition_agent_status_fenced(&mut tx, &input(Paused, Idle, ca, None)).unwrap();
        assert_eq!(idle.status, Idle);
        assert!(idle.pause_reason.is_none());
        assert!(idle.paused_at.is_none());
        let held =
            transition_agent_status_fenced(&mut tx, &input(Idle, Paused, ca, Some("hold"))).unwrap();
        assert_eq!(held.pause_reason.as_deref(), Some("hold"));
        let running =
            transition_agent_status_fenced(&mut tx, &input(Paused, Running, ca, None)).unwrap();
        assert_eq!(running.status, Running);
        assert!(running.pause_reason.is_none());
        assert!(running.paused_at.is_none());
        for bad_fence in [input(Idle, Paused, ca, None), input(Running, Paused, cb, None)] {
            assert!(matches!(
                transition_agent_status_fenced(&mut tx, &bad_fence),
                Err(AgentDbError::Fenced)
            ));
        }
        for (from, to) in [(Running, PendingApproval), (Paused, PendingApproval)] {
            assert!(matches!(
                transition_agent_status_fenced(&mut tx, &input(from, to, ca, None)),
                Err(AgentDbError::InvalidTransition { .. })
            ));
        }
        let term =
            transition_agent_status_fenced(&mut tx, &input(Running, Terminated, ca, None)).unwrap();
        assert_eq!(term.status, Terminated);
        let tool = uuid::Uuid::new_v4();
        tx.execute("INSERT INTO tool_definitions (id,company_id,name,adapter_type) VALUES ($1,$2,'t','x')", &[&tool, &ca])
            .unwrap();
        tx.execute("INSERT INTO agent_task_sessions (id,company_id,agent_id,adapter_type,task_key) VALUES ($1,$2,$3,'p','k')", &[&uuid::Uuid::new_v4(), &ca, &ga])
            .unwrap();
        tx.execute("INSERT INTO agent_tool_grants (id,company_id,agent_id,tool_id,granted_by) VALUES ($1,$2,$3,$4,'u')", &[&uuid::Uuid::new_v4(), &ca, &ga, &tool])
            .unwrap();
        assert_eq!(list_agent_task_sessions(&mut tx, ca, None).unwrap().len(), 1);
        assert!(list_agent_task_sessions(&mut tx, ca, Some(gb)).unwrap().is_empty());
        assert_eq!(list_agent_tool_grants(&mut tx, ca, Some(ga)).unwrap().len(), 1);
        assert!(list_agent_tool_grants(&mut tx, cb, None).unwrap().is_empty());
        tx.rollback().unwrap();
    }
}

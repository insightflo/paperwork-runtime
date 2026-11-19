use chrono::{DateTime, SecondsFormat, Utc};
use postgres::Client;
use serde_json::json;
use uuid::Uuid;

pub const Q_EXECUTOR_QUIESCENCE: &str = "executor_quiescence";
pub const Q_WORKSPACE_OPS_SETTLED: &str = "workspace_operations_settled";
pub const Q_RUNTIME_SERVICES_STOPPED: &str = "runtime_services_stopped";
pub const Q_MISSION_RUNTIME_IDLE: &str = "mission_runtime_idle";

pub const C_ISSUE_PROMOTION: &str = "issue_promotion";
pub const C_WORKFLOW_EVIDENCE_SYNC: &str = "workflow_evidence_sync";

#[derive(Debug, Clone)]
pub struct HeartbeatRunRow {
    pub id: Uuid,
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub issue_id: Option<Uuid>,
    pub status: String,
    pub wakeup_request_id: Option<Uuid>,
    pub workflow_step_run_id: Option<Uuid>,
    pub workflow_execution_generation: Option<i32>,
    pub execution_scope_kind: Option<String>,
    pub execution_epoch: Option<i32>,
    pub execution_token: Option<Uuid>,
    pub executor_owner_id: Option<String>,
    pub executor_owner_released_at: Option<DateTime<Utc>>,
    pub terminal_outcome: Option<String>,
    pub terminal_decision_source: Option<String>,
    pub finalization_version: i32,
    pub settled_at: Option<DateTime<Utc>>,
    pub process_pid: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageClass {
    Q,
    C,
}

#[derive(Debug, Clone)]
pub struct RequiredStage {
    pub kind: &'static str,
    pub class: StageClass,
}

pub fn load_run(client: &mut Client, run_id: Uuid) -> Result<Option<HeartbeatRunRow>, postgres::Error> {
    let row = client.query_opt(
        "SELECT id, company_id, agent_id, issue_id, status, wakeup_request_id,
                workflow_step_run_id, workflow_execution_generation, execution_scope_kind,
                execution_epoch, execution_token, executor_owner_id,
                executor_owner_released_at, terminal_outcome, terminal_decision_source,
                finalization_version, settled_at, process_pid
         FROM heartbeat_runs WHERE id = $1 LIMIT 1",
        &[&run_id],
    )?;
    Ok(row.map(|r| HeartbeatRunRow {
        id: r.get(0),
        company_id: r.get(1),
        agent_id: r.get(2),
        issue_id: r.get(3),
        status: r.get(4),
        wakeup_request_id: r.get(5),
        workflow_step_run_id: r.get(6),
        workflow_execution_generation: r.get(7),
        execution_scope_kind: r.get(8),
        execution_epoch: r.get(9),
        execution_token: r.get(10),
        executor_owner_id: r.get(11),
        executor_owner_released_at: r.get(12),
        terminal_outcome: r.get(13),
        terminal_decision_source: r.get(14),
        finalization_version: r.get(15),
        settled_at: r.get(16),
        process_pid: r.get(17),
    }))
}

pub fn required_stages_for_run(run: &HeartbeatRunRow) -> Vec<RequiredStage> {
    let scope = run.execution_scope_kind.as_deref().unwrap_or("legacy");
    let mut stages = vec![
        RequiredStage { kind: Q_EXECUTOR_QUIESCENCE, class: StageClass::Q },
        RequiredStage { kind: Q_WORKSPACE_OPS_SETTLED, class: StageClass::Q },
        RequiredStage { kind: Q_RUNTIME_SERVICES_STOPPED, class: StageClass::Q },
    ];
    if scope == "mission_nonworkflow" || scope == "workflow_step" {
        stages.push(RequiredStage { kind: Q_MISSION_RUNTIME_IDLE, class: StageClass::Q });
    }
    if scope == "workflow_step" {
        stages.push(RequiredStage { kind: C_WORKFLOW_EVIDENCE_SYNC, class: StageClass::C });
    }
    if run.issue_id.is_some() {
        stages.push(RequiredStage { kind: C_ISSUE_PROMOTION, class: StageClass::C });
    }
    stages
}

pub fn is_pid_absent(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 probes process existence without delivering a signal.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return false;
    }
    // EPERM proves the process exists under another UID, so remain fail-closed.
    std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)
}

pub fn is_executor_process_absent(run: &HeartbeatRunRow) -> bool {
    if run.executor_owner_released_at.is_none() {
        return false;
    }
    match run.process_pid {
        None => true,
        Some(pid) => is_pid_absent(pid),
    }
}

fn no_running_workspace_ops(client: &mut Client, run_id: Uuid) -> Result<bool, postgres::Error> {
    let count: i64 = client.query_one(
        "SELECT count(*)::bigint FROM workspace_operations
         WHERE heartbeat_run_id = $1 AND status = 'running'",
        &[&run_id],
    )?.get(0);
    Ok(count == 0)
}

fn runtime_services_stopped(client: &mut Client, run_id: Uuid) -> Result<bool, postgres::Error> {
    let active: i64 = client.query_one(
        "SELECT count(*)::bigint FROM workspace_runtime_services
         WHERE started_by_run_id = $1 AND status <> 'stopped' AND stopped_at IS NULL",
        &[&run_id],
    )?.get(0);
    Ok(active == 0)
}

fn mission_runtime_idle(client: &mut Client, run: &HeartbeatRunRow) -> Result<bool, postgres::Error> {
    let scope = run.execution_scope_kind.as_deref().unwrap_or("");
    if scope != "workflow_step" && scope != "mission_nonworkflow" {
        return Ok(true);
    }
    let active: i64 = client.query_one(
        "SELECT count(*)::bigint FROM mission_agent_runtimes
         WHERE last_run_id = $1
           AND status IN ('starting', 'ready', 'busy', 'stopping')
           AND stopped_at IS NULL",
        &[&run.id],
    )?.get(0);
    Ok(active == 0)
}

pub fn observe_quiescence_proof(
    client: &mut Client,
    run: &HeartbeatRunRow,
) -> Result<Option<serde_json::Value>, postgres::Error> {
    let exec_ok = is_executor_process_absent(run);
    let ops_ok = no_running_workspace_ops(client, run.id)?;
    let svc_ok = runtime_services_stopped(client, run.id)?;
    let mission_ok = mission_runtime_idle(client, run)?;
    if !(exec_ok && ops_ok && svc_ok && mission_ok) {
        return Ok(None);
    }
    Ok(Some(json!({
        "observedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "checks": {
            Q_EXECUTOR_QUIESCENCE: exec_ok,
            Q_WORKSPACE_OPS_SETTLED: ops_ok,
            Q_RUNTIME_SERVICES_STOPPED: svc_ok,
            Q_MISSION_RUNTIME_IDLE: mission_ok,
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_probe_guards_non_positive_and_detects_live_process() {
        assert!(!is_pid_absent(0));
        assert!(!is_pid_absent(-1));
        assert!(!is_pid_absent(std::process::id() as i32));
        assert!(is_pid_absent(999_999_999));
    }
}

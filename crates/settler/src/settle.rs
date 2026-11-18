use std::collections::HashMap;
use chrono::{DateTime, Utc};
use postgres::{Client, Transaction};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::quiescence::{
    observe_quiescence_proof, required_stages_for_run, HeartbeatRunRow, StageClass,
    Q_EXECUTOR_QUIESCENCE, Q_MISSION_RUNTIME_IDLE, Q_RUNTIME_SERVICES_STOPPED,
    Q_WORKSPACE_OPS_SETTLED,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettlementOutcome {
    Settled,
    NotReady,
    BlockedNonCompensable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusReleased {
    pub company_id: Uuid,
    pub agent_id: Uuid,
    pub outcome: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledRunReport {
    pub run_id: Uuid,
    pub company_id: Uuid,
    pub issue_id: Option<Uuid>,
    pub workflow_step_run_id: Option<Uuid>,
    pub agent_status_released: Option<AgentStatusReleased>,
}

fn ensure_finalization(client: &mut Client, run: &HeartbeatRunRow) -> Result<(Uuid, String), postgres::Error> {
    let epoch = run.execution_epoch.unwrap_or(0);
    let token = run.execution_token.unwrap_or_else(Uuid::new_v4);
    let outcome = run.terminal_outcome.as_deref().unwrap_or("failed");
    let source = run.terminal_decision_source.as_deref().unwrap_or("unknown");
    let inserted = client.query_opt(
        "INSERT INTO heartbeat_run_finalizations (
           company_id, heartbeat_run_id, execution_epoch, execution_token,
           terminal_outcome, terminal_decision_source, finalization_version, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (heartbeat_run_id) DO NOTHING RETURNING id, state",
        &[&run.company_id, &run.id, &epoch, &token, &outcome, &source, &run.finalization_version],
    )?;
    if let Some(row) = inserted {
        return Ok((row.get(0), row.get(1)));
    }
    let row = client.query_one(
        "SELECT id, state FROM heartbeat_run_finalizations WHERE heartbeat_run_id = $1",
        &[&run.id],
    )?;
    Ok((row.get(0), row.get(1)))
}

fn record_stage_ignore_conflict(
    client: &mut Client,
    run: &HeartbeatRunRow,
    fin_id: Uuid,
    stage_class: &str,
    stage_kind: &str,
    idem_key: &str,
    payload: &serde_json::Value,
) {
    let _ = client.execute(
        "INSERT INTO heartbeat_run_finalization_steps (
           company_id, heartbeat_run_id, heartbeat_run_finalization_id,
           stage_class, stage_kind, idempotency_key, state, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, 'done', $7)
         ON CONFLICT (company_id, heartbeat_run_id, stage_kind, idempotency_key) DO NOTHING",
        &[&run.company_id, &run.id, &fin_id, &stage_class, &stage_kind, &idem_key, &payload],
    );
}

fn read_step_generation(tx: &mut Transaction<'_>, step_id: Uuid, company_id: Uuid, run_id: Uuid) -> Result<(Option<DateTime<Utc>>, i32), String> {
    let row = tx.query_opt(
        "SELECT sr.dispatch_ready_at, sr.execution_generation
         FROM workflow_step_runs sr INNER JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
         WHERE sr.id = $1 AND wr.company_id = $2 LIMIT 1",
        &[&step_id, &company_id],
    ).map_err(|e| e.to_string())?;
    let Some(r) = row else {
        return Err(format!("Cannot settle heartbeat {run_id}: linked workflow step run {step_id} was not found"));
    };
    Ok((r.get(0), r.get(1)))
}

fn sync_linked_workflow_step_in_tx(tx: &mut Transaction<'_>, run: &HeartbeatRunRow, step_id: Uuid, now: DateTime<Utc>) -> Result<(), String> {
    let expected_gen = run.workflow_execution_generation.ok_or_else(|| {
        format!("Cannot settle heartbeat {}: linked workflow execution generation is missing", run.id)
    })?;
    let (dispatch_ready_at, actual_gen) = read_step_generation(tx, step_id, run.company_id, run.id)?;
    if actual_gen != expected_gen || dispatch_ready_at.is_some() {
        return Ok(());
    }
    let updated = tx.query_opt(
        "UPDATE workflow_step_runs SET dispatch_ready_at = $1
         WHERE id = $2 AND execution_generation = $3 AND dispatch_ready_at IS NULL RETURNING id",
        &[&now, &step_id, &expected_gen],
    ).map_err(|e| e.to_string())?;
    if updated.is_some() {
        return Ok(());
    }
    let (_, fresh_gen) = read_step_generation(tx, step_id, run.company_id, run.id)?;
    if fresh_gen != expected_gen {
        return Ok(());
    }
    Err(format!("Cannot settle heartbeat {}: dispatch readiness CAS failed for {step_id}", run.id))
}

fn commit_settlement_tx(client: &mut Client, run: &HeartbeatRunRow, now: DateTime<Utc>) -> Result<bool, String> {
    let mut tx = client.transaction().map_err(|e| e.to_string())?;
    let settled = tx.query_opt(
        "UPDATE heartbeat_runs SET settled_at = $1, updated_at = $1
         WHERE id = $2 AND company_id = $3 AND finalization_version = 1 AND settled_at IS NULL RETURNING id",
        &[&now, &run.id, &run.company_id],
    ).map_err(|e| e.to_string())?;
    if settled.is_none() {
        return Ok(false);
    }
    if let Some(step_id) = run.workflow_step_run_id {
        sync_linked_workflow_step_in_tx(&mut tx, run, step_id, now)?;
    }
    let idem_key = format!("heartbeat-settled:{}", run.id);
    let payload = json!({
        "version": 1,
        "transition": "heartbeat_settled",
        "executionEpoch": run.execution_epoch,
        "terminalOutcome": run.terminal_outcome,
    });
    tx.execute(
        "INSERT INTO workflow_transition_events (
           company_id, workflow_run_id, workflow_step_run_id, issue_id, wakeup_request_id,
           heartbeat_run_id, execution_generation, executor_owner_id, event_type, layer,
           decision, reason, reason_code, idempotency_key, payload
         ) VALUES (
           $1, NULL, $2, $3, $4, $5, $6, $7,
           'workflow_authority_transition', 'workflow_authority', 'shadow_write',
           'heartbeat_settled', 'heartbeat_settled', $8, $9
         ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
        &[
            &run.company_id, &run.workflow_step_run_id, &run.issue_id, &run.wakeup_request_id,
            &run.id, &run.workflow_execution_generation, &run.executor_owner_id, &idem_key, &payload,
        ],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

fn settle_run_if_ready(client: &mut Client, run: &HeartbeatRunRow, fin_id: Uuid, fin_state: &str, now: DateTime<Utc>) -> Result<SettlementOutcome, String> {
    if run.finalization_version != 1 {
        return Ok(SettlementOutcome::NotReady);
    }
    let rows = client.query(
        "SELECT stage_kind, state FROM heartbeat_run_finalization_steps WHERE heartbeat_run_id = $1",
        &[&run.id],
    ).map_err(|e| e.to_string())?;
    let mut by_kind: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        by_kind.entry(row.get(0)).or_default().push(row.get(1));
    }
    let mut blocked = false;
    for stage in required_stages_for_run(run) {
        let states = by_kind.get(stage.kind).map(Vec::as_slice).unwrap_or(&[]);
        match stage.class {
            StageClass::Q => {
                if states.iter().any(|s| s == "dead_letter") {
                    blocked = true;
                } else if !states.iter().any(|s| s == "done") {
                    return Ok(SettlementOutcome::NotReady);
                }
            }
            StageClass::C => {
                if !states.iter().any(|s| s == "done" || s == "equivalent_failed") {
                    return Ok(SettlementOutcome::NotReady);
                }
            }
        }
    }
    if blocked {
        if fin_state != "blocked_noncompensable" {
            client.execute(
                "UPDATE heartbeat_run_finalizations SET state = 'blocked_noncompensable', updated_at = $1 WHERE id = $2",
                &[&now, &fin_id],
            ).map_err(|e| e.to_string())?;
        }
        return Ok(SettlementOutcome::BlockedNonCompensable);
    }
    Ok(if commit_settlement_tx(client, run, now)? { SettlementOutcome::Settled } else { SettlementOutcome::NotReady })
}

fn release_agent_display_status(client: &mut Client, run: &HeartbeatRunRow, now: DateTime<Utc>) -> Option<AgentStatusReleased> {
    let status: String = client.query_opt("SELECT status FROM agents WHERE id = $1 LIMIT 1", &[&run.agent_id]).ok()??.get(0);
    if status != "running" {
        return None;
    }
    let active: i64 = client.query_one(
        "SELECT count(*)::bigint FROM heartbeat_runs
         WHERE agent_id = $1 AND (status = 'running' OR (
             status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
             AND finalization_version = 1 AND settled_at IS NULL
         ))",
        &[&run.agent_id],
    ).ok()?.get(0);
    if active > 0 {
        return None;
    }
    let updated = client.query_opt(
        "UPDATE agents SET status = 'idle', updated_at = $1 WHERE id = $2 AND status = 'running' RETURNING company_id",
        &[&now, &run.agent_id],
    ).ok()??;
    Some(AgentStatusReleased { company_id: updated.get(0), agent_id: run.agent_id, outcome: run.status.clone() })
}

pub fn attempt_full_settlement_and_report(client: &mut Client, run: &HeartbeatRunRow, now: DateTime<Utc>) -> Result<Option<SettledRunReport>, String> {
    if run.finalization_version != 1 {
        return Ok(None);
    }
    let (fin_id, fin_state) = ensure_finalization(client, run).map_err(|e| e.to_string())?;
    if let Some(proof) = observe_quiescence_proof(client, run).map_err(|e| e.to_string())? {
        let payload = json!({ "source": "attempt_full_settlement", "proof": proof });
        for kind in [Q_EXECUTOR_QUIESCENCE, Q_WORKSPACE_OPS_SETTLED, Q_RUNTIME_SERVICES_STOPPED, Q_MISSION_RUNTIME_IDLE] {
            let key = format!("settle-q:{kind}:{}", run.id);
            record_stage_ignore_conflict(client, run, fin_id, "Q", kind, &key, &payload);
        }
    }
    let empty = json!({});
    for stage in required_stages_for_run(run) {
        if stage.class == StageClass::C {
            let key = format!("settle-c:{}:{}", stage.kind, run.id);
            record_stage_ignore_conflict(client, run, fin_id, "C", stage.kind, &key, &empty);
        }
    }
    if settle_run_if_ready(client, run, fin_id, &fin_state, now)? != SettlementOutcome::Settled {
        return Ok(None);
    }
    Ok(Some(SettledRunReport {
        run_id: run.id,
        company_id: run.company_id,
        issue_id: run.issue_id,
        workflow_step_run_id: run.workflow_step_run_id,
        agent_status_released: release_agent_display_status(client, run, now),
    }))
}

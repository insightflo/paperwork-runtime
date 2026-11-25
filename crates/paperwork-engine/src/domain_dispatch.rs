#![forbid(unsafe_code)]
//! Domain JSON-RPC dispatch for the extracted engine modules. Each domain owns
//! its parameter validation and database execution contract; this module only
//! routes by method prefix and exposes the integrated capability list.
use paperclip_provider_auth_core::ProbeEnv;
use serde_json::Value;

use crate::heartbeat::err;
use crate::{activity, agent, approval, company, cost, decision, issue, knowledge, mission, schedule, skill, tool, wiki, worktree};

pub(crate) const DOMAIN_CAPABILITIES: &[&str] = &[
    "activity.append_event", "activity.list_events", "activity.list_operator_decisions", "activity.resolve_operator_decision_fenced",
    "agent.get", "agent.list_by_company", "agent.list_task_sessions", "agent.list_tool_grants", "agent.transition_status_fenced",
    "approval.validate_transition", "approval.get", "approval.list", "approval.create", "approval.resolve_fenced", "approval.request_revision_fenced", "approval.resubmit_fenced", "approval.cancel_fenced",
    "company.list", "company.get_by_id", "company.get_by_issue_prefix", "company.create", "company.update", "company.pause", "company.resume", "company.next_issue_counter",
    "cost.record_event", "cost.list_events", "cost.summarize_window", "cost.get_spend_snapshot",
    "decision.list", "decision.get_by_id", "decision.get_by_request_key", "decision.create", "decision.resolve", "decision.cancel",
    "issue.get", "issue.list_by_company", "issue.list_issue_work_products", "issue.checkout_fenced", "issue.transition_status_fenced", "issue.release_checkout_fenced",
    "knowledge.list_bases", "knowledge.get_node", "knowledge.list_nodes", "knowledge.list_agent_grants", "knowledge.update_node_fenced",
    "mission.get", "mission.list_by_company", "mission.get_rolling_state", "mission.list_sessions", "mission.transition_status_fenced", "mission.bump_rolling_state_fenced",
    "schedule.validate_advance_window", "schedule.list_due", "schedule.advance_fenced", "schedule.set_enabled",
    "skill.list", "skill.get_by_id", "skill.get_by_key", "skill.upsert", "skill.delete",
    "tool.list_definitions", "tool.get_definition", "tool.list_skills", "tool.list_execution_receipts", "tool.claim_execution_receipt_idempotent",
    "wiki.record_failure", "wiki.search_relevant", "wiki.list", "wiki.mark_resolved", "wiki.close",
    "worktree.list", "worktree.get_by_id", "worktree.create", "worktree.update", "worktree.toggle_enabled", "worktree.delete",
];

pub(crate) fn dispatch_with(id: Value, method: &str, params: Option<&Value>, env: &ProbeEnv) -> Value {
    match method {
        m if m.starts_with("activity.") => activity::dispatch_with(id, m, params, env),
        m if m.starts_with("agent.") => agent::dispatch_with(id, m, params, env),
        m if m.starts_with("approval.") => approval::dispatch_with(id, m, params, env),
        m if m.starts_with("company.") => company::dispatch_with(id, m, params, env),
        m if m.starts_with("cost.") => cost::dispatch_with(id, m, params, env),
        m if m.starts_with("decision.") => decision::dispatch_with(id, m, params, env),
        m if m.starts_with("issue.") => issue::dispatch_with(id, m, params, env),
        m if m.starts_with("knowledge.") => knowledge::dispatch_with(id, m, params, env),
        m if m.starts_with("mission.") => mission::dispatch_with(id, m, params, env),
        m if m.starts_with("schedule.") => schedule::dispatch_with(id, m, params, env),
        m if m.starts_with("skill.") => skill::dispatch_with(id, m, params, env),
        m if m.starts_with("tool.") => tool::dispatch_with(id, m, params, env),
        m if m.starts_with("wiki.") => wiki::dispatch_with(id, m, params, env),
        m if m.starts_with("worktree.") => worktree::dispatch_with(id, m, params, env),
        _ => err(id, -32601, "method_not_found"),
    }
}

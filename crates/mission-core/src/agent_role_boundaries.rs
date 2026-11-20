//! Pure port of server/src/services/missions/agent-role-boundaries.ts —
//! Hermes Ops liaison detection/mode resolution, the liaison boundary
//! sentence, and the runnable mission-execution assignee status set.
//! Dynamic reads mirror JS property semantics (null/undefined throw V8
//! TypeError texts; other primitives box and read as `undefined`).
//! Err(_) → stderr + exit 1 like a TS throw.
use crate::js::read_string;
use crate::revision_delta::js_str_opt;
use serde_json::{json, Value};

pub const SUBCOMMANDS: &[&str] = &[
    "runnable-assignee-statuses",
    "is-runnable-assignee-status",
    "is-liaison-agent",
    "resolve-hermes-ops-mode",
    "resolve-hermes-ops-liaison-identity",
    "describe-liaison-boundary",
];

/// RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES — Set insertion order is the
/// wire order.
const RUNNABLE: [&str; 3] = ["active", "idle", "running"];

/// `agent.key` under JS semantics: null/undefined receiver → V8 TypeError
/// text; other non-objects box and read as `undefined` (no throw).
fn prop<'a>(agent: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match agent {
        None => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')")),
        Some(Value::Object(o)) => Ok(o.get(key)),
        Some(_) => Ok(None),
    }
}

fn is_liaison(agent: Option<&Value>) -> Result<bool, String> {
    if prop(agent, "adapterType")?.and_then(Value::as_str) != Some("hermes_local") {
        return Ok(false);
    }
    // TS also binds `metadata` via isRecord but never consumes it.
    let rc = prop(agent, "runtimeConfig")?.and_then(Value::as_object);
    let get = |k: &str| rc.and_then(|o| o.get(k));
    let flag = get("operationsLiaison").and_then(Value::as_bool) == Some(true)
        || get("hermesOpsMode").is_some_and(Value::is_string);
    let domain = get("domain").and_then(read_string);
    let mode = get("operatingMode").and_then(read_string);
    let name = prop(agent, "name")?.and_then(Value::as_str);
    Ok(flag
        || domain.as_deref() == Some("operations")
        || mode.as_deref() == Some("chief_of_staff_liaison")
        || mode.as_deref() == Some("independent_management_operator")
        || name == Some("Hermes Operations Manager")
        || name == Some("Hermes Ops Manager"))
}

/// Explicit runtimeConfig.hermesOpsMode wins only for the privileged trio;
/// anything else falls back to least-privilege "advisor". Untrimmed `as_str`
/// matches `typeof === "string"` + `===`.
fn hermes_mode(agent: Option<&Value>) -> Result<&str, String> {
    let raw = prop(agent, "runtimeConfig")?
        .and_then(Value::as_object)
        .and_then(|o| o.get("hermesOpsMode"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(match raw {
        "supervision" | "relay" | "admin" => raw,
        _ => "advisor",
    })
}

fn liaison_identity(agent: Option<&Value>) -> Result<Value, String> {
    if !is_liaison(agent)? {
        return Ok(json!({"isHermesOpsLiaison": false}));
    }
    Ok(json!({"isHermesOpsLiaison": true, "hermesOpsMode": hermes_mode(agent)?}))
}

fn describe_boundary(agent: Option<&Value>) -> Result<String, String> {
    let name = js_str_opt(prop(agent, "name")?);
    Ok(format!(
        "{name} is a Hermes operations liaison. It may monitor/report and signal the mission main executor, but it must not directly execute mission ACTION or QA issues."
    ))
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "runnable-assignee-statuses" => Ok(json!(RUNNABLE)),
        "is-runnable-assignee-status" => Ok(json!(
            RUNNABLE.contains(&input.get("status").and_then(Value::as_str).unwrap_or(""))
        )),
        "is-liaison-agent" => Ok(json!(is_liaison(input.get("agent"))?)),
        "resolve-hermes-ops-mode" => Ok(json!(hermes_mode(input.get("agent"))?)),
        "resolve-hermes-ops-liaison-identity" => liaison_identity(input.get("agent")),
        "describe-liaison-boundary" => Ok(json!(describe_boundary(input.get("agent"))?)),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

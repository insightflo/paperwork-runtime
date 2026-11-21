//! Helpers for the mission-plan-qa port: `v.key` reads with Node 24 V8 texts,
//! SameValueZero/`>`/join coercion, the tool artifact-contract selection
//! pipeline (mission-plan-publication-contract.ts), unit-role classification
//! (workflow-step-role.ts + mission-plan-unit-roles.ts), and the shared
//! dependency index (mission-plan-unit-dependencies.ts over plan_graph).
use crate::artifact_contract::artifact_contract_ok;
use crate::js::{js_to_string, js_trim, js_truthy, read_string, unique};
use crate::plan_graph;
use serde_json::{json, Value};

/// `v.key` — Err(_) mirrors "Cannot read properties of null|undefined (reading 'k')".
pub fn prop<'a>(v: Option<&'a Value>, k: &str) -> Result<Option<&'a Value>, String> {
    match v {
        None => Err(format!(
            "Cannot read properties of undefined (reading '{k}')"
        )),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{k}')")),
        Some(o) => Ok(o.get(k)),
    }
}
/// SameValueZero — objects/arrays are identity-keyed: serde's deep `==` forced false.
pub fn svz_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => !(a.is_object() || a.is_array() || b.is_object() || b.is_array()) && a == b,
    }
}
/// `!v` where absent models `undefined`.
pub fn falsy(v: Option<&Value>) -> bool {
    !v.is_some_and(js_truthy)
}
/// `arr.join(sep)` — null/undefined elements render "".
pub fn js_join(arr: &[Value], sep: &str) -> String {
    arr.iter()
        .map(|e| if e.is_null() { String::new() } else { js_to_string(Some(e)) })
        .collect::<Vec<_>>()
        .join(sep)
}
/// `new Set` dedup where `None` models `undefined` (distinct from `null`).
pub fn svz_eq_opt(a: &Option<Value>, b: &Option<Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => svz_eq(x, y),
        _ => false,
    }
}
/// `tokens.join(sep)` where `None` models `undefined` (also renders "").
pub fn js_join_opt(arr: &[Option<Value>], sep: &str) -> String {
    arr.iter()
        .map(|e| match e {
            Some(v) if !v.is_null() => js_to_string(Some(v)),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join(sep)
}
/// `Number(str)` — trims, honors 0x/0o/0b prefixes, NaN on failure.
fn js_num(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (pre, radix) in [("0x",16),("0X",16),("0o",8),("0O",8),("0b",2),("0B",2)] {
        if let Some(d) = t.strip_prefix(pre) {
            return u64::from_str_radix(d, radix).map(|v| v as f64).unwrap_or(f64::NAN);
        }
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}
/// `x > 0` after ToPrimitive/ToNumber (arrays join ",", objects → NaN).
pub fn js_gt_zero(v: Option<&Value>) -> bool {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_num(s),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Null) => 0.0,
        Some(Value::Array(a)) => js_num(&js_join(a, ",")),
        Some(Value::Object(_)) | None => f64::NAN,
    };
    n > 0.0
}
/// `unitDependsOn(dependencyIndex, from, target)` — DFS reachability.
pub fn unit_depends_on(deps: &[Vec<usize>], from: usize, target: usize) -> bool {
    let mut visited = std::collections::HashSet::new();
    let mut stack: Vec<usize> = deps.get(from).cloned().unwrap_or_default();
    while let Some(cur) = stack.pop() {
        if cur == target {
            return true;
        }
        if visited.insert(cur) {
            stack.extend(deps.get(cur).into_iter().flatten().copied());
        }
    }
    false
}
/// `buildDependencyIndex` — normalizer diagnostics become the thrown message.
pub fn build_dependency_index(units: &[Value]) -> Result<Vec<Vec<usize>>, String> {
    let n = plan_graph::normalize_mission_plan_dependency_graph(units, &[])?;
    if n.get("ok") == Some(&Value::Bool(true)) {
        return Ok(serde_json::from_value(n["graph"]["dependencyIndex"].clone()).unwrap_or_default());
    }
    let msgs: Vec<String> = n["diagnostics"].as_array()
        .map(|a| a.iter().filter_map(|d| d["message"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Err(format!(
        "Invalid canonical mission-plan dependency graph: {}",
        msgs.join("; ")
    ))
}
/// `selectedUnitToolNames` — `unit.toolName` is the first property read.
fn selected_unit_tool_names(unit: Option<&Value>) -> Result<Vec<String>, String> {
    let first = prop(unit, "toolName")?;
    let mut raw: Vec<&Value> = Vec::new();
    if let Some(v) = first {
        raw.push(v);
    }
    for key in ["toolNames", "tools"] {
        if let Some(Value::Array(a)) = prop(unit, key)? {
            raw.extend(a.iter());
        }
    }
    Ok(unique(raw.into_iter().filter_map(read_string).collect()))
}
/// `tools.flatMap` receiver check (`tool.enabled` is read per element later).
fn tools_array(tools: Option<&Value>) -> Result<&[Value], String> {
    match tools {
        Some(Value::Array(a)) => Ok(a),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'flatMap')".into()),
        None => Err("Cannot read properties of undefined (reading 'flatMap')".into()),
        Some(_) => Err("tools.flatMap is not a function".into()),
    }
}
/// `selectedArtifactContracts` — enabled + name-matched tools whose
/// `adapterConfig.artifactContract` passes artifactContractSchema.safeParse.
/// `prop(prop(.., "adapterConfig"), "artifactContract")` mirrors the chained
/// property read's exact undefined/null receiver texts.
pub fn selected_artifact_contracts<'a>(
    unit: Option<&Value>,
    tools: Option<&'a Value>,
) -> Result<Vec<&'a Value>, String> {
    let names = selected_unit_tool_names(unit)?;
    let mut out = Vec::new();
    for tool in tools_array(tools)? {
        if prop(Some(tool), "enabled")? == Some(&Value::Bool(false)) {
            continue;
        }
        if !prop(Some(tool), "name")?
            .and_then(Value::as_str)
            .is_some_and(|n| names.iter().any(|s| s == n))
        {
            continue;
        }
        let contract = prop(prop(Some(tool), "adapterConfig")?, "artifactContract")?;
        if let Some(c) = contract.filter(|c| artifact_contract_ok(Some(*c))) {
            out.push(c);
        }
    }
    Ok(out)
}
/// `hasPlanArtifactRole(unit, tools, role)`.
pub fn has_plan_artifact_role(
    unit: Option<&Value>,
    tools: Option<&Value>,
    role: &str,
) -> Result<bool, String> {
    Ok(selected_artifact_contracts(unit, tools)?
        .iter()
        .any(|c| c.get("role").and_then(Value::as_str) == Some(role)))
}
/// `resolveWorkflowQaContract` truthiness — `^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$`.
fn qa_type_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_lowercase() {
        return false;
    }
    let mut sep = false; // previous char was '-'/'_' → next must be [a-z0-9]
    for &c in &b[1..] {
        let word = c.is_ascii_lowercase() || c.is_ascii_digit();
        if !(word || ((c == b'-' || c == b'_') && !sep)) {
            return false;
        }
        sep = !word;
    }
    !sep
}
/// `classifyWorkflowStepRole(unit)` — qaType contract first, then lowercased type.
pub fn classify_workflow_step_role(unit: Option<&Value>) -> Result<&'static str, String> {
    if prop(unit, "qaType")?
        .and_then(Value::as_str)
        .is_some_and(|s| qa_type_ok(&js_trim(s).to_lowercase()))
    {
        return Ok("qa");
    }
    let ty = prop(unit, "type")?
        .and_then(Value::as_str)
        .map_or("", js_trim)
        .to_lowercase();
    Ok(match ty.as_str() {
        "qa" | "validation" | "validator" => "qa",
        "approval" | "oversight" => "oversight",
        "action" | "producer" | "research" => "action",
        _ => "unknown",
    })
}
/// `extractUnitRoles(unit, tools)` — publish/readbackQa/audienceSplit/scenario.
pub fn extract_unit_roles(unit: Option<&Value>, tools: Option<&Value>) -> Result<Value, String> {
    let publish = has_plan_artifact_role(unit, tools, "publication")?;
    let readback = classify_workflow_step_role(unit)? == "qa"
        || has_plan_artifact_role(unit, tools, "publication-verify")?;
    Ok(json!({
        "publish": publish,
        "readbackQa": readback,
        "audienceSplit": prop(unit, "audiences")?.and_then(Value::as_array).is_some_and(|a| a.len() > 1),
        "scenario": prop(unit, "scenarios")?.and_then(Value::as_array).is_some_and(|a| !a.is_empty()),
    }))
}
/// `intentSignalsByCategory(intent, category)` — deduped first-hit tokens.
/// `None` elements model `undefined` (absent `token` keys), which JS `Set`
/// treats as distinct from `null` — JSON.stringify renders both as null.
pub fn intent_signals_by_category(
    intent: Option<&Value>,
    category: &str,
) -> Result<Vec<Option<Value>>, String> {
    let arr: &[Value] = match prop(intent, "matchedSignals")? {
        Some(Value::Array(a)) => a,
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'filter')".into()),
        None => return Err("Cannot read properties of undefined (reading 'filter')".into()),
        Some(_) => return Err("intent.matchedSignals.filter is not a function".into()),
    };
    let mut out: Vec<Option<Value>> = Vec::new();
    for s in arr {
        if prop(Some(s), "category")?.and_then(Value::as_str) == Some(category) {
            let tok = prop(Some(s), "token")?.cloned();
            if !out.iter().any(|e| svz_eq_opt(e, &tok)) {
                out.push(tok);
            }
        }
    }
    Ok(out)
}
/// `intent.audiences.length > 0 ? intent.audiences.join(", ") : "복수 대상"`.
pub fn audiences_display(intent: Option<&Value>) -> Result<String, String> {
    let aud = prop(intent, "audiences")?;
    let gt = match aud {
        None => return Err("Cannot read properties of undefined (reading 'length')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'length')".into()),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Object(o)) => js_gt_zero(o.get("length")),
        Some(_) => false,
    };
    if !gt {
        return Ok("복수 대상".into());
    }
    match aud {
        Some(Value::Array(a)) => Ok(js_join(a, ", ")),
        _ => Err("intent.audiences.join is not a function".into()),
    }
}
/// `hasPostDeliveryReadbackQa` — every publish unit needs a downstream
/// readbackQa unit.
pub fn has_post_delivery_readback_qa(
    units: &[Value],
    tools: Option<&Value>,
) -> Result<bool, String> {
    let mut roles = Vec::with_capacity(units.len());
    for u in units {
        roles.push(extract_unit_roles(Some(u), tools)?);
    }
    let deps = build_dependency_index(units)?;
    if !roles.iter().any(|r| r["publish"] == Value::Bool(true)) {
        return Ok(false);
    }
    Ok(roles.iter().enumerate().all(|(i, r)| {
        r["publish"] != Value::Bool(true)
            || roles.iter().enumerate().any(|(qi, q)| {
                q["readbackQa"] == Value::Bool(true) && unit_depends_on(&deps, qi, i)
            })
    }))
}
/// `intent.audiences.join(", ")` — unconditional (clarification question text).
pub fn audiences_join(intent: Option<&Value>) -> Result<String, String> {
    match prop(intent, "audiences")? {
        Some(Value::Array(a)) => Ok(js_join(a, ", ")),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'join')".into()),
        None => Err("Cannot read properties of undefined (reading 'join')".into()),
        Some(_) => Err("intent.audiences.join is not a function".into()),
    }
}

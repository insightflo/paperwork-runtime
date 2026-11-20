//! Pure ports of server/src/services/workflow/delivery-verification-gate.ts and
//! server/src/services/missions/mission-plan-unit-contract.ts (the imported
//! step-contract.ts normalize tail is inlined where reachable). Err(_) mirrors
//! Node 24 V8 TypeError texts; dynamic reads go through crate::js shims.
use crate::artifact_contract::artifact_contract_ok;
use crate::js::{js_json_stringify, js_spread, js_to_string, js_trim, js_trim_end, js_truthy};
use crate::quality_contract_lines as qcl;
use serde_json::{json, Map, Value};

pub const SUBCOMMANDS: &[&str] = &["delivery-has-artifact-role", "delivery-is-relevant-step",
    "delivery-is-readback-step", "delivery-has-existing-readback", "delivery-append-criteria",
    "delivery-strengthen-readback-steps", "delivery-synthesize-gate-step", "delivery-build-criteria",
    "plan-unit-contract-lines", "plan-unit-step-contract", "plan-qa-unit-contract-lines"];

/// JS SameValueZero on parsed JSON (objects/arrays are reference-keyed: two
/// parsed instances never match even when deep-equal; -0.0 == 0.0).
fn svz_eq(a: &Value, b: &Value) -> bool {
    if a.is_object() || a.is_array() || b.is_object() || b.is_array() { return false; }
    match (a, b) { (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(), _ => a == b }
}
/// `v.key` — Err(_) mirrors "Cannot read properties of null|undefined (reading 'k')".
fn prop<'a>(v: Option<&'a Value>, k: &str) -> Result<Option<&'a Value>, String> {
    match v { None => Err(format!("Cannot read properties of undefined (reading '{k}')")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{k}')")), Some(o) => Ok(o.get(k)) }
}
/// `[...(v ?? [])]` / `push(...)` expansion; non-iterables fail with caller text.
fn iter_items(v: Option<&Value>, msg: &str) -> Result<Vec<Value>, String> {
    match v { None | Some(Value::Null) => Ok(vec![]), Some(Value::Array(a)) => Ok(a.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(_) => Err(msg.to_string()) }
}
fn trims(a: &[Value]) -> Vec<String> {
    a.iter().filter_map(Value::as_str).map(|s| js_trim(s).to_string()).filter(|t| !t.is_empty()).collect()
}

// ----- delivery-verification-gate.ts -----

fn has_selected_artifact_role(step: Option<&Value>, tools: &Value, role: &str) -> Result<bool, String> {
    // `??` chain: non-null wins at each step; .or() args are side-effect-free here.
    let names = match prop(step, "toolNames")?.filter(|v| !v.is_null()).or(prop(step, "tools")?.filter(|v| !v.is_null())) {
        Some(v) => v.clone(),
        None => match prop(step, "toolName")? { Some(v) if js_truthy(v) => json!([v.clone()]), _ => json!([]) },
    };
    let arr = match tools {
        Value::Null => return Err("Cannot read properties of null (reading 'some')".into()),
        Value::Array(a) => a,
        _ => return Err("tools.some is not a function".into()),
    };
    for tool in arr {
        // `tool.name` evaluates before the callee-kind check of `names.includes`.
        let name = prop(Some(tool), "name")?;
        let hit = match &names {
            Value::Array(a) => name.is_some_and(|n| a.iter().any(|e| svz_eq(e, n))),
            Value::String(s) => s.contains(&js_to_string(name)),
            _ => return Err("names.includes is not a function".into()),
        };
        if !hit { continue; }
        let contract = match prop(Some(tool), "adapterConfig")? {
            None => return Err("Cannot read properties of undefined (reading 'artifactContract')".into()),
            Some(Value::Null) => return Err("Cannot read properties of null (reading 'artifactContract')".into()),
            Some(c) => c.get("artifactContract"),
        };
        if artifact_contract_ok(contract) && contract.and_then(|c| c.get("role")).and_then(Value::as_str) == Some(role) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn is_delivery_relevant_step(step: Option<&Value>, tools: &Value) -> Result<bool, String> {
    Ok(prop(step, "deliveryVerification")?.and_then(Value::as_str) == Some("required")
        || has_selected_artifact_role(step, tools, "publication")?)
}
fn is_delivery_readback_step(step: Option<&Value>, tools: &Value) -> Result<bool, String> {
    Ok(prop(step, "qaType")?.and_then(Value::as_str) == Some("delivery")
        || prop(step, "deliveryRole")?.and_then(Value::as_str) == Some("publication-verify")
        || has_selected_artifact_role(step, tools, "publication-verify")?)
}
/// `steps.filter(...)` receiver checks (`.map` is unreachable on non-arrays).
fn steps_array(steps: Option<&Value>) -> Result<Vec<Value>, String> {
    match steps { None => Err("Cannot read properties of undefined (reading 'filter')".into()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'filter')".into()),
        Some(Value::Array(a)) => Ok(a.clone()), Some(_) => Err("steps.filter is not a function".into()) }
}
fn delivery_step_ids(arr: &[Value], tools: &Value) -> Result<Vec<Value>, String> {
    let mut ids = vec![];
    for s in arr {
        if is_delivery_relevant_step(Some(s), tools)? {
            if let Some(id) = prop(Some(s), "id")? { ids.push(id.clone()); }
        }
    }
    Ok(ids)
}
fn is_downstream_of_delivery(step: &Value, arr: &[Value], ids: &[Value]) -> Result<bool, String> {
    let mut by_id = Vec::with_capacity(arr.len()); // Map: every .id is read upfront
    for c in arr { by_id.push((prop(Some(c), "id")?.cloned().unwrap_or(Value::Null), c)); }
    let mut pending = iter_items(step.get("dependencies"), "(step.dependencies ?? []) is not iterable")?;
    let mut visited: Vec<Value> = vec![];
    while let Some(dep) = pending.pop() {
        if !js_truthy(&dep) || visited.iter().any(|v| svz_eq(v, &dep)) { continue; }
        if ids.iter().any(|d| svz_eq(d, &dep)) { return Ok(true); }
        visited.push(dep.clone());
        let next = by_id.iter().rfind(|(k, _)| svz_eq(k, &dep)) // Map.get: last write wins
            .and_then(|(_, v)| v.get("dependencies"));
        pending.extend(iter_items(next, "Spread syntax requires ...iterable[Symbol.iterator] to be a function")?);
    }
    Ok(false)
}
fn has_existing_delivery_readback_step(steps: Option<&Value>, tools: &Value) -> Result<bool, String> {
    let arr = steps_array(steps)?;
    let ids = delivery_step_ids(&arr, tools)?;
    for s in &arr {
        if is_delivery_readback_step(Some(s), tools)? && is_downstream_of_delivery(s, &arr, &ids)? { return Ok(true); }
    }
    Ok(false)
}
fn append_delivery_verification_criteria(desc: Option<&Value>) -> Result<String, String> {
    let normalized = match desc {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js_trim(s).to_string(),
        Some(_) => return Err("description?.trim is not a function".into()),
    };
    if normalized.is_empty() { return Ok(build_delivery_verification_criteria()); }
    if normalized.contains("Delivery Verification:") { return Ok(normalized); }
    Ok(format!("{normalized}\n\n{}", build_delivery_verification_criteria()))
}
fn strengthen_delivery_readback_steps(steps: Option<&Value>, tools: &Value) -> Result<Value, String> {
    let arr = steps_array(steps)?;
    let ids = delivery_step_ids(&arr, tools)?;
    let mut out = Vec::with_capacity(arr.len());
    for s in &arr {
        if is_delivery_readback_step(Some(s), tools)? && is_downstream_of_delivery(s, &arr, &ids)? {
            let mut o = js_spread(s);
            let d = append_delivery_verification_criteria(prop(Some(s), "description")?)?;
            o.insert("description".into(), Value::String(d));
            out.push(Value::Object(o));
        } else { out.push(s.clone()); }
    }
    Ok(Value::Array(out))
}
fn synthesize_delivery_verification_gate_step(input: Option<&Value>) -> Result<Value, String> {
    let agent = prop(input, "agentId")?; // object literal reads agentId before dependencyStepIds
    let deps = prop(input, "dependencyStepIds")?;
    let mut o = Map::new();
    o.insert("id".into(), json!("delivery-verification-gate"));
    o.insert("name".into(), json!("[Delivery Verification] Public destination readback"));
    if let Some(a) = agent { o.insert("agentId".into(), a.clone()); }
    o.insert("qaType".into(), json!("delivery"));
    if let Some(d) = deps { o.insert("dependencies".into(), d.clone()); }
    o.insert("graphWorkProductRequired".into(), json!(false));
    o.insert("description".into(), json!(gate_description()));
    Ok(Value::Object(o))
}
fn gate_description() -> String {
    let verify = js_trim_end(&qcl::verification_gate_lines(false).join("\n")).to_string();
    ["QA type: delivery",
        "Delivery Verification Gate. Verify the deliverable actually reached the final destination declared by the workflow output contract.",
        "Do NOT pass merely because the publish/deploy step completed, a workProduct was registered, or a local file exists.",
        "", &verify, "", &build_delivery_verification_criteria(), "",
        "Submit the official verdict via the Workflow API: `PASS` or `REQUEST_CHANGES` with `findings` — one entry (`id`, `summary`, `layer`) per blocking defect. A prose final line is not a submission."]
        .join("\n")
}
fn build_delivery_verification_criteria() -> String {
    [
        "Delivery Verification: the deliverable must be reachable at the final destination declared by the workProduct, delivery manifest, workflow step output contract, or mission success criteria.",
        "- Do not PASS merely because the publish/deploy step completed, a local file exists, a storage object exists, or a catalog row/index entry exists.",
        "- First identify the final consumer path: public URL, API endpoint, database record, object key, generated file path, repository location, or another explicit destination contract.",
        "- If the final destination contract is missing or ambiguous, REQUEST_CHANGES instead of guessing a provider such as Oracle, A1, R2, AWS, Cloudflare, or local filesystem.",
        "- For public HTTP artifacts: verify the final URL returns HTTP 200 or an expected canonical redirect, contains the expected title/topic/content marker, and is not stale.",
        "- For hub/index/catalog flows: verify the index entry and then follow it to the final detail/resource path. The index row alone is supporting evidence, not completion proof.",
        "- For storage-backed delivery: verify object/file existence, key/path, freshness/hash/size, and consumer accessibility when the consumer path is different from storage.",
        "- 404, missing link, stale page, empty content, wrong artifact, missing object, or adjacent-surface-only evidence => REQUEST_CHANGES.",
    ].join("\n")
}

// ----- mission-plan-unit-contract.ts -----

/// formatContractValue: strings trim, all-string arrays join "; ", rest JSON.stringify.
fn format_contract_value(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => { let t = js_trim(s); (!t.is_empty()).then(|| t.to_string()) }
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => { let i = trims(a); (!i.is_empty()).then(|| i.join("; ")) }
        Some(other) => { let e = js_json_stringify(other); (!e.is_empty() && e != "[]" && e != "{}").then_some(e) }
    }
}
fn unit_contract_lines(unit: Option<&Value>) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    for (key, label) in [("expectedOutput", "Expected output"), ("acceptanceCriteria", "Acceptance criteria"), ("evidenceRequired", "Evidence required")] {
        if let Some(f) = format_contract_value(prop(unit, key)?) { lines.push(format!("{label}: {f}")); }
    }
    Ok(lines)
}
/// readContractSectionItems: string -> [trim], array -> filtered trims, else undefined.
fn section_items(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        Some(Value::String(s)) => { let t = js_trim(s); (!t.is_empty()).then(|| vec![t.to_string()]) }
        Some(Value::Array(a)) => { let i = trims(a); (!i.is_empty()).then_some(i) }
        _ => None,
    }
}
fn build_mission_plan_unit_step_contract(unit: Option<&Value>) -> Result<Value, String> {
    let pre = section_items(prop(unit, "preconditions")?);
    let post = match section_items(prop(unit, "postconditions")?) {
        Some(p) => p,
        None => unit_contract_lines(unit)?, // deriveUnitPlanFieldPostconditions
    };
    let und = section_items(prop(unit, "undefinedBehaviors")?);
    let mut o = Map::new();
    if let Some(p) = pre { o.insert("preconditions".into(), json!(p)); }
    if !post.is_empty() { o.insert("postconditions".into(), json!(post)); }
    if let Some(u) = und { o.insert("undefinedBehaviors".into(), json!(u)); }
    Ok(if o.is_empty() { Value::Null } else { Value::Object(o) })
}
fn qa_unit_contract_lines(units: Option<&Value>) -> Result<Value, String> {
    let arr = match units {
        None => return Err("Cannot read properties of undefined (reading 'flatMap')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'flatMap')".into()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("units.flatMap is not a function".into()),
    };
    let mut lines: Vec<String> = vec![];
    for el in arr {
        if el.is_null() { return Err("Cannot destructure property 'title' of 'object null' as it is null.".into()); }
        let contract = unit_contract_lines(el.get("unit"))?;
        if !contract.is_empty() {
            lines.push(format!("- {}", js_to_string(el.get("title"))));
            lines.extend(contract.iter().map(|l| format!("  - {l}")));
        }
    }
    let mut out = if lines.is_empty() { vec![] } else { vec!["Execution-unit outcome contracts:".to_string()] };
    out.extend(lines);
    Ok(json!(out))
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let tools = input.get("tools").cloned().unwrap_or_else(|| json!([]));
    let role = input.get("role").and_then(Value::as_str).unwrap_or_default();
    match subcommand {
        "delivery-has-artifact-role" => Ok(json!(has_selected_artifact_role(input.get("step"), &tools, role)?)),
        "delivery-is-relevant-step" => Ok(json!(is_delivery_relevant_step(input.get("step"), &tools)?)),
        "delivery-is-readback-step" => Ok(json!(is_delivery_readback_step(input.get("step"), &tools)?)),
        "delivery-has-existing-readback" => Ok(json!(has_existing_delivery_readback_step(input.get("steps"), &tools)?)),
        "delivery-append-criteria" => Ok(json!(append_delivery_verification_criteria(input.get("description"))?)),
        "delivery-strengthen-readback-steps" => strengthen_delivery_readback_steps(input.get("steps"), &tools),
        "delivery-synthesize-gate-step" => synthesize_delivery_verification_gate_step(input.get("input")),
        "delivery-build-criteria" => Ok(json!(build_delivery_verification_criteria())),
        "plan-unit-contract-lines" => Ok(json!(unit_contract_lines(input.get("unit"))?)),
        "plan-unit-step-contract" => build_mission_plan_unit_step_contract(input.get("unit")),
        "plan-qa-unit-contract-lines" => qa_unit_contract_lines(input.get("units")),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

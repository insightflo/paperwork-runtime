//! Pure port of the pure helpers structural-materialization.ts re-exports:
//! workflow/control-flow/structural-topology.ts (getStructuralTopologyErrors
//! → validateStructuralTopology) and missions/structural-plan-validation.ts
//! (validateDeclaredStructuralPlan, incl. workflow-step-role.ts isQaLikeStep
//! → workflow-qa-type.ts contract resolution). Err(_) mirrors TS throws.
//! Hand-compacted (rustfmt-skip) for the 300-line cap.
use crate::js::*;
use crate::plan_graph as g;
use crate::revision_delta as d;
use crate::structural_materialization::{is_declared, is_gate, DELEGATE};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const SUBCOMMANDS: &[&str] = &["validate-structural-topology", "validate-declared-structural-plan"];

/// workflow-qa-type.ts QA_TYPE_PATTERN ^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$.
fn qa_type_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.first().is_none_or(|c| !c.is_ascii_lowercase()) { return false; }
    let mut sep = false;
    for &c in &b[1..] {
        match c {
            b'-' | b'_' if sep => return false,
            b'-' | b'_' => sep = true,
            _ if c.is_ascii_lowercase() || c.is_ascii_digit() => sep = false,
            _ => return false,
        }
    }
    !sep
}
/// workflow-step-role.ts isQaLikeStep — resolvable qaType or qa-ish type.
fn is_qa_like(u: &Value) -> bool {
    lower(&u["qaType"]).is_some_and(|s| qa_type_ok(&s))
        || matches!(lower(&u["type"]).as_deref(), Some("qa" | "validation" | "validator"))
}
/// `s.dependencies` receiver for `.map(...)` — V8 read errors on null/undefined.
fn dep_list(s: &Value, expr: &str) -> Result<Vec<Value>, String> {
    match s.get("dependencies") {
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'map')".into()),
        None => Err("Cannot read properties of undefined (reading 'map')".into()),
        Some(_) => Err(format!("{expr}.map is not a function")),
    }
}
/// `hay.includes(needle)` — Array → SameValueZero, String → substring; a
/// missing needle models `undefined` (matches no array item, scans as text).
fn includes(hay: Option<&Value>, expr: &str, needle: Option<&Value>) -> Result<bool, String> {
    match hay {
        Some(Value::Array(a)) => Ok(needle.is_some_and(|n| a.iter().any(|e| d::js_strict_eq(e, n)))),
        Some(Value::String(s)) => Ok(s.contains(&d::js_str_opt(needle))),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'includes')".into()),
        None => Err("Cannot read properties of undefined (reading 'includes')".into()),
        Some(_) => Err(format!("{expr}.includes is not a function")),
    }
}
/// structural-topology.ts getStructuralTopologyErrors.
fn topo_errors(steps: &[Value]) -> Result<Vec<String>, String> {
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for s in steps {
        if s.is_null() { return Err("Cannot read properties of null (reading 'id')".into()); }
        if let Some(k) = s.get("id").and_then(d::js_map_key) {
            by_id.insert(k, s);
        }
    }
    let gates: Vec<&Value> = steps.iter().filter(|s| is_gate(s)).collect();
    if gates.is_empty() { return Ok(Vec::new()); }
    let producers = |gate: &Value, expr: &str| -> Result<Vec<&Value>, String> {
        let mut out = Vec::new();
        for id in dep_list(gate, expr)? {
            if let Some(&s) = d::js_map_key(&id).and_then(|k| by_id.get(&k)) {
                if js_truthy(s) && !is_gate(s) { out.push(s); }
            }
        }
        Ok(out)
    };
    let mut errors = Vec::new();
    for gate in &gates {
        let n = producers(gate, "gate.dependencies")?.len();
        if n != 1 {
            errors.push(format!("Structural gate \"{}\" must have exactly one non-gate producer dependency, got {n}.",
                d::js_str_opt(gate.get("id"))));
        }
    }
    for qa in steps {
        if is_gate(qa) || !is_qa_like(qa) { continue; }
        for dep_id in d::iter_values(qa.get("dependencies").unwrap_or(&Value::Null), "qa.dependencies")? {
            let Some(&dep) = d::js_map_key(&dep_id).and_then(|k| by_id.get(&k)) else { continue; };
            if is_gate(dep) {
                for p in producers(dep, "dependency.dependencies")? {
                    if !includes(qa.get("dependencies"), "qa.dependencies", p.get("id"))? {
                        errors.push(format!("QA step \"{}\" depends on structural gate \"{}\" but omits producer \"{}\".",
                            d::js_str_opt(qa.get("id")), d::js_str_opt(dep.get("id")), d::js_str_opt(p.get("id"))));
                    }
                }
                continue;
            }
            let mut missing = Vec::new();
            for g in &gates {
                if includes(g.get("dependencies"), "gate.dependencies", dep.get("id"))?
                    && !includes(qa.get("dependencies"), "qa.dependencies", g.get("id"))?
                {
                    missing.push(d::js_str_opt(g.get("id")));
                }
            }
            if !missing.is_empty() {
                errors.push(format!("QA step \"{}\" reviews producer \"{}\" but is missing structural gate(s): {}.",
                    d::js_str_opt(qa.get("id")), d::js_str_opt(dep.get("id")), missing.join(", ")));
            }
        }
    }
    Ok(errors)
}
/// plan-validation readUnitLabel — id → unitId → stepId → "?".
fn label(u: &Value) -> String {
    ["id", "unitId", "stepId"].iter().find_map(|k| read_string(&u[k])).unwrap_or_else(|| "?".into())
}
/// plan-validation readAliases — five identity keys + sourceRef id/issueId/stepId.
fn plan_aliases(u: &Value) -> Vec<String> {
    let mut out: Vec<String> = ["id", "unitId", "stepId", "executionUnitId", "selectedExecutionUnitId"]
        .iter().filter_map(|k| read_string(&u[k])).collect();
    if let Some(src) = u.get("sourceRef").filter(|v| v.is_object()) {
        out.extend(["id", "issueId", "stepId"].iter().filter_map(|k| read_string(&src[k])));
    }
    unique(out)
}
fn dep_forms(u: &Value) -> Vec<String> {
    unique(["dependencies", "dependsOn", "after"].iter().flat_map(|k| read_string_array(&u[k])).collect())
}
/// plan-validation rawEffectiveDependencies — own forms + draft steps that
/// target this unit (units[] or the four single-target keys).
fn raw_effective_deps(u: &Value, draft: &[Value]) -> Vec<String> {
    let aliases = plan_aliases(u);
    let mut deps = dep_forms(u);
    for step in draft {
        let targets = match read_string_array(&step["units"]) {
            t if !t.is_empty() => t,
            _ => ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"]
                .iter().filter_map(|k| read_string(&step[k])).collect(),
        };
        if targets.iter().any(|t| aliases.contains(t)) { deps.extend(dep_forms(step)); }
    }
    unique(deps)
}
/// plan-validation readUnitToolNames — all three sources via trimmed reads.
fn plan_tool_names(u: &Value) -> Vec<String> {
    let mut out: Vec<String> = ["toolNames", "tools"].iter().flat_map(|k| read_string_array(&u[k])).collect();
    out.extend(read_string(&u["toolName"]));
    unique(out)
}
/// validateDeclaredStructuralPlan — reports defects, never repairs.
fn plan_errors(units: &[Value], draft: Option<&Value>) -> Result<Vec<String>, String> {
    let mut intent = Vec::new();
    for u in units {
        if u.is_null() { return Err("Cannot read properties of null (reading 'qaType')".into()); }
        if lower(&u["qaType"]).as_deref() == Some("structural") { intent.push(u); }
    }
    if intent.is_empty() { return Ok(Vec::new()); }
    let mut errors = Vec::new();
    for u in &intent {
        if !is_declared(u) {
            errors.push(format!("Structural unit \"{}\" requires type:\"tool\".", label(u)));
            continue;
        }
        let names = plan_tool_names(u);
        if names.len() != 1 {
            errors.push(format!("Structural gate \"{}\" requires exactly one toolName, got {}.", label(u), names.len()));
        } else if names[0] == DELEGATE {
            errors.push(format!("Structural gate \"{}\" cannot use delegate_to_company.", label(u)));
        }
    }
    // TS feeds draftSteps into readPlanPolicyDiagnostics' `steps.map` first —
    // spread position unifies every non-array into one TypeError text.
    let draft = match draft {
        None => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'map')".into()),
        Some(_) => return Err("steps.map is not a function or its return value is not iterable".into()),
    };
    let normalized = g::normalize_mission_plan_dependency_graph(units, &draft)?;
    if normalized["ok"] != json!(true) {
        let mut out: Vec<String> = normalized["diagnostics"].as_array()
            .map(|a| a.iter().filter_map(|e| e["message"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        for gate in intent.iter().filter(|u| is_declared(u)) {
            let refs = raw_effective_deps(gate, &draft);
            let mut n = 0;
            for r in &refs {
                for c in units {
                    if g::is_mission_plan_unit_materialized(c)? && !is_declared(c) && plan_aliases(c).contains(r) {
                        n += 1;
                        break;
                    }
                }
            }
            if n != 1 {
                out.push(format!("Structural gate \"{}\" must depend on exactly one non-gate producer, got {n}.", label(gate)));
            }
        }
        errors.extend(out);
        return Ok(errors);
    }
    let exec = normalized["graph"]["materializedUnits"].as_array().cloned().unwrap_or_default();
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for u in &exec {
        if let Some(id) = read_string(&u["id"]) {
            by_id.insert(id, u);
        }
    }
    let structural: Vec<&Value> = exec.iter().filter(|u| is_declared(u)).collect();
    let deps = |u: &Value| read_string_array(&u["dependencies"]);
    for gate in &structural {
        let n = deps(gate).iter().filter(|id| by_id.get(id.as_str()).is_some_and(|o| !is_declared(o))).count();
        if n != 1 {
            errors.push(format!("Structural gate \"{}\" must depend on exactly one non-gate producer, got {n}.", label(gate)));
        }
    }
    for qa in &exec {
        if is_declared(qa) || !is_qa_like(qa) { continue; }
        let qa_deps = unique(deps(qa));
        for pid in &qa_deps {
            let Some(p) = by_id.get(pid.as_str()) else { continue; };
            if is_declared(p) { continue; }
            let missing: Vec<String> = structural.iter()
                .filter(|g| deps(g).contains(pid) && read_string(&g["id"]).is_none_or(|id| !qa_deps.contains(&id)))
                .map(|g| label(g))
                .collect();
            if !missing.is_empty() {
                errors.push(format!("QA unit \"{}\" reviews producer \"{pid}\" but does not depend on structural gate(s): {}.",
                    label(qa), missing.join(", ")));
            }
        }
        for gid in &qa_deps {
            let Some(gate) = by_id.get(gid.as_str()) else { continue; };
            if !is_declared(gate) { continue; }
            let missing: Vec<String> = deps(gate).iter()
                .filter(|pid| by_id.get(pid.as_str()).is_some_and(|p| !is_declared(p)) && !qa_deps.contains(*pid))
                .map(|pid| by_id.get(pid.as_str()).map(|p| label(p)).unwrap_or_else(|| "?".into()))
                .collect();
            if !missing.is_empty() {
                errors.push(format!("QA unit \"{}\" depends on structural gate \"{gid}\" but omits its producer: {}.",
                    label(qa), missing.join(", ")));
            }
        }
    }
    Ok(errors)
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "validate-structural-topology" => {
            let errors = topo_errors(d::array_method(input.get("steps"), "steps", "map")?)?;
            if errors.is_empty() { Ok(Value::Null) } else { Err(errors.join(" ")) }
        }
        "validate-declared-structural-plan" => Ok(json!(plan_errors(
            d::array_method(input.get("units"), "units", "filter")?,
            input.get("draftSteps"),
        )?)),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

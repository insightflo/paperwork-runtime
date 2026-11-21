//! Pure port of server/src/services/missions/revision-plan-declaration-targets.ts:
//! the explicit-target judgment contract for structured decision.steps
//! dependency declarations (a non-empty units array is the entire target set;
//! malformed units shapes are not declarations; canonical unit id beats aliases
//! and only sole-owner aliases resolve). Same contract as the plan_graph
//! normalizer by design — kept a separate port, not a shared refactor.
use crate::js::*;
use crate::revision_delta as d;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const SUBCOMMANDS: &[&str] = &[
    "read-unit-id",
    "has-dependency-declaration",
    "read-step-declared-dependency-unit-ids",
];
const UNIT_ALIAS_KEYS: [&str; 5] = [
    "id",
    "unitId",
    "stepId",
    "executionUnitId",
    "selectedExecutionUnitId",
];
const SOURCE_ALIAS_KEYS: [&str; 6] = [
    "id",
    "issueId",
    "stepId",
    "unitId",
    "executionUnitId",
    "selectedExecutionUnitId",
];
const DEP_KEYS: [&str; 3] = ["dependencies", "dependsOn", "after"];
const TARGET_KEYS: [&str; 4] = ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"];

/// `readUnitId` — null/undefined raise the V8 property-read TypeError texts.
fn read_unit_id(unit: Option<&Value>) -> Result<Option<String>, String> {
    match unit {
        None => Err("Cannot read properties of undefined (reading 'id')".into()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'id')".into()),
        Some(v) => Ok(v.get("id").and_then(read_string)),
    }
}
/// `hasDependencyDeclaration` — own-property probe; null/undefined raise the
/// V8 ToObject TypeError text (same message for both).
fn has_dependency_declaration(unit: Option<&Value>) -> Result<bool, String> {
    match unit {
        None | Some(Value::Null) => Err("Cannot convert undefined or null to object".into()),
        Some(v) => Ok(DEP_KEYS.iter().any(|k| has_own(v, k))),
    }
}
/// `readUnitAliases` — unit alias surface plus object sourceRef aliases, deduped.
fn read_unit_aliases(unit: &Value) -> Vec<String> {
    let mut a: Vec<String> = UNIT_ALIAS_KEYS
        .iter()
        .filter_map(|k| unit.get(k).and_then(read_string))
        .collect();
    if let Some(src) = unit.get("sourceRef").filter(|v| v.is_object()) {
        a.extend(
            SOURCE_ALIAS_KEYS
                .iter()
                .filter_map(|k| src.get(k).and_then(read_string)),
        );
    }
    unique(a)
}
/// `readStepDeclarationTargets` — a non-empty units array is the whole target
/// set; malformed units → no declaration; empty array falls through to keys.
fn read_step_declaration_targets(step: &Value) -> Vec<String> {
    if has_own(step, "units") {
        if !valid_string_array(&step["units"]) {
            return Vec::new();
        }
        let units = read_string_array(&step["units"]);
        if !units.is_empty() {
            return unique(units);
        }
    }
    unique(
        TARGET_KEYS
            .iter()
            .filter_map(|k| read_string(&step[*k]))
            .collect(),
    )
}
/// `readStepDeclaredDependencyUnitIds` — explicit canonical id set, first-hit
/// order. Canonical ids resolve before aliases; ambiguous/unresolved → dropped.
fn read_step_declared_dependency_unit_ids(
    decision: Option<&Value>,
    declared_units: &Value,
) -> Result<Vec<String>, String> {
    let mut canon = HashSet::new();
    let mut owners: HashMap<String, HashSet<String>> = HashMap::new();
    for unit in d::iter_values(declared_units, "declaredUnits")? {
        let Some(id) = read_unit_id(Some(&unit))? else {
            continue;
        };
        canon.insert(id.clone());
        for alias in read_unit_aliases(&unit) {
            owners.entry(alias).or_default().insert(id.clone());
        }
    }
    let steps = match decision {
        None => return Err("Cannot read properties of undefined (reading 'steps')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'steps')".into()),
        Some(v) => v.get("steps"),
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let Some(steps) = steps.and_then(Value::as_array) else {
        return Ok(out);
    };
    for raw in steps {
        if !raw.is_object() || !has_dependency_declaration(Some(raw))? {
            continue;
        }
        for t in read_step_declaration_targets(raw) {
            let id = if canon.contains(&t) {
                Some(t)
            } else {
                owners
                    .get(&t)
                    .filter(|o| o.len() == 1)
                    .and_then(|o| o.iter().next().cloned())
            };
            if let Some(id) = id.filter(|i| seen.insert(i.clone())) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "read-unit-id" => Ok(json!(read_unit_id(input.get("unit"))?)),
        "has-dependency-declaration" => Ok(json!(has_dependency_declaration(input.get("unit"))?)),
        "read-step-declared-dependency-unit-ids" => Ok(json!(
            read_step_declared_dependency_unit_ids(input.get("decision"), &input["declaredUnits"])?
        )),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

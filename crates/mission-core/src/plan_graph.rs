//! Pure port of server/src/services/missions/mission-plan-dependency-graph.ts.
//! Raw serde_json::Value + JS-permissive reads keep behavioral parity; JS-runtime
//! shims (trim/own-property/spread/truthy) live in crate::js.
use crate::js::*;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

pub const FILTERED_UNIT_DEPENDENCY_POLICY: &str = "reject-materialized-to-filtered-allow-reverse";
const UNIT_ALIASES: [&str; 5] = ["id", "unitId", "stepId", "executionUnitId", "selectedExecutionUnitId"];
const SOURCE_ALIASES: [&str; 6] =
    ["id", "issueId", "stepId", "unitId", "executionUnitId", "selectedExecutionUnitId"];
const DEP_KEYS: [&str; 3] = ["dependencies", "dependsOn", "after"];
const TARGET_KEYS: [&str; 4] = ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"];

type Diag = (String, String);
fn fail(ds: Vec<Diag>) -> Value {
    let diagnostics: Vec<Value> = ds.iter().map(|d| json!({"code": d.0, "message": d.1})).collect();
    json!({"ok": false, "diagnostics": diagnostics})
}
fn cross_company_kind(s: &str) -> bool {
    matches!(s, "cross_company_mission" | "cross_company_mission_request" | "company_mission" | "external_company_mission")
}
fn read_aliases(unit: &Value) -> Vec<String> {
    let keys = |v: &Value, ks: &[&str]| {
        ks.iter().filter_map(|k| v.get(k).and_then(read_string)).collect::<Vec<_>>()
    };
    let mut a = keys(unit, &UNIT_ALIASES);
    if let Some(src) = unit.get("sourceRef").filter(|v| v.is_object()) {
        a.extend(keys(src, &SOURCE_ALIASES));
    }
    unique(a)
}
fn read_dependencies(v: &Value, label: &str, ds: &mut Vec<Diag>) -> Vec<String> {
    let mut deps = Vec::new();
    for key in DEP_KEYS {
        if !has_own(v, key) {
            continue;
        }
        if valid_string_array(&v[key]) {
            deps.extend(read_string_array(&v[key]));
        } else {
            ds.push(("invalid_dependency_shape".into(), format!("{label}.{key} must be an array of non-empty strings.")));
        }
    }
    unique(deps)
}
fn read_draft_targets(step: &Value, index: usize, ds: &mut Vec<Diag>) -> Vec<String> {
    let label = format!("draft.steps[{index}]");
    if has_own(step, "units") {
        if !valid_string_array(&step["units"]) {
            ds.push(("invalid_dependency_shape".into(), format!("{label}.units must be an array of non-empty strings.")));
            return Vec::new();
        }
        let units = read_string_array(&step["units"]);
        if !units.is_empty() {
            return unique(units);
        }
    }
    let mut targets = Vec::new();
    for key in TARGET_KEYS {
        if !has_own(step, key) {
            continue;
        }
        match read_string(&step[key]) {
            Some(t) => targets.push(t),
            None => ds.push(("invalid_dependency_shape".into(), format!("{label}.{key} must be a non-empty string."))),
        }
    }
    unique(targets)
}
fn is_structural(u: &Value) -> bool {
    lower(&u["type"]).as_deref() == Some("tool") && lower(&u["qaType"]).as_deref() == Some("structural")
}
fn is_cross_company(u: &Value) -> bool {
    let cc = |s: Option<String>| cross_company_kind(&s.unwrap_or_default());
    cc(u.get("sourceRef").filter(|v| v.is_object()).and_then(|s| s.get("type")).and_then(lower)) || cc(lower(&u["kind"]))
}
fn is_oversight(u: &Value) -> bool {
    if is_structural(u) {
        return false;
    }
    let (ty, esc) = (lower(&u["type"]), u.get("triggerOn").and_then(Value::as_str) == Some("escalation"));
    if ty.as_deref() == Some("oversight") {
        return esc;
    }
    ty.is_none() && lower(&u["kind"]).as_deref() == Some("oversight")
}
pub fn is_mission_plan_unit_materialized(u: &Value) -> Result<bool, String> {
    if u.is_null() {
        return Err("Cannot read properties of null (reading 'sourceRef')".into());
    }
    Ok(!is_cross_company(u) && !is_oversight(u))
}
fn canonical_index(units: &[Value]) -> Vec<Vec<usize>> {
    let by_id: HashMap<String, usize> = units
        .iter()
        .enumerate()
        .filter_map(|(i, u)| read_string(&u["id"]).map(|id| (id, i)))
        .collect();
    units.iter().map(|u| read_string_array(&u["dependencies"]).iter().filter_map(|d| by_id.get(d).copied()).collect()).collect()
}
pub fn remap_canonical_dependencies_to_step_ids(units: &[Value], step_ids: &[Value]) -> Result<Vec<Vec<Value>>, String> {
    if units.len() != step_ids.len() {
        return Err("Canonical units and workflow steps must have equal length.".into());
    }
    let mut map = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        if u.is_null() {
            return Err("Cannot read properties of null (reading 'id')".into());
        }
        if let Some(id) = read_string(&u["id"]) {
            map.insert(id, step_ids[i].clone());
        }
    }
    let step_of = |d: &String| match map.get(d) {
        Some(v) if js_truthy(v) => Ok(v.clone()),
        _ => Err(format!("Canonical dependency {d} has no materialized workflow step.")),
    };
    units.iter().map(|u| read_string_array(&u["dependencies"]).iter().map(&step_of).collect()).collect()
}
// readPlanPolicyDiagnostics — a null entry hits `hasOwnProperty.call(null,..)` TypeError.
fn check_policy(v: &Value, path: &str, ds: &mut Vec<Diag>) -> Result<(), String> {
    if v.is_null() {
        return Err("Cannot convert undefined or null to object".into());
    }
    for f in ["deliveryVerification", "capAcceptance"] {
        if has_own(v, f) {
            ds.push(("board_only_plan_policy".into(), format!("{path}.{f} is board-only and cannot be set by a mission plan. Remove it from the plan and configure it through the board workflow API.")));
        }
    }
    Ok(())
}
struct RefMap {
    canon: HashMap<String, usize>,
    owners: HashMap<String, BTreeSet<usize>>,
}
impl RefMap {
    fn resolve(&self, ref_: &str, target: bool, ds: &mut Vec<Diag>) -> Option<usize> {
        if let Some(&i) = self.canon.get(ref_) {
            return Some(i);
        }
        let o = self.owners.get(ref_).filter(|s| !s.is_empty());
        if let Some(s) = o.filter(|s| s.len() == 1) {
            return Some(*s.iter().next().unwrap());
        }
        let kind = if o.is_some() { "ambiguous" } else { "unresolved" };
        let code = format!("{kind}_dependency{}_ref", if target { "_target" } else { "" });
        let scope = if target { "Draft dependency declaration has" } else { "Plan has" };
        let w = if target { "target" } else { "dependency" };
        ds.push((code, format!("{scope} {kind} {w} ref: {ref_}.")));
        None
    }
}
pub fn normalize_mission_plan_dependency_graph(units: &[Value], draft_steps: &[Value]) -> Result<Value, String> {
    let mut ds = Vec::new();
    for (i, v) in units.iter().enumerate() {
        check_policy(v, &format!("selectedExecutionUnits[{i}]"), &mut ds)?;
    }
    for (i, v) in draft_steps.iter().enumerate() {
        check_policy(v, &format!("steps[{i}]"), &mut ds)?;
    }
    let mut id_opts = Vec::with_capacity(units.len());
    for (i, u) in units.iter().enumerate() {
        id_opts.push(read_string(&u["id"]));
        if id_opts[i].is_none() {
            ds.push(("missing_unit_id".into(), format!("selectedExecutionUnits[{i}] is missing mandatory unit.id.")));
        }
    }
    let mut order = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for id in id_opts.iter().flatten() {
        if counts.insert(id.clone(), counts.get(id).map_or(1, |c| c + 1)).is_none() {
            order.push(id.clone());
        }
    }
    for id in order.iter().filter(|id| counts[*id] > 1) {
        ds.push(("duplicate_unit_id".into(), format!("Duplicate plan unit id \"{id}\" is declared by {} units.", counts[id])));
    }
    if !ds.is_empty() {
        return Ok(fail(ds));
    }
    let ids: Vec<String> = id_opts.into_iter().map(Option::unwrap).collect();
    let mut owners: HashMap<String, BTreeSet<usize>> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        for a in read_aliases(u) {
            owners.entry(a).or_default().insert(i);
        }
    }
    let refs = RefMap { canon: ids.iter().enumerate().map(|(i, s)| (s.clone(), i)).collect(), owners };
    let mut dep_targets: Vec<Vec<usize>> = Vec::with_capacity(units.len());
    for (i, u) in units.iter().enumerate() {
        dep_targets.push(read_dependencies(u, &format!("selectedExecutionUnits[{i}]"), &mut ds).into_iter().filter_map(|r| refs.resolve(&r, false, &mut ds)).collect());
    }
    let mut norm_steps = Vec::with_capacity(draft_steps.len());
    for (di, raw) in draft_steps.iter().enumerate() {
        if !raw.is_object() || !DEP_KEYS.iter().any(|k| has_own(raw, k)) {
            norm_steps.push(if raw.is_string() { raw.clone() } else { Value::Object(js_spread(raw)) });
            continue;
        }
        let targets = read_draft_targets(raw, di, &mut ds);
        if targets.is_empty() {
            ds.push(("unresolved_dependency_target_ref".into(), "Draft dependency declaration has no unit target ref.".into()));
        }
        let rdeps: Vec<usize> = read_dependencies(raw, &format!("draft.steps[{di}]"), &mut ds).into_iter().filter_map(|r| refs.resolve(&r, false, &mut ds)).collect();
        let mut rtargets: Vec<(String, Option<usize>)> = Vec::with_capacity(targets.len());
        for r in targets {
            let i = refs.resolve(&r, true, &mut ds);
            if let Some(t) = i {
                dep_targets[t] = unique([dep_targets[t].clone(), rdeps.clone()].concat());
            }
            rtargets.push((r, i));
        }
        let mut m = js_spread(raw);
        m.insert("dependencies".into(), json!(unique(rdeps.iter().map(|&i| ids[i].clone()).collect::<Vec<_>>())));
        if !read_string_array(&raw["units"]).is_empty() {
            m.insert("units".into(), json!(unique(rtargets.iter().filter_map(|(_, i)| i.map(|j| ids[j].clone())).collect::<Vec<_>>())));
        } else {
            for key in TARGET_KEYS {
                if let Some(i) = read_string(&raw[key]).and_then(|r| rtargets.iter().find(|(er, _)| *er == r).and_then(|(_, i)| *i)) {
                    m.insert(key.into(), json!(ids[i]));
                }
            }
        }
        m.shift_remove("dependsOn");
        m.shift_remove("after");
        norm_steps.push(Value::Object(m));
    }
    let mut canonical_targets: Vec<Vec<usize>> = Vec::with_capacity(units.len());
    for (i, ts) in dep_targets.iter().enumerate() {
        canonical_targets.push(unique(ts.iter().copied().filter(|&t| {
            if t == i {
                ds.push(("self_dependency".into(), format!("Unit \"{}\" cannot depend on itself.", ids[i])));
            }
            t != i
        }).collect()));
    }
    let canonical_deps: Vec<Vec<String>> = canonical_targets.iter().map(|ts| ts.iter().map(|&t| ids[t].clone()).collect()).collect();
    let mat: Vec<bool> = units.iter().map(|u| !is_cross_company(u) && !is_oversight(u)).collect();
    for (f, ts) in canonical_targets.iter().enumerate().filter(|(f, _)| mat[*f]) {
        for &t in ts {
            if !mat[t] {
                ds.push(("materialized_dependency_on_filtered_unit".into(), format!("Materialized unit \"{}\" cannot depend on filtered metadata/delegation unit \"{}\" ({FILTERED_UNIT_DEPENDENCY_POLICY}).", ids[f], ids[t])));
            }
        }
    }
    // Iterative DFS cycle detection: `chain` mirrors the TS `path` (state-1 ancestors).
    let mut state = vec![0u8; units.len()];
    for root in 0..units.len() {
        if state[root] != 0 {
            continue;
        }
        state[root] = 1;
        let (mut chain, mut iters) = (vec![root], vec![0usize]);
        while let Some(&node) = chain.last() {
            let next = iters.last_mut().unwrap();
            if *next == canonical_targets[node].len() {
                state[node] = 2;
                chain.pop();
                iters.pop();
                continue;
            }
            let t = canonical_targets[node][*next];
            *next += 1;
            match state[t] {
                0 => {
                    state[t] = 1;
                    chain.push(t);
                    iters.push(0);
                }
                1 => {
                    let start = chain.iter().position(|&x| x == t).unwrap();
                    let cyc = chain[start..].iter().chain(std::iter::once(&t)).map(|&e| ids[e].as_str()).collect::<Vec<_>>().join(" -> ");
                    ds.push(("dependency_cycle".into(), format!("Plan dependency cycle detected: {cyc}.")));
                }
                _ => {}
            }
        }
    }
    if !ds.is_empty() {
        return Ok(fail(ds));
    }
    let mut norm_units = Vec::with_capacity(units.len());
    for (i, u) in units.iter().enumerate() {
        let mut m = js_spread(u);
        m.insert("id".into(), json!(ids[i]));
        m.insert("dependencies".into(), json!(canonical_deps[i]));
        m.shift_remove("dependsOn");
        m.shift_remove("after");
        norm_units.push(Value::Object(m));
    }
    let mat_units: Vec<Value> = norm_units.iter().filter(|u| !is_cross_company(u) && !is_oversight(u)).cloned().collect();
    Ok(json!({"ok": true, "graph": {
        "units": norm_units,
        "draftSteps": norm_steps,
        "dependencyIndex": canonical_index(&norm_units),
        "materializedUnits": mat_units,
        "materializedDependencyIndex": canonical_index(&mat_units),
    }}))
}

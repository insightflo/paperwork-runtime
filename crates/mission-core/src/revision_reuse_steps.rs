//! Step-graph half of revision-reuse-plan.ts: reuse closure resolution,
//! server-owned step projection and reserved QA step-id assignment.
//! Split from revision_reuse.rs to honor the 300-line file limit.
use crate::js::*;
use crate::revision_delta as d;
use crate::revision_reuse::{dep_invalid, diag, fail, reuse_invalid};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// edge-condition.ts resolveEdges(step): legacy dependencies[] →
/// {stepId,when:"success"} ∪ conditionalDependencies entries whose stepId is
/// a non-empty string (whole edge kept). `None` models `undefined` step.
fn resolve_edges(step: Option<&Value>) -> Result<Vec<Value>, String> {
    let step = match step {
        None => return Err("Cannot read properties of undefined (reading 'dependencies')".into()),
        Some(Value::Null) => {
            return Err("Cannot read properties of null (reading 'dependencies')".into())
        }
        Some(s) => s,
    };
    let mut edges = Vec::new();
    if let Some(a) = step.get("dependencies").and_then(Value::as_array) {
        edges.extend(
            a.iter()
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .map(|v| json!({"stepId": v, "when": "success"})),
        );
    }
    if let Some(a) = step
        .get("conditionalDependencies")
        .and_then(Value::as_array)
    {
        edges.extend(
            a.iter()
                .filter(|e| {
                    e.get("stepId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                })
                .cloned(),
        );
    }
    Ok(edges)
}
/// `edge.isBackEdge` truthiness (legacy edges have none → false).
fn is_back_edge(e: &Value) -> bool {
    e.get("isBackEdge").map(js_truthy).unwrap_or(false)
}

/// workflow-qa-type.ts QA_TYPE_PATTERN ^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$.
fn qa_type_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_lowercase) {
        return false;
    }
    let mut after_sep = false;
    for &c in &b[1..] {
        if c == b'-' || c == b'_' {
            if after_sep {
                return false;
            }
            after_sep = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            after_sep = false;
        } else {
            return false;
        }
    }
    !after_sep
}
/// workflow-step-role.ts classifyWorkflowStepRole (qaType contract → qa).
fn classify_step_role(u: &Value) -> &'static str {
    if u["qaType"]
        .as_str()
        .is_some_and(|s| qa_type_ok(&js_trim(s).to_lowercase()))
    {
        return "qa";
    }
    match js_trim(u["type"].as_str().unwrap_or(""))
        .to_lowercase()
        .as_str()
    {
        "qa" | "validation" | "validator" => "qa",
        "approval" | "oversight" => "oversight",
        "action" | "producer" | "research" => "action",
        _ => "unknown",
    }
}

fn visit(
    id: &Value,
    by_id: &HashMap<String, (usize, &Value)>,
    state: &mut HashMap<String, u8>,
    closure: &mut Vec<Value>,
) -> Result<Option<Value>, String> {
    let key = d::js_map_key(id).unwrap_or_default();
    match state.get(&key) {
        Some(2) => return Ok(None),
        Some(1) => return Ok(Some(id.clone())),
        _ => {}
    }
    let Some(&(_, step)) = by_id.get(&key) else {
        return Ok(None);
    };
    state.insert(key.clone(), 1);
    for dep in resolve_edges(Some(step))? {
        if is_back_edge(&dep) {
            continue;
        }
        if let Some(c) = visit(&dep["stepId"], by_id, state, closure)? {
            return Ok(Some(c));
        }
    }
    state.insert(key, 2);
    closure.push(id.clone());
    Ok(None)
}
/// resolveReuseClosure — DFS over non-back-edge deps, snapshot-order output.
pub fn resolve_reuse_closure(
    steps: Option<&Value>,
    roots: Option<&Value>,
) -> Result<Value, String> {
    let steps = d::array_method(steps, "sourceSteps", "map")?;
    let mut by_id: HashMap<String, (usize, &Value)> = HashMap::new();
    for (i, s) in steps.iter().enumerate() {
        if s.is_null() {
            return Err("Cannot read properties of null (reading 'id')".into());
        }
        if let Some(k) = s.get("id").and_then(d::js_map_key) {
            by_id.insert(k, (i, s));
        }
    }
    let mut state: HashMap<String, u8> = HashMap::new();
    let mut closure: Vec<Value> = Vec::new();
    for root in d::iter_values(roots.unwrap_or(&Value::Null), "roots")? {
        let found = d::js_map_key(&root).is_some_and(|k| by_id.contains_key(&k));
        if !found {
            return Ok(fail(reuse_invalid(format!(
                "재사용 루트 {} 이(가) 원본 실행 스냅샷에 없습니다.",
                d::js_str(&root)
            ))));
        }
        if let Some(c) = visit(&root, &by_id, &mut state, &mut closure)? {
            return Ok(fail(dep_invalid(format!(
                "재사용 클로저에 정방향 순환이 있습니다({}).",
                d::js_str(&c)
            ))));
        }
    }
    closure.sort_by_key(|v| {
        d::js_map_key(v)
            .and_then(|k| by_id.get(&k).map(|(i, _)| *i))
            .unwrap_or(0)
    });
    Ok(json!({"ok": true, "closure": closure}))
}

/// projectReuseStepToUnit — server-owned plan projection of a source step.
pub fn project_reuse_step_to_unit(step: Option<&Value>) -> Result<Value, String> {
    let deps = resolve_edges(step)?
        .into_iter()
        .filter(|e| !is_back_edge(e))
        .map(|e| e["stepId"].clone())
        .collect::<Vec<_>>();
    let s = step.unwrap_or(&Value::Null);
    let mut u = Map::new();
    if let Some(v) = s.get("id") {
        u.insert("id".into(), v.clone());
        u.insert("sourceStepId".into(), v.clone());
    }
    if let Some(v) = s.get("name") {
        u.insert("title".into(), v.clone());
    }
    u.insert("selectionState".into(), json!("selected"));
    u.insert(
        "reason".into(),
        json!(format!(
            "Verbatim reuse copied by server from source run step {}",
            d::js_str_opt(s.get("id"))
        )),
    );
    let mut sr = Map::new();
    sr.insert("type".into(), json!("mission_plan_unit"));
    if let Some(v) = s.get("id") {
        sr.insert("id".into(), v.clone());
    }
    u.insert("sourceRef".into(), Value::Object(sr));
    u.insert("dependencies".into(), Value::Array(deps));
    if s.get("agentId")
        .and_then(Value::as_str)
        .is_some_and(|a| !js_trim(a).is_empty())
    {
        u.insert("assigneeAgentId".into(), s["agentId"].clone());
    }
    if s.get("type").is_some_and(Value::is_string) {
        u.insert("type".into(), s["type"].clone());
    }
    if s.get("toolNames")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        u.insert("toolNames".into(), s["toolNames"].clone());
    }
    for k in [
        "toolArgs",
        "workProductSelectors",
        "knowledgeBaseIds",
        "contract",
    ] {
        if let Some(v) = s.get(k) {
            u.insert(k.into(), v.clone());
        }
    }
    Ok(Value::Object(u))
}

/// assignReservedQaStepIds — B units structurally claim past QA ids; the
/// single unclaimed id goes to the mission-final QA.
pub fn assign_reserved_qa_step_ids(input: &Value) -> Result<Value, String> {
    let mut reserved: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for v in d::new_set_items(input.get("reservedQaStepIds"))? {
        let keep = match d::js_map_key(&v) {
            Some(k) => seen.insert(k),
            None => true,
        };
        if keep {
            reserved.push(v);
        }
    }
    let rset: HashSet<String> = reserved.iter().filter_map(d::js_map_key).collect();
    let mut qa_map: Vec<(String, Value)> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();
    for unit in d::iter_values(
        input.get("authoredUnits").unwrap_or(&Value::Null),
        "input.authoredUnits",
    )? {
        if unit.is_null() {
            return Err("Cannot read properties of null (reading 'id')".into());
        }
        let (Some(uid), Some(sid)) = (
            unit.get("id").and_then(Value::as_str),
            unit.get("sourceStepId").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !rset.contains(&format!("s:{sid}")) {
            continue;
        }
        if claimed.contains(sid) {
            return Ok(fail(diag(
                "mission_revision_reuse_id_collision",
                format!(
                    "과거 QA 단계 {sid} 를 여러 B 단위가 동시에 이어받으려 합니다({}).",
                    qa_map
                        .iter()
                        .map(|(_, v)| d::js_str(v))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            )));
        }
        if classify_step_role(&unit) != "qa" {
            return Ok(fail(dep_invalid(format!(
                "과거 QA 단계 {sid} 를 이어받는 단위 {uid} 는 QA 단위여야 합니다(QA 가 아닌 단위는 과거 QA ID 를 쓸 수 없습니다)."
            ))));
        }
        qa_map.push((uid.to_string(), unit["sourceStepId"].clone()));
        claimed.insert(sid.to_string());
    }
    let consumed: HashSet<&str> = qa_map.iter().filter_map(|(_, v)| v.as_str()).collect();
    let remaining: Vec<Value> = reserved
        .iter()
        .filter(|v| v.as_str().is_none_or(|s| !consumed.contains(s)))
        .cloned()
        .collect();
    if remaining.len() > 1 {
        return Ok(fail(dep_invalid(format!(
            "A 의 back-edge 가 참조하는 과거 QA ID 가 여러 개({}) 남았습니다 — 이어받을 QA 단위를 sourceStepId 로 명시하거나 참조를 정리하세요.",
            remaining.iter().map(d::js_str).collect::<Vec<_>>().join(", ")
        ))));
    }
    let map: Map<String, Value> = qa_map.into_iter().collect();
    Ok(json!({"ok": true, "qaStepIdByUnitId": map,
        "finalQaStepId": remaining.first().cloned().unwrap_or(Value::Null)}))
}

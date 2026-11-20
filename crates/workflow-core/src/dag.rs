//! [파일 목적] workflow DAG 정적 검증의 Rust 포트(Stage 2) — dag-validation.ts + cycle-validator.ts.
//!   IF/Complete control-node 규칙은 control_nodes.rs. main.rs CLI(validate-dag/has-disallowed-cycle)가 소비.
//! [parity] 오류/경고 문자열·순서를 TS validateDag 에 정렬(중복 ID → orphan → control-node → cycle →
//!   entry point → unreachable). step id 멤버십은 raw JSON 값 비교로 JS Set/Map strict-equality 를
//!   모사한다(비문자열 dep/stepId 5 → "5"; absent id ≈ undefined; JSON 한계로 객체 id 는 참조가 아닌
//!   deep-equality 근사). 제외(문서화): zod 고유 검사(조건 strict 키/source 문법/rightValue 내용),
//!   condition-source ancestor 규칙, parallel-branch guard — parity 테스트는 양측 동의 입력만 사용.

mod control_nodes;

use crate::control_flow::{js_truthy, string_elements};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// JS template stringification(`${v}`): 5 → "5", null → "null", absent → "undefined",
///   [1,2] → "1,2" (null 요소는 빈 문자열), {} → "[object Object]".
fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| {
                if e.is_null() {
                    String::new()
                } else {
                    js_str(Some(e))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// conditionalDependencies 의 null 아닌 요소 전체(TS for...of 와 동일) / JS-truthy 요소만.
fn conditional_elems(cd: Option<&Value>) -> Vec<&Value> {
    cd.and_then(Value::as_array)
        .map(|a| a.iter().filter(|v| !v.is_null()).collect())
        .unwrap_or_default()
}
fn truthy_elems(cd: Option<&Value>) -> Vec<&Value> {
    conditional_elems(cd)
        .into_iter()
        .filter(|v| js_truthy(Some(v)))
        .collect()
}

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// annotated 허용 back-edge: isBackEdge===true && maxIterations(number)>=1.
fn is_allowed_back_edge(e: &Value) -> bool {
    matches!(e.get("isBackEdge"), Some(Value::Bool(true)))
        && e.get("maxIterations")
            .and_then(Value::as_f64)
            .is_some_and(|m| m >= 1.0)
}

/// TS `stepIds.has(dep)` — raw id 값 비교(문자열 "5" 와 숫자 5 는 다르다).
fn known_id(steps: &[Value], id: Option<&Value>) -> bool {
    steps.iter().any(|s| s.get("id") == id)
}
/// TS `allSteps.find(s => s.id === depId)` — 첫 일치.
fn step_by_id_first<'a>(steps: &'a [Value], id: Option<&Value>) -> Option<&'a Value> {
    steps.iter().find(|s| s.get("id") == id)
}

/// resolveEdges 와 동일한 forward 선행: legacy 문자열 dep(비지 않음) + 조건부 문자열 stepId
///   (비지 않음, 허용 back-edge 제외). orphan(from 미확인)은 여기선 skip 하고 validate_dag 에 위임.
fn forward_sources(step: &Value) -> Vec<String> {
    let mut out: Vec<String> = string_elements(step.get("dependencies"))
        .into_iter()
        .filter(|dep| !dep.is_empty())
        .collect();
    for e in truthy_elems(step.get("conditionalDependencies")) {
        if let Some(id) = get_str(e, "stepId").filter(|id| !id.is_empty()) {
            if !is_allowed_back_edge(e) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// step 의 문자열 id(id 없음/비문자열 → ""). TS 도 비문자열 id 를 edge 에 못 쓰므로 문자열 키면 충분.
fn step_id(s: &Value) -> &str {
    s.get("id").and_then(Value::as_str).unwrap_or_default()
}

/// 유효 bounded back-edge 를 제외한 forward graph 의 WHITE/GRAY/BLACK DFS.
///   edge 는 문자열 stepId 만 지니므로(TS resolveEdges 와 동일) 문자열 id 키로 충분하다.
pub fn has_disallowed_cycle(steps: &[Value]) -> bool {
    let ids: HashSet<&str> = steps.iter().map(step_id).collect();
    let mut forward: HashMap<String, Vec<&str>> = HashMap::new();
    for target in steps {
        for from in forward_sources(target) {
            if ids.contains(from.as_str()) {
                forward.entry(from).or_default().push(step_id(target));
            }
        }
    }
    let mut color: HashMap<&str, u8> = ids.iter().map(|id| (*id, 0u8)).collect();
    steps.iter().any(|s| {
        color.get(step_id(s)).copied() == Some(0) && dfs_cycle(step_id(s), &forward, &mut color)
    })
}

fn dfs_cycle<'a>(
    node: &'a str,
    forward: &HashMap<String, Vec<&'a str>>,
    color: &mut HashMap<&'a str, u8>,
) -> bool {
    color.insert(node, 1);
    let hit = forward.get(node).is_some_and(|nexts| {
        nexts
            .iter()
            .any(|&to| match color.get(to).copied().unwrap_or(0) {
                1 => true,
                0 => dfs_cycle(to, forward, color),
                _ => false, // BLACK 완료 → skip
            })
    });
    color.insert(node, 2);
    hit
}

/// TS dfsReachable — raw dependencies 를 거슬러 탐색(비문자열 dep 도 raw id 와 비교).
fn dfs_reachable<'a>(id: Option<&'a Value>, steps: &'a [Value], seen: &mut Vec<Option<&'a Value>>) {
    if seen.contains(&id) {
        return;
    }
    seen.push(id);
    let deps = step_by_id_first(steps, id)
        .and_then(|s| s.get("dependencies"))
        .and_then(Value::as_array);
    if let Some(deps) = deps {
        for dep in deps {
            dfs_reachable(Some(dep), steps, seen);
        }
    }
}

/// TS `s.dependencies.length === 0` — 배열 길이 기준(비문자열 요소 포함; 비배열은 TS crash 면).
fn is_entry_point(step: &Value) -> bool {
    step.get("dependencies")
        .and_then(Value::as_array)
        .is_none_or(|d| d.is_empty())
}

#[derive(Debug, PartialEq, Serialize)]
pub struct DagValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// dag-validation.ts 와 동일 순서: 중복 ID → legacy/conditional orphan → control-node → disallowed
///   cycle → entry point 부재 → unreachable 경고(dependencies 기반 역방향 도달).
pub fn validate_dag(steps: &[Value]) -> DagValidationResult {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // TS `stepIds.size !== steps.length` — raw id 의 첫 중복 존재 여부.
    if steps
        .iter()
        .enumerate()
        .any(|(i, s)| steps[..i].iter().any(|t| t.get("id") == s.get("id")))
    {
        errors.push("Duplicate step IDs detected".to_string());
    }

    // orphan: raw 요소를 그대로 검사 — 비문자열 dep/stepId 도 TS 처럼 문자열화해 보고.
    for step in steps {
        let s = js_str(step.get("id"));
        let deps = step.get("dependencies").and_then(Value::as_array);
        for dep in deps.into_iter().flatten() {
            if !known_id(steps, Some(dep)) {
                errors.push(format!(
                    "Step \"{s}\" depends on non-existent step \"{}\"",
                    js_str(Some(dep))
                ));
            }
        }
        for edge in conditional_elems(step.get("conditionalDependencies")) {
            if !known_id(steps, edge.get("stepId")) {
                errors.push(format!(
                    "Step \"{s}\" conditionalDependency references non-existent step \"{}\"",
                    js_str(edge.get("stepId"))
                ));
            }
        }
    }

    errors.extend(control_nodes::validate_control_nodes(steps));

    if has_disallowed_cycle(steps) {
        errors.push("Workflow contains an unannotated cycle (circular dependency); only annotated back-edges (isBackEdge + maxIterations) may form a bounded loop".to_string());
    }

    let entries: Vec<&Value> = steps.iter().filter(|s| is_entry_point(s)).collect();
    if entries.is_empty() && !steps.is_empty() {
        errors.push("Workflow has no entry points (all steps have dependencies)".to_string());
    } else {
        let mut reachable: Vec<Option<&Value>> = Vec::new();
        for entry in entries {
            dfs_reachable(entry.get("id"), steps, &mut reachable);
        }
        for step in steps {
            if !reachable.contains(&step.get("id")) {
                warnings.push(format!(
                    "Step \"{}\" is unreachable from any entry point",
                    js_str(step.get("id"))
                ));
            }
        }
    }
    DagValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

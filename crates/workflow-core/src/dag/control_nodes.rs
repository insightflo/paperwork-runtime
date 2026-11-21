//! control-flow/control-node-validation.ts 의 IF/Complete 규칙 전량 포트 — dag.rs validate_dag 가 호출.
//!   conditionGroup zod 스키마는 condition_group.rs, forward 그래프 탐색·condition-source
//!   ancestor·parallel-branch 규칙은 topology.rs(Stage 2 잔여, 300줄 상한 분리).

mod condition_group;
mod topology;

use super::{conditional_elems, get_str, js_str, truthy_elems};
use crate::control_flow::string_elements;
use serde_json::Value;
use std::collections::HashSet;

fn is_type(step: &Value, t: &str) -> bool {
    step.get("type").and_then(Value::as_str) == Some(t)
}
/// TS `stepById.get`(Map — 같은 id 는 마지막 step 이 이긴다).
fn step_by_id<'a>(steps: &'a [Value], id: Option<&Value>) -> Option<&'a Value> {
    steps.iter().rev().find(|s| s.get("id") == id)
}
/// TS `edge.when ?? "success"` — 문자열 when 만, null/비문자열 → "success".
fn when_str(v: &Value) -> &str {
    get_str(v, "when").unwrap_or("success")
}
fn is_condition_when(v: &Value) -> bool {
    matches!(
        get_str(v, "when"),
        Some("condition_true" | "condition_false")
    )
}
fn is_back_edge(v: &Value) -> bool {
    matches!(v.get("isBackEdge"), Some(Value::Bool(true)))
}
/// 오류 메시지의 `${edge.when ?? "success"}` 표기(비문자열 when 도 JS 문자열화).
fn when_display(v: &Value) -> String {
    match v.get("when") {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "success".to_string(),
        Some(other) => js_str(Some(other)),
    }
}

/// control-node legacyDeps: dependencies+dependsOn 병합, 비지 않은 문자열만, 순서 보존 dedup.
///   TS `...(deps ?? [])` spread — 문자열 값은 chars 로 펼쳐진다(비배열 비문자열은 TS crash 면).
fn legacy_deps(step: &Value) -> Vec<String> {
    let raw = |k: &str| match step.get(k) {
        Some(Value::String(s)) => s.chars().map(|c| c.to_string()).collect(),
        other => string_elements(other),
    };
    let mut seen = HashSet::new();
    raw("dependencies")
        .into_iter()
        .chain(raw("dependsOn"))
        .filter(|dep| !dep.is_empty() && seen.insert(dep.clone()))
        .collect()
}

/// 조건부 edge 중 raw stepId 가 step_id 와 strict-equal 인 truthy edge 전부 — TS outgoingConditionEdges.
fn outgoing_raw<'a>(steps: &'a [Value], step_id: Option<&Value>) -> Vec<&'a Value> {
    steps
        .iter()
        .flat_map(|s| truthy_elems(s.get("conditionalDependencies")))
        .filter(|e| e.get("stepId") == step_id)
        .collect()
}

fn has_legacy_dependent(steps: &[Value], step_id: Option<&Value>) -> bool {
    step_id
        .and_then(Value::as_str)
        .is_some_and(|id| steps.iter().any(|s| legacy_deps(s).iter().any(|d| d == id)))
}

fn has_agent_or_tool_assignment(step: &Value) -> bool {
    // JS String.trim — U+0085(NEL) 유지. Rust trim 이 빼는 NEL 만 남은 문자열도 비어있지 않다.
    let nonempty = |k: &str| {
        step.get(k)
            .and_then(Value::as_str)
            .is_some_and(|v| !condition_group::js_trim(v).is_empty())
    };
    let list = |k: &str| {
        step.get(k).and_then(Value::as_array).is_some_and(|items| {
            items.iter().any(|t| {
                t.as_str()
                    .is_some_and(|v| !condition_group::js_trim(v).is_empty())
            })
        })
    };
    ["agentId", "agentName", "assigneeAgentId", "toolName"]
        .iter()
        .any(|k| nonempty(k))
        || ["tools", "toolNames"].iter().any(|k| list(k))
}

/// TS 와 동일한 두 패스: pass1 모든 step 의 condition_true/false 선행-IF 검사 → pass2 모든 step 의
///   IF/Complete 규칙. 오류 순서·문자열도 TS 그대로.
pub(super) fn validate_control_nodes(steps: &[Value]) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let pred_is_if = |id: Option<&Value>| step_by_id(steps, id).is_some_and(|s| is_type(s, "if"));
    for step in steps {
        let s = js_str(step.get("id"));
        for edge in truthy_elems(step.get("conditionalDependencies")) {
            if is_condition_when(edge) && !pred_is_if(edge.get("stepId")) {
                errors.push(format!(
                    "Step \"{s}\" has a {} edge from \"{}\" which is not an IF control node",
                    when_str(edge),
                    js_str(edge.get("stepId"))
                ));
            }
        }
    }
    for step in steps {
        let s = js_str(step.get("id"));
        let id = step.get("id");
        if is_type(step, "if") {
            let mut err = |m: &str| errors.push(format!("IF step \"{s}\" {m}"));
            if !condition_group::valid(step.get("conditionGroup")) {
                err("requires a valid non-empty conditionGroup");
            }
            let out = outgoing_raw(steps, id);
            let fwd = |w: &str| {
                out.iter()
                    .filter(|x| !is_back_edge(x) && when_str(x) == w)
                    .count()
            };
            if fwd("condition_true") == 0 {
                err("must have at least one outgoing condition_true edge");
            }
            if fwd("condition_false") == 0 {
                err("must have at least one outgoing condition_false edge");
            }
            if has_legacy_dependent(steps, id) {
                err("outgoing edges must use condition_true or condition_false");
            }
            for edge in &out {
                if is_back_edge(edge) {
                    err(&format!(
                        "{} output edge may not be a back-edge",
                        when_display(edge)
                    ));
                }
                if !is_condition_when(edge) {
                    err("outgoing edges must use condition_true or condition_false");
                }
            }
            if has_agent_or_tool_assignment(step) {
                err("must not select an agent or tool");
            }
            // Every IF source must be a forward ancestor (and not the IF itself).
            errors.extend(topology::condition_source_errors(step, steps));
        } else if is_type(step, "complete") {
            let mut err = |m: &str| errors.push(format!("Complete step \"{s}\" {m}"));
            // forward 진입 edge: legacy(success) + truthy 조건부(back-edge 제외). raw stepId 보존.
            let cd = step.get("conditionalDependencies");
            let mut incoming = legacy_deps(step).len();
            let mut cond_count = 0;
            let mut cond_id: Option<&Value> = None;
            for edge in truthy_elems(cd) {
                if !is_back_edge(edge) {
                    incoming += 1;
                    if is_condition_when(edge) {
                        cond_count += 1;
                        cond_id = edge.get("stepId");
                    }
                }
            }
            if incoming != 1 || cond_count != 1 {
                err("must have exactly one incoming forward condition edge");
            } else if !pred_is_if(cond_id) {
                err("incoming edge must originate from an IF control node");
            }
            if conditional_elems(cd).iter().any(|e| is_back_edge(e)) {
                err("may not carry a loop (back-edge) annotation");
            }
            if !outgoing_raw(steps, id).is_empty() || has_legacy_dependent(steps, id) {
                err("must have no outgoing edges");
            }
            if has_agent_or_tool_assignment(step) {
                err("must not select an agent or tool");
            }
        }
    }
    // Parallel-branch guard: Complete 도달 시 별도로 도달 가능한 병렬 분기를 남기면 거부.
    errors.extend(topology::parallel_branch_errors(steps));
    errors
}

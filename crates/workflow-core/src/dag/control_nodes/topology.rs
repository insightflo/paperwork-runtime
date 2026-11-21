//! [파일 목적] control-node-validation.ts Stage 2 잔여 포트 — forwardPredecessors/
//!   collectForwardAncestors/collectForwardDescendants 그래프 탐색, IF condition-source
//!   ancestor 규칙, Complete parallel-branch guard. control_nodes.rs 가 pass2 말과 pass3 에서 호출.
//! [parity] step id 멤버십은 raw JSON 값 비교(Option<&Value>) — Map last-wins·Set 삽입순을
//!   모사하고, 객체 id 는 JS 참조 동등이 아닌 deep-equality 근사(dag.rs 헤더와 동일 방침).

use super::{is_back_edge, is_condition_when, is_type, legacy_deps};
use crate::dag::{get_str, js_str, truthy_elems};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// TS forwardPredecessors — legacyDeps(dedup 유지) + truthy 비-back-edge 조건부의 문자열 stepId.
fn forward_predecessors(step: &Value) -> Vec<String> {
    let mut preds = legacy_deps(step);
    for e in truthy_elems(step.get("conditionalDependencies")) {
        if is_back_edge(e) {
            continue;
        }
        if let Some(id) = get_str(e, "stepId") {
            if !preds.iter().any(|p| p == id) {
                preds.push(id.to_string());
            }
        }
    }
    preds
}

/// TS collectForwardAncestors — predMap 은 raw step.id → 마지막 일치 step 의 preds(Map last-wins).
///   시작 id 는 raw 값(edge.stepId 등)으로 찾고 이후 pred 는 문자열 id 만 매칭한다(Map.get 의
///   strict-equality 와 동일 — 문자열 키는 문자열끼리만 만난다).
fn seed_preds(step: Option<&Value>, ancestors: &mut HashSet<String>, stack: &mut Vec<String>) {
    for pred in step.map_or_else(Vec::new, forward_predecessors) {
        if ancestors.insert(pred.clone()) {
            stack.push(pred);
        }
    }
}

fn forward_ancestors(start: Option<&Value>, steps: &[Value]) -> HashSet<String> {
    let mut ancestors: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    seed_preds(
        steps.iter().rev().find(|s| s.get("id") == start),
        &mut ancestors,
        &mut stack,
    );
    while let Some(id) = stack.pop() {
        seed_preds(
            steps
                .iter()
                .rev()
                .find(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str())),
            &mut ancestors,
            &mut stack,
        );
    }
    ancestors
}

/// TS collectForwardDescendants — succMap(pred 문자열 → 소유 step.id raw, 삽입순·dedup) 위 DFS.
///   반환은 도달 집합(순서 무관) — raw id 값 비교라 Vec+contains 로 SameValueZero 를 모사한다.
fn forward_descendants<'a>(start: Option<&'a Value>, steps: &'a [Value]) -> Vec<Option<&'a Value>> {
    let mut succ: HashMap<String, Vec<Option<&'a Value>>> = HashMap::new();
    for step in steps {
        for pred in forward_predecessors(step) {
            let list = succ.entry(pred).or_default();
            if !list.contains(&step.get("id")) {
                list.push(step.get("id"));
            }
        }
    }
    let mut desc: Vec<Option<&'a Value>> = vec![start];
    let mut stack = vec![start];
    while let Some(cur) = stack.pop() {
        let Some(key) = cur.and_then(Value::as_str) else {
            continue;
        };
        for nxt in succ.get(key).into_iter().flatten() {
            if !desc.contains(nxt) {
                desc.push(*nxt);
                stack.push(*nxt);
            }
        }
    }
    desc
}

/// TS outgoingConditionEdges — 소유 step.id(raw)와 edge 의 쌍. stepId 비교는 raw 값.
fn outgoing_targets<'a>(
    steps: &'a [Value],
    step_id: Option<&Value>,
) -> Vec<(Option<&'a Value>, &'a Value)> {
    steps
        .iter()
        .flat_map(|s| {
            let id = s.get("id");
            truthy_elems(s.get("conditionalDependencies"))
                .into_iter()
                .filter(move |e| e.get("stepId") == step_id)
                .map(move |e| (id, e))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// TS IF 블록 말의 condition-source 검사 — raw conditionGroup.conditions 를 순서대로
///   source.stepId 문자열 여부 → 자기참조 → 존재 → forward ancestor 순으로 판정한다.
pub(super) fn condition_source_errors(step: &Value, steps: &[Value]) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(conds) = step
        .get("conditionGroup")
        .and_then(Value::as_object)
        .and_then(|o| o.get("conditions"))
        .and_then(Value::as_array)
    else {
        return errors;
    };
    let ancestors = forward_ancestors(step.get("id"), steps);
    let s = js_str(step.get("id"));
    for cond in conds {
        let sid = cond
            .get("source")
            .and_then(|v| v.get("stepId"))
            .and_then(Value::as_str);
        match sid {
            None | Some("") => {
                errors.push(format!(
                    "IF step \"{s}\" has a condition without a source stepId"
                ));
            }
            Some(id) if step.get("id").and_then(Value::as_str) == Some(id) => {
                errors.push(format!(
                    "IF step \"{s}\" cannot read its own output as a condition source"
                ));
            }
            Some(id)
                if !steps
                    .iter()
                    .any(|st| st.get("id").and_then(Value::as_str) == Some(id)) =>
            {
                errors.push(format!(
                    "IF step \"{s}\" condition source \"{id}\" does not exist"
                ));
            }
            Some(id) if !ancestors.contains(id) => {
                errors.push(format!(
                    "IF step \"{s}\" condition source \"{id}\" is not a forward ancestor"
                ));
            }
            _ => {}
        }
    }
    errors
}

/// TS pass3 — Complete 마다 첫 forward condition edge 가 가리키는 IF 의 ancestors + 양 갈래
///   (비-back-edge condition_true/false target 의 forward descendants) + complete 자신을
///   allowed 로 하고, 그 밖의 첫 step 을 별도 병렬 분기로 보고한다.
pub(super) fn parallel_branch_errors(steps: &[Value]) -> Vec<String> {
    let mut errors = Vec::new();
    for complete in steps.iter().filter(|s| is_type(s, "complete")) {
        let Some(edge) = truthy_elems(complete.get("conditionalDependencies"))
            .into_iter()
            .find(|e| !is_back_edge(e) && is_condition_when(e))
        else {
            continue; // forward condition 진입 edge 없음 — pass2 에서 이미 보고됨.
        };
        let if_id = edge.get("stepId");
        let ancestors = forward_ancestors(if_id, steps);
        let mut raw: Vec<Option<&Value>> = vec![if_id];
        for (target, _) in outgoing_targets(steps, if_id)
            .into_iter()
            .filter(|(_, e)| !is_back_edge(e) && is_condition_when(e))
        {
            for d in forward_descendants(target, steps) {
                if !raw.contains(&d) {
                    raw.push(d);
                }
            }
        }
        raw.push(complete.get("id"));
        for step in steps {
            let id = step.get("id");
            let allowed = raw.contains(&id)
                || id
                    .and_then(Value::as_str)
                    .is_some_and(|x| ancestors.contains(x));
            if !allowed {
                errors.push(format!(
                    "Complete step \"{}\" would leave a separately reachable parallel branch active (step \"{}\")",
                    js_str(complete.get("id")),
                    js_str(id)
                ));
                break;
            }
        }
    }
    errors
}

//! [파일 목적] control-flow/structural-gate.ts + structural-topology.ts 의 Rust 포트
//!   (Stage 7A) — gate-producer-token / same-producer-token / is-structural-gate /
//!   structural-topology-errors 서브커맨드.
//! [parity] JS trim = White_Space 에서 U+0085(NEL) 제외 + U+FEFF 추가. `!== null` 은
//!   null 만 걸러 undefined·원시형은 필드 undefined 로 흐르되 same* 의 undefined 기반
//!   필드 접근은 TypeError → Err. for..of deps 는 배열·문자열(문자 순회)만, gate deps 는
//!   .map 전용이라 배열만 — 그 외는 Err. includes = 배열 SameValueZero / 문자열 ToString.
//! [외부 연결] consumer: main.rs dispatch. JsKey/DepId/step_id/steps_of 는
//!   crate::artifact_refs, js_str/strict_eq 는 crate::js_value 재사용.

use crate::artifact_refs::{step_id, steps_of, DepId, JsKey, KeyGen};
use crate::js_value::{js_str, strict_eq};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

/// ECMAScript WhiteSpace+LT — Rust `is_whitespace` 에서 U+0085(NEL) 를 빼고 U+FEFF 를 얹는다.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}'))
}

fn lower_trimmed(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map(|s| js_trim(s).to_lowercase())
        .unwrap_or_default()
}

fn qa_type_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$").unwrap())
}

/// 유효 toolName 수 — 비문자열·공백 원소 drop, 비배열이면 0.
fn tool_name_count(v: Option<&Value>) -> usize {
    v.and_then(Value::as_array).map_or(0, |names| {
        names
            .iter()
            .filter(|t| t.as_str().is_some_and(|s| !js_trim(s).is_empty()))
            .count()
    })
}

/// isStructuralGateStep — type:"tool" + qaType:"structural" + agentId 공백 +
///   유효 toolName 정확히 1. 비객체·배열은 false.
pub fn is_structural_gate_step(v: Option<&Value>) -> bool {
    let Some(obj) = v.and_then(Value::as_object) else {
        return false;
    };
    let agent = obj.get("agentId").and_then(Value::as_str);
    lower_trimmed(obj.get("type")) == "tool"
        && lower_trimmed(obj.get("qaType")) == "structural"
        && agent.is_none_or(|a| js_trim(a).is_empty())
        && tool_name_count(obj.get("toolNames")) == 1
}

/// isQaLikeStep — qaType contract 패턴 통과 또는 type∈{qa,validation,validator} 이면 qa 계열.
///   (비문자열 qaType 은 lower_trimmed 가 "" 로 만들어 패턴 검사와 동일하게 실패)
fn is_qa_like_step(v: &Value) -> bool {
    let get = |k: &str| v.as_object().and_then(|o| o.get(k));
    qa_type_re().is_match(&lower_trimmed(get("qaType")))
        || matches!(
            lower_trimmed(get("type")).as_str(),
            "qa" | "validation" | "validator"
        )
}

/// readStructuralGateProducerToken — producerStepId·completedAt 은 trim 후 비어있으면
///   무효, iterationIndex 는 finite integer 값 number 여야 한다(1e300 도 정수로 통과).
fn read_token(v: Option<&Value>) -> Option<Value> {
    let obj = v?.as_object()?;
    let pid = obj
        .get("producerStepId")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or_default();
    let it = obj.get("iterationIndex").and_then(Value::as_f64)?;
    let cat = obj
        .get("completedAt")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or_default();
    if pid.is_empty() || cat.is_empty() || !it.is_finite() || it.fract() != 0.0 {
        return None;
    }
    // JS 는 정수값 number 를 `.0` 없이 출력한다 — i64 범위면 정수 Value 로 낸다(1e300 등은 f64 유지).
    let idx: Value = if it.abs() < 9.223_372_036_854_776e18 {
        (it as i64).into()
    } else {
        it.into()
    };
    Some(json!({ "producerStepId": pid, "iterationIndex": idx, "completedAt": cat }))
}

/// `t.field` — 비객체(원시·배열) 기반 필드는 undefined.
fn token_field<'a>(t: &'a Value, key: &str) -> Option<&'a Value> {
    t.as_object().and_then(|o| o.get(key))
}

/// sameStructuralGateProducerToken — `left/right !== null` 후 세 필드를 === 비교한다.
///   undefined 기반 필드 접근은 TypeError → Err; 원시형·배열은 필드가 undefined.
fn same_token(left: Option<&Value>, right: Option<&Value>) -> Result<bool, String> {
    if matches!(left, Some(Value::Null)) || matches!(right, Some(Value::Null)) {
        return Ok(false);
    }
    let l = left.ok_or("cannot read properties of undefined")?;
    let r = right.ok_or("cannot read properties of undefined")?;
    for key in ["producerStepId", "iterationIndex", "completedAt"] {
        match (token_field(l, key), token_field(r, key)) {
            (None, None) => {}
            (Some(a), Some(b)) if strict_eq(a, b) => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

/// `${id}` 템플릿 보간 — undefined → "undefined".
fn id_str(id: &DepId) -> String {
    js_str(id.value())
}

/// `Array.join(", ")` — null/undefined 요소는 빈 문자열로 간다.
fn join_ids(ids: &[DepId]) -> String {
    ids.iter()
        .map(|d| {
            d.value()
                .filter(|v| !v.is_null())
                .map_or_else(String::new, |v| js_str(Some(v)))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `deps.includes(depId)` at gatesForProducer — producers 루프가 gate deps 를 배열로 좁혀
///   Err 경로는 도달 불가지만, 안전하게 false 로 둔다.
fn gate_has_dep(g: &Value, id: &DepId) -> bool {
    gate_deps(g).is_ok_and(|a| dep_includes(&Deps::Arr(a), id))
}

/// qa.dependencies 의 for..of 계약 — 배열은 원소 순회, 문자열은 문자 순회.
#[derive(Clone, Copy)]
enum Deps<'a> {
    Arr(&'a [Value]),
    Chars(&'a str),
}

/// `deps.includes(id)` — 배열은 SameValueZero, 문자열은 js_str(id) substring 검사.
fn dep_includes(deps: &Deps, id: &DepId) -> bool {
    match (deps, id.value()) {
        (Deps::Arr(a), Some(v)) => a.iter().any(|e| strict_eq(e, v)),
        (Deps::Arr(_), None) => false,
        (Deps::Chars(s), _) => s.contains(&js_str(id.value())),
    }
}

/// gate.dependencies — `.map` 호출부만 있으므로 배열이어야 한다(문자열도 TypeError).
fn gate_deps(gate: &Value) -> Result<&[Value], String> {
    gate.as_object()
        .and_then(|o| o.get("dependencies"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| "gate.dependencies.map is not a function".to_string())
}

/// qa.dependencies — for..of iterable(배열·문자열)만, 그 외(부재·null·스칼라·객체)는 TypeError.
fn qa_deps(qa: &Value) -> Result<Deps<'_>, String> {
    match qa.as_object().and_then(|o| o.get("dependencies")) {
        Some(Value::Array(a)) => Ok(Deps::Arr(a)),
        Some(Value::String(s)) => Ok(Deps::Chars(s)),
        _ => Err("qa.dependencies is not iterable".into()),
    }
}

/// gate 의 non-gate producer 후보 — dep id 로 찾은 step 중 존재 && !gate 인 것만.
fn producers_of<'a>(
    gate: &Value,
    by_id: &HashMap<JsKey, &'a Value>,
    gen: &mut KeyGen,
) -> Result<Vec<&'a Value>, String> {
    Ok(gate_deps(gate)?
        .iter()
        .filter_map(|id| by_id.get(&gen.key(&DepId::Val(id.clone()))).copied())
        .filter(|s| !is_structural_gate_step(Some(*s)))
        .collect())
}

/// getStructuralTopologyErrors — gate 의 non-gate producer 는 정확히 1개; QA 는 gate
///   의존 시 그 producer 도, producer 의존 시 관련 gate 전부도 함께 의존해야 한다.
///   null step 의 `step.id` TypeError 도 여기서 걸러 재현한다.
fn topology_errors(steps: &[Value]) -> Result<Vec<String>, String> {
    let mut gen = KeyGen::default();
    let mut by_id: HashMap<JsKey, &Value> = HashMap::new();
    for s in steps {
        if s.is_null() {
            return Err("cannot read id of null".into());
        }
        by_id.insert(gen.key(&step_id(s)), s);
    }
    let gates: Vec<&Value> = steps
        .iter()
        .filter(|s| is_structural_gate_step(Some(*s)))
        .collect();
    let mut errors: Vec<String> = vec![];
    if gates.is_empty() {
        return Ok(errors);
    }
    for &gate in &gates {
        let n = producers_of(gate, &by_id, &mut gen)?.len();
        if n != 1 {
            errors.push(format!(
                "Structural gate \"{}\" must have exactly one non-gate producer dependency, got {}.",
                id_str(&step_id(gate)),
                n
            ));
        }
    }
    for qa in steps {
        if is_structural_gate_step(Some(qa)) || !is_qa_like_step(qa) {
            continue;
        }
        let deps = qa_deps(qa)?;
        let dep_ids: Vec<DepId> = match deps {
            Deps::Arr(a) => a.iter().map(|v| DepId::Val(v.clone())).collect(),
            Deps::Chars(s) => s
                .chars()
                .map(|c| DepId::Val(json!(c.to_string())))
                .collect(),
        };
        for did in &dep_ids {
            let Some(dep) = by_id.get(&gen.key(did)).copied() else {
                continue;
            };
            if is_structural_gate_step(Some(dep)) {
                for p in producers_of(dep, &by_id, &mut gen)? {
                    if !dep_includes(&deps, &step_id(p)) {
                        errors.push(format!(
                            "QA step \"{}\" depends on structural gate \"{}\" but omits producer \"{}\".",
                            id_str(&step_id(qa)),
                            id_str(&step_id(dep)),
                            id_str(&step_id(p))
                        ));
                    }
                }
                continue;
            }
            let dep_id = step_id(dep);
            let missing: Vec<DepId> = gates
                .iter()
                .copied()
                .filter(|g| gate_has_dep(g, &dep_id))
                .map(step_id)
                .filter(|gid| !dep_includes(&deps, gid))
                .collect();
            if !missing.is_empty() {
                errors.push(format!(
                    "QA step \"{}\" reviews producer \"{}\" but is missing structural gate(s): {}.",
                    id_str(&step_id(qa)),
                    id_str(&dep_id),
                    join_ids(&missing)
                ));
            }
        }
    }
    Ok(errors)
}

pub fn gate_producer_token(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "token": read_token(input.get("value")) }))
}

pub fn same_producer_token(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "same": same_token(input.get("left"), input.get("right"))? }))
}

pub fn is_structural_gate(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "isGate": is_structural_gate_step(input.get("step")) }))
}

pub fn structural_topology_errors(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "errors": topology_errors(steps_of(&input)?)? }))
}

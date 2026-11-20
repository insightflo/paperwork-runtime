//! [파일 목적] step-artifact-references.ts 순수 코어의 Rust 포트(Stage 7A) —
//!   artifact-references / ancestor-step-ids / tool-reference-errors 서브커맨드.
//! [parity] Object.values 순회는 JS 규칙(array-index 키 ≤2^32-2 숫자 오름차 선행, 나머지
//!   삽입 순) — preserve_order 는 후자만 준다. Set 삽입 순 = 첫 발견 순. `...(deps ?? [])`
//!   의 비iterable/ null edge 는 TypeError → Err. dep id 는 SameValueZero 키 정규화
//!   (1==1.0, -0==+0, 문자열↔숫자 별개, 배열/객체는 occurrence 마다 유일 Ref). 비null
//!   비객체 edge 는 isBackEdge!==true 통과 → stepId=undefined dep.
//! [외부 연결] consumer: main.rs dispatch. JsKey/DepId/KeyGen/step_id/steps_of 는
//!   structural_gate.rs 가 재사용한다.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// JS Map/Set 의 SameValueZero 등가 키 — 숫자는 -0→+0 정규화 f64 bits, 배열/객체는 Ref.
#[derive(Clone, Hash, PartialEq, Eq)]
pub enum JsKey {
    Undefined,
    Null,
    Bool(bool),
    Num(u64),
    Str(String),
    Ref(usize),
}

/// dep 원소·step.id 의 값 — JSON 에 없는 undefined 도 표현한다(직렬화 시 null).
#[derive(Clone)]
pub enum DepId {
    Undefined,
    Val(Value),
}

impl DepId {
    /// JS `${id}` 보간 / includes 인수로의 값 — undefined 는 값 없음(None).
    pub fn value(&self) -> Option<&Value> {
        match self {
            DepId::Undefined => None,
            DepId::Val(v) => Some(v),
        }
    }
}

/// 한 스캔 안에서 배열/객체 occurrence 마다 유일한 JsKey::Ref 를 발급한다(JS 참조 동등).
#[derive(Default)]
pub struct KeyGen(usize);

impl KeyGen {
    pub fn key(&mut self, id: &DepId) -> JsKey {
        match id {
            DepId::Undefined => JsKey::Undefined,
            DepId::Val(v) => self.key_of(v),
        }
    }
    fn key_of(&mut self, v: &Value) -> JsKey {
        match v {
            Value::Null => JsKey::Null,
            Value::Bool(b) => JsKey::Bool(*b),
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                JsKey::Num(if f == 0.0 { 0.0_f64 } else { f }.to_bits())
            }
            Value::String(s) => JsKey::Str(s.clone()),
            Value::Array(_) | Value::Object(_) => {
                self.0 += 1;
                JsKey::Ref(self.0)
            }
        }
    }
}

/// `step.id` — 비객체 step 은 JS 에서 undefined 를 읽는다(null step TypeError 는 호출부가 Err 로 재현).
pub fn step_id(step: &Value) -> DepId {
    step.as_object()
        .and_then(|o| o.get("id"))
        .map_or(DepId::Undefined, |v| DepId::Val(v.clone()))
}

/// `steps` 필드 추출 — 비배열/부재는 TS `steps.map` TypeError 에 해당(Err → exit 1).
pub fn steps_of(input: &Value) -> Result<&[Value], String> {
    input
        .get("steps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| "steps is not iterable".to_string())
}

fn artifact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\{\$steps\.([A-Za-z0-9_-]+)\.(?:workProductPath|workProductDir|siblingAssetsDir)\}",
        )
        .unwrap()
    })
}

/// JS array index — canonical 숫자 문자열 && ≤2^32-2. "4294967295"·"00"·"01" 은 문자열 키.
fn js_array_index(k: &str) -> Option<u32> {
    if k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) || k.starts_with('0') && k.len() > 1 {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// `Object.values` 순회 순서 — array-index 키 숫자 오름차 선행, 나머지 삽입 순.
fn js_object_values(obj: &Map<String, Value>) -> Vec<&Value> {
    let mut indexed: Vec<(u32, &Value)> = obj
        .iter()
        .filter_map(|(k, v)| js_array_index(k).map(|n| (n, v)))
        .collect();
    indexed.sort_by_key(|(n, _)| *n);
    let rest = obj
        .iter()
        .filter(|(k, _)| js_array_index(k).is_none())
        .map(|(_, v)| v);
    indexed.into_iter().map(|(_, v)| v).chain(rest).collect()
}

/// collectArtifactReferences — {$steps.<id>.<key>} 토큰만 수집, 배열·객체 값은 재귀.
fn collect_refs_into(v: &Value, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    match v {
        Value::String(s) => out.extend(artifact_re().captures_iter(s).filter_map(|m| {
            let id = m[1].to_string();
            seen.insert(id.clone()).then_some(id)
        })),
        Value::Array(arr) => arr.iter().for_each(|e| collect_refs_into(e, out, seen)),
        Value::Object(o) => js_object_values(o)
            .into_iter()
            .for_each(|e| collect_refs_into(e, out, seen)),
        _ => {}
    }
}

pub fn collect_artifact_references(v: Option<&Value>) -> Vec<String> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    if let Some(v) = v {
        collect_refs_into(v, &mut out, &mut seen);
    }
    out
}

/// `...(dependencies ?? dependsOn ?? [])` + `(conditionalDependencies ?? []).filter().map()`
///   의 dep 전개 — 문자열 deps 는 문자 단위 spread, condDeps 는 배열 아니면 .filter TypeError.
fn predecessors(step: &Value) -> Result<Vec<DepId>, String> {
    let Some(obj) = step.as_object() else {
        return Ok(vec![]);
    };
    let mut out = vec![];
    let raw = obj
        .get("dependencies")
        .filter(|v| !v.is_null())
        .or_else(|| obj.get("dependsOn").filter(|v| !v.is_null()));
    match raw {
        None => {}
        Some(Value::Array(a)) => out.extend(a.iter().map(|v| DepId::Val(v.clone()))),
        Some(Value::String(s)) => out.extend(s.chars().map(|c| DepId::Val(json!(c.to_string())))),
        Some(_) => return Err("predecessors is not iterable".into()),
    }
    match obj.get("conditionalDependencies").filter(|v| !v.is_null()) {
        None => {}
        Some(Value::Array(a)) => {
            for e in a {
                match e {
                    Value::Null => return Err("cannot read isBackEdge of null".into()),
                    Value::Object(o) if o.get("isBackEdge") == Some(&Value::Bool(true)) => {}
                    Value::Object(o) => out.push(
                        o.get("stepId")
                            .map_or(DepId::Undefined, |v| DepId::Val(v.clone())),
                    ),
                    _ => out.push(DepId::Undefined),
                }
            }
        }
        Some(_) => return Err("conditionalDependencies.filter is not a function".into()),
    }
    Ok(out)
}

/// collectAncestorStepIds — stack DFS 로 forward 전체 선행을 발견 순에 모은다.
///   반환: 발견 순 목록 + 키 집합(seed 인 current 는 ancestors 미포함 — 자기참조 가드).
pub fn collect_ancestor_step_ids(
    current: &DepId,
    steps: &[Value],
) -> Result<(Vec<DepId>, HashSet<JsKey>), String> {
    let mut gen = KeyGen::default();
    let mut by_id: HashMap<JsKey, &Value> = HashMap::new();
    for s in steps {
        if s.is_null() {
            return Err("cannot read id of null".into());
        }
        by_id.insert(gen.key(&step_id(s)), s); // Map.set — 중복 키는 마지막 step 이 덮는다
    }
    let cur = gen.key(current);
    let mut visited: HashSet<JsKey> = HashSet::from([cur.clone()]);
    let mut stack = vec![cur];
    let mut ancestors: Vec<DepId> = vec![];
    let mut keys: HashSet<JsKey> = HashSet::new();
    while let Some(k) = stack.pop() {
        let Some(step) = by_id.get(&k) else {
            continue;
        };
        for dep in predecessors(step)? {
            let dk = gen.key(&dep);
            if visited.insert(dk.clone()) {
                stack.push(dk.clone());
                keys.insert(dk);
                ancestors.push(dep);
            }
        }
    }
    Ok((ancestors, keys))
}

/// findWorkflowToolReferenceErrors — refs 가 steps 에 없으면 unknown_step, ancestor 가 아니면
///   not_ancestor. stepId 는 undefined 이면 오류 객체에서 키가 빠진다.
pub fn find_tool_reference_errors(steps: &[Value]) -> Result<Vec<Value>, String> {
    let mut gen = KeyGen::default();
    let mut known: HashSet<JsKey> = HashSet::new();
    for s in steps {
        if s.is_null() {
            return Err("cannot read id of null".into());
        }
        known.insert(gen.key(&step_id(s)));
    }
    let mut errors = vec![];
    for s in steps {
        let refs = collect_artifact_references(s.as_object().and_then(|o| o.get("toolArgs")));
        if refs.is_empty() {
            continue;
        }
        let id = step_id(s);
        let (_, keys) = collect_ancestor_step_ids(&id, steps)?;
        for r in refs {
            let rk = JsKey::Str(r.clone());
            let reason = if !known.contains(&rk) {
                "unknown_step"
            } else if !keys.contains(&rk) {
                "not_ancestor"
            } else {
                continue;
            };
            let mut e = Map::new();
            if let DepId::Val(v) = &id {
                e.insert("stepId".into(), v.clone());
            }
            e.insert("referencedStepId".into(), json!(r));
            e.insert("reason".into(), json!(reason));
            errors.push(Value::Object(e));
        }
    }
    Ok(errors)
}

pub fn artifact_references(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "references": collect_artifact_references(input.get("value")) }))
}

pub fn ancestor_step_ids(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let cur = input
        .get("currentStepId")
        .map_or(DepId::Undefined, |v| DepId::Val(v.clone()));
    let (ancestors, _) = collect_ancestor_step_ids(&cur, steps_of(&input)?)?;
    let out: Vec<Value> = ancestors
        .iter()
        .map(|d| d.value().cloned().unwrap_or(Value::Null))
        .collect();
    Ok(json!({ "ancestors": out }))
}

pub fn tool_reference_errors(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "errors": find_tool_reference_errors(steps_of(&input)?)? }))
}

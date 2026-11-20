//! [파일 목적] resume/graph.ts(forwardReachable) + step-contract.ts 의 Rust 포트 (Stage 8A)
//!   — forward-reachable / normalize-step-contract / normalize-step-machine-checks 서브커맨드.
//! [parity] nodes/deps/condDeps 는 배열·문자열만 iterable(문자열은 code-point 순회 — char 는
//!   id/stepId undefined → unsupported_graph), 비iterable·.length 불가·null node·null cond 는
//!   TypeError → Err. node.id 는 "string"·nonempty·unique(빈 nodes 도 ids 에 걸려 reject).
//!   dedup 은 per-from children Vec, 자기 간선·미상 대상·전역 Kahn 사이클(비연결 포함)은
//!   unsupported_graph. 출력은 JS sort() = UTF-16 code-unit 사전순(encode_utf16 비교 — 비BMP
//!   pair 가 U+E000+ 보다 앞섬). contract: 비배열 객체만 — 섹션은 문자열 배열 JS-trim·빈
//!   제거·모두 없으면 null. checks: kind trim 4종, path/dir ≤500·glob ≤200·sha256 ≤64+hex64
//!   (UTF-16 unit), minCount undefined→1·정수 ≥1, minBytes 정수 ≥0, 수용 20 cap, 정수 f64
//!   (-0)는 u64 10진 출력. js_trim = structural_gate 것(NEL 제외 + FEFF) 공유.

use crate::structural_gate::js_trim;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const UNSUPPORTED: &str = "unsupported_graph";

/// TS `ids.has(dep)` — 등록 id 문자열일 때만 dep 후보로 통과.
fn known_id<'a>(v: Option<&'a str>, ids: &HashSet<String>) -> Result<&'a str, String> {
    v.filter(|s| ids.contains(*s))
        .ok_or_else(|| UNSUPPORTED.to_string())
}

/// for..of dep 대상 수집 — cond 면 {stepId} 객체 필수(null 은 TypeError), 문자열은 code-point 순회.
fn dep_targets<'a>(
    v: Option<&'a Value>,
    cond: bool,
    ids: &HashSet<String>,
) -> Result<Vec<&'a str>, String> {
    let mut out = Vec::new();
    match v {
        Some(Value::Array(items)) => {
            for item in items {
                let dep = match (cond, item) {
                    (true, Value::Null) => return Err("cannot read properties of null".to_string()),
                    (true, Value::Object(m)) => m.get("stepId").and_then(Value::as_str),
                    (true, _) => None,
                    (false, _) => item.as_str(),
                };
                out.push(known_id(dep, ids)?);
            }
        }
        Some(Value::String(s)) => {
            for (i, c) in s.char_indices() {
                if cond {
                    return Err(UNSUPPORTED.to_string());
                }
                out.push(known_id(Some(&s[i..i + c.len_utf8()]), ids)?);
            }
        }
        _ => return Err("not iterable".to_string()),
    }
    Ok(out)
}

fn forward_reachable_inner<'a>(
    nodes: &'a [Value],
    start: Option<&'a Value>,
) -> Result<Vec<String>, String> {
    let mut ids = HashSet::with_capacity(nodes.len());
    for n in nodes {
        let id = match n {
            Value::Null => return Err("cannot read properties of null".to_string()),
            Value::Object(m) => m.get("id").and_then(Value::as_str).unwrap_or_default(),
            _ => return Err(UNSUPPORTED.to_string()),
        };
        // === "string" && !== "" && !ids.has — Set.insert 가 중복을 직접 걸러 준다.
        if id.is_empty() || !ids.insert(id.to_string()) {
            return Err(UNSUPPORTED.to_string());
        }
    }
    let start = known_id(start.and_then(Value::as_str), &ids)?;

    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    for n in nodes {
        let obj = n.as_object().unwrap(); // 검증 통과 node 는 전부 객체다.
        let to = obj.get("id").and_then(Value::as_str).unwrap();
        // per-parent edge identity — children[from] 자체가 to-Set 역할(중복 간선은 dedup).
        let mut add = |from: &'a str| -> Result<(), String> {
            if from == to {
                return Err(UNSUPPORTED.to_string());
            }
            let ch = children.entry(from).or_default();
            if ch.contains(&to) {
                return Ok(()); // duplicate edge — indegree/Kahn 전 dedup(거부 아님)
            }
            ch.push(to);
            *indegree.entry(to).or_insert(0) += 1;
            Ok(())
        };
        for dep in dep_targets(obj.get("dependencies"), false, &ids)? {
            add(dep)?;
        }
        for dep in dep_targets(obj.get("conditionalDependencies"), true, &ids)? {
            add(dep)?;
        }
    }

    // 전체 그래프 Kahn(index cursor) — 비연결 컴포넌트의 사이클도 reject.
    let mut queue: VecDeque<&str> = ids
        .iter()
        .filter(|id| !indegree.contains_key(id.as_str()))
        .map(String::as_str)
        .collect();
    let mut processed = 0usize;
    while let Some(cur) = queue.pop_front() {
        processed += 1;
        for child in children.get(cur).into_iter().flatten() {
            let d = indegree.get_mut(child).unwrap();
            *d -= 1;
            if *d == 0 {
                queue.push_back(child);
            }
        }
    }
    if processed != ids.len() {
        return Err(UNSUPPORTED.to_string());
    }

    // start 에서 index cursor BFS — 조건 분기는 조건 평가 없이 양쪽 모두 포함한다.
    let (mut visited, mut frontier) = (HashSet::from([start]), VecDeque::from([start]));
    while let Some(cur) = frontier.pop_front() {
        for child in children.get(cur).into_iter().flatten() {
            if visited.insert(child) {
                frontier.push_back(child);
            }
        }
    }
    // JS Array.prototype.sort() — UTF-16 code-unit 사전순.
    let mut out: Vec<String> = visited.iter().map(|s| s.to_string()).collect();
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(out)
}

fn parse(raw: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(raw).map_err(|e| e.to_string())
}

/// forward-reachable — `{"nodes":[...], "startId":"..."}` → `{"reachable":[...]}`.
pub fn forward_reachable(raw: &[u8]) -> Result<Value, String> {
    let input = parse(raw)?;
    let nodes: Vec<Value> = match input.get("nodes") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        _ => return Err("nodes is not iterable".to_string()),
    };
    Ok(json!({ "reachable": forward_reachable_inner(&nodes, input.get("startId"))? }))
}

/// readSection — 배열만, 문자열 항목을 JS-trim·빈 제거, 전부 비면 undefined.
fn read_section(rec: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    let items: Vec<String> = rec
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(js_trim))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!items.is_empty()).then_some(items)
}

/// readTrimmedCheckString — 문자열만, JS-trim 후 1..=max(UTF-16 unit) 여야 채택.
fn read_check_str(v: Option<&Value>, max: usize) -> Option<String> {
    let t = js_trim(v?.as_str()?);
    (!t.is_empty() && t.encode_utf16().count() <= max).then(|| t.to_string())
}

/// readNonNegativeInt + JS 정수 출력 — Number.isInteger && >=0 → u64 Value(그 외 f64)/None.
fn int_field(v: Option<&Value>) -> Option<Value> {
    let f = v?.as_f64()?;
    if f.fract() != 0.0 || f < 0.0 {
        return None;
    }
    Some(if f <= u64::MAX as f64 {
        Value::from(f as u64)
    } else {
        Value::from(f)
    })
}

const MAX_CHECKS: usize = 20;

/// kind 별 기계 검증 술어 하나 — 필드 미달이면 None(drop).
fn one_check(rec: &Map<String, Value>) -> Option<Value> {
    let kind = rec
        .get("kind")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    let g = |k: &str, max: usize| read_check_str(rec.get(k), max);
    match kind {
        "file_exists" => Some(json!({ "kind": "file_exists", "path": g("path", 500)? })),
        "file_glob" => {
            let (dir, glob) = (g("dir", 500)?, g("glob", 200)?);
            let min = match rec.get("minCount") {
                None => Some(json!(1)), // `=== undefined` 만 기본값 — null·비정수는 drop.
                some => int_field(some),
            }?;
            (min.as_f64()? >= 1.0)
                .then(|| json!({ "kind": "file_glob", "dir": dir, "glob": glob, "minCount": min }))
        }
        "min_size_bytes" => {
            let (path, mb) = (g("path", 500)?, int_field(rec.get("minBytes"))?);
            Some(json!({ "kind": "min_size_bytes", "path": path, "minBytes": mb }))
        }
        "content_sha256" => {
            let (path, sha) = (g("path", 500)?, g("sha256", 64)?);
            (sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| json!({ "kind": "content_sha256", "path": path, "sha256": sha }))
        }
        _ => None,
    }
}

/// 수용된 검증만 순서대로 MAX_CHECKS 개까지 — 전부 drop 이면 undefined.
fn machine_checks(raw: Option<&Value>) -> Option<Vec<Value>> {
    let checks: Vec<Value> = raw?
        .as_array()?
        .iter()
        .filter_map(|e| e.as_object().and_then(one_check))
        .take(MAX_CHECKS)
        .collect();
    (!checks.is_empty()).then_some(checks)
}

fn contract(raw: Option<&Value>) -> Value {
    let Some(rec) = raw.and_then(Value::as_object) else {
        return Value::Null;
    };
    let sections = [
        (
            "preconditions",
            read_section(rec, "preconditions").map(Value::from),
        ),
        (
            "postconditions",
            read_section(rec, "postconditions").map(Value::from),
        ),
        (
            "undefinedBehaviors",
            read_section(rec, "undefinedBehaviors").map(Value::from),
        ),
        (
            "machineChecks",
            machine_checks(rec.get("machineChecks")).map(Value::from),
        ),
    ];
    if sections.iter().all(|(_, v)| v.is_none()) {
        return Value::Null;
    }
    Value::Object(
        sections
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.into(), v)))
            .collect(),
    )
}

/// normalize-step-contract — `{"value":<raw>}` → `{"contract":<obj|null>}`.
pub fn normalize_step_contract(raw: &[u8]) -> Result<Value, String> {
    Ok(json!({ "contract": contract(parse(raw)?.get("value")) }))
}

/// normalize-step-machine-checks — `{"value":<raw>}` → `{"machineChecks":[...]|null}`.
pub fn normalize_step_machine_checks(raw: &[u8]) -> Result<Value, String> {
    Ok(json!({ "machineChecks": machine_checks(parse(raw)?.get("value")) }))
}

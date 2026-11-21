//! Shared helpers for the revision-reuse port: JS own-key order, UTF-16
//! length, template/`===`/Set/for-of semantics (V8 texts verified on Node
//! 24), and a zod-lite parser for `mission-revision-delta.v1`. Edge/role
//! helpers (edge-condition.ts, workflow-step-role.ts) live in
//! crate::revision_reuse_steps.
use serde_json::{json, Map, Value};

/// JS own-key order: array-index keys ("0".."4294967294") ascending, then
/// remaining string keys in insertion order (Object.keys/spread semantics).
pub fn js_own_keys(o: &Map<String, Value>) -> Vec<String> {
    let mut idx: Vec<(u64, String)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for k in o.keys() {
        match array_index(k) {
            Some(i) => idx.push((i, k.clone())),
            None => rest.push(k.clone()),
        }
    }
    idx.sort_by_key(|(i, _)| *i);
    idx.into_iter().map(|(_, k)| k).chain(rest).collect()
}
fn array_index(k: &str) -> Option<u64> {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let v: u64 = k.parse().ok()?;
    (v < u64::from(u32::MAX) && v.to_string() == k).then_some(v)
}

/// JS String#length (UTF-16 code units) — zod min/max count this way.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS `Number::toString` — JS JSON.parse 는 JSON 숫자 전부를 IEEE-754 f64 로
///   읽으므로 큰 i64/u64 도 f64 반올림이 정답이다(2^63 → "9223372036854776000").
///   crate::js 공유 구현(js_num_str: |x|>=1e21·|x|<1e-6 지수 표기까지 ECMA 규칙)
///   으로 전부 보낸다.
fn num_str(n: &serde_json::Number) -> String {
    let f = n.as_f64().unwrap_or(f64::NAN);
    if !f.is_finite() {
        return format!("{f}"); // serde_json Number 는 항상 유한 — 방어적 텍스트 유지
    }
    crate::js::js_num_str(f)
}
/// `${v}` template interpolation (array → join ",", object → "[object Object]").
pub fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => num_str(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|e| {
                if e.is_null() {
                    String::new()
                } else {
                    js_str(e)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// `None` models a read that produced `undefined`.
pub fn js_str_opt(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js_str)
}

/// Map/Set SameValueZero lookup key; objects/arrays are identity-keyed and
/// can never match another lookup value → None (unfindable).
pub fn js_map_key(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => "z:null".into(),
        Value::Bool(b) => format!("b:{b}"),
        Value::Number(n) => format!("n:{}", n.as_f64().unwrap_or(f64::NAN).to_bits()),
        Value::String(s) => format!("s:{s}"),
        _ => return None,
    })
}
/// `a === b` — primitives by value (numbers as f64, so 5 === 5.0 and
/// NaN !== NaN); objects/arrays are identity-compared → never equal here.
pub fn js_strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}
/// `for (const x of expr)` domain: arrays → items, strings → chars; other
/// values raise V8 "<expr> is not iterable" (source-text of the operand).
pub fn iter_values(v: &Value, expr: &str) -> Result<Vec<Value>, String> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(format!("{expr} is not iterable")),
    }
}
/// `new Set(expr)` domain: null/undefined → empty, array → items, string →
/// chars; else the V8 Set-constructor TypeError text.
pub fn new_set_items(v: Option<&Value>) -> Result<Vec<Value>, String> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(v) => Err(format!(
            "{} is not iterable (cannot read property Symbol(Symbol.iterator))",
            match v {
                Value::Bool(b) => format!("boolean {b}"),
                Value::Number(n) => format!("number {}", num_str(n)),
                _ => "object".into(),
            }
        )),
    }
}
/// `expr.method(...)` receiver: array → items; null/undefined → V8 read
/// error; other → "expr.method is not a function".
pub fn array_method<'a>(v: Option<&'a Value>, expr: &str, m: &str) -> Result<&'a [Value], String> {
    match v {
        Some(Value::Array(a)) => Ok(a),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{m}')")),
        None => Err(format!(
            "Cannot read properties of undefined (reading '{m}')"
        )),
        Some(_) => Err(format!("{expr}.{m} is not a function")),
    }
}

const DELTA_OPS: [&str; 6] = ["reuse", "rerun", "modify", "add", "clone", "blocked"];
const ROOT_KEYS: [&str; 5] = [
    "schemaVersion",
    "sourceWorkflowRunId",
    "base",
    "units",
    "capabilityRequirements",
];

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && [8usize, 13, 18, 23].into_iter().all(|i| b[i] == b'-')
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}
fn delta_id(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| (1..=200).contains(&utf16_len(s)))
}
/// z.record(z.unknown()) pass-through (own-key order like ZodRecord output).
fn record(v: Option<&Value>) -> Option<Map<String, Value>> {
    let o = v?.as_object()?;
    Some(
        js_own_keys(o)
            .into_iter()
            .map(|k| (k.clone(), o[&k].clone()))
            .collect(),
    )
}
fn opt(
    o: &Map<String, Value>,
    m: &mut Map<String, Value>,
    k: &str,
    ok: impl Fn(&Value) -> bool,
) -> bool {
    match o.get(k) {
        None => true,
        Some(v) if ok(v) => {
            m.insert(k.into(), v.clone());
            true
        }
        _ => false,
    }
}
/// missionRevisionDeltaUnitSchema strip-parse → sanitized unit in shape order.
fn parse_unit(u: &Value) -> Option<Map<String, Value>> {
    let o = u.as_object()?;
    if !delta_id(o.get("unitId"))
        || !o
            .get("operation")
            .and_then(Value::as_str)
            .is_some_and(|s| DELTA_OPS.contains(&s))
    {
        return None;
    }
    let mut m = Map::new();
    m.insert("unitId".into(), o["unitId"].clone());
    m.insert("operation".into(), o["operation"].clone());
    if !opt(o, &mut m, "templateStepId", |v| delta_id(Some(v)))
        || !opt(o, &mut m, "sourceStepId", |v| delta_id(Some(v)))
        || !opt(o, &mut m, "instructions", |v| {
            v.as_str().is_some_and(|s| utf16_len(s) >= 1)
        })
    {
        return None;
    }
    if let Some(v) = o.get("interpretedInputs") {
        m.insert("interpretedInputs".into(), Value::Object(record(Some(v))?));
    }
    if let Some(v) = o.get("requiredInputs") {
        let arr = v.as_array().filter(|a| !a.is_empty())?;
        let mut items = Vec::with_capacity(arr.len());
        for e in arr {
            let eo = e.as_object()?;
            if !delta_id(eo.get("fromUnitId")) {
                return None;
            }
            let mut em = Map::new();
            em.insert("fromUnitId".into(), eo["fromUnitId"].clone());
            em.insert(
                "selector".into(),
                Value::Object(record(eo.get("selector"))?),
            );
            items.push(Value::Object(em));
        }
        m.insert("requiredInputs".into(), Value::Array(items));
    }
    if !opt(o, &mut m, "collectionScope", |v| {
        v.as_str()
            .is_some_and(|s| matches!(s, "oneShot" | "permanentChange"))
    }) {
        return None;
    }
    Some(m)
}
/// missionRevisionDeltaSchema.safeParse → sanitized units (strict root,
/// strip objects, superRefine reuse identity rules). None = parse failure.
pub fn parse_delta_units(raw: &Value) -> Option<Vec<Value>> {
    let o = raw.as_object()?;
    if o.keys().any(|k| !ROOT_KEYS.contains(&k.as_str()))
        || o.get("schemaVersion") != Some(&json!("mission-revision-delta.v1"))
        || !o
            .get("sourceWorkflowRunId")
            .and_then(Value::as_str)
            .is_some_and(is_uuid)
    {
        return None;
    }
    let base = o.get("base").and_then(Value::as_object)?;
    let snap_ok = base
        .get("snapshotHash")
        .and_then(Value::as_str)
        .is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        });
    if !base
        .get("workflowDefinitionId")
        .and_then(Value::as_str)
        .is_some_and(is_uuid)
        || !snap_ok
    {
        return None;
    }
    let units = o
        .get("units")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())?;
    let mut out = Vec::with_capacity(units.len());
    for u in units {
        out.push(Value::Object(parse_unit(u)?));
    }
    if let Some(v) = o.get("capabilityRequirements") {
        for e in v.as_array().filter(|a| !a.is_empty())? {
            let eo = e.as_object()?;
            if !["unitId", "requiredOutcomeId", "toolName", "capability"]
                .iter()
                .all(|k| delta_id(eo.get(*k)))
            {
                return None;
            }
        }
    }
    for u in &out {
        if u["operation"] != "reuse" {
            continue;
        }
        let uo = u.as_object().unwrap();
        let identity = uo
            .keys()
            .all(|k| matches!(k.as_str(), "unitId" | "operation" | "sourceStepId"));
        let same = uo.get("sourceStepId").and_then(Value::as_str) == uo["unitId"].as_str();
        if !identity || !same {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests;

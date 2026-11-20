//! [파일 목적] run-input-derivations.ts 포트(Stage 8C) — extract-youtube-video-id /
//!   validate-run-input-declarations / apply-run-input-derivations 서브커맨드.
//! [parity] `${v}`=js_str, trim=js_trim(NEL 보존). zod 3.25 union: 첫 valid 우선, 없으면
//!   첫 dirty 브랜치 이슈, 전부 aborted 면 invalid_union "Invalid input"@[i]. 타입·
//!   필수부재·literal/enum/never 불일치는 abort(이슈 폐기), regex/min·strict extras·
//!   superRefine 은 dirty. 배열은 too_big→요소 순; aborted 요소가 있으면 superRefine
//!   (키 중복) 미실행. truthy=JS !v, metadata={...m}(문자열/배열→인덱스 키).
//! [외부 연결] consumer: dispatch.rs. js_value::js_str·crate root 공용 술어(Br/ab/
//!   extras_at/opt_item_scan/truthy/nonempty_str/key_char/youtube_id) 재사용.

use crate::definition_step_validation::df_scan;
use crate::js_value::js_str;
use crate::{
    ab, extras_at, key_char, nonempty_str, opt_bool, opt_item_scan, opt_str, truthy, youtube_id, Br,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const PREFIX: &str = "Invalid workflow runInputs";
/// runInputs 선언의 허용 키 — strict() 는 멤버십만 보기에 4개 분기가 하나로 합쳐진다.
pub(crate) const DECL_KEYS: &[&str] = &[
    "key",
    "label",
    "required",
    "placeholder",
    "type",
    "deriveFrom",
    "options",
    "default",
];

// ── zod union 4분기 — text→radio→checkbox→switch 순: 첫 Clean(valid) 우선,
//   없으면 첫 Dirty 이슈, 전부 Abort 면 invalid_union "{i}: Invalid input".
/// 공통 shape 앞부분 — key 필수문자열(비문자열 abort, regex 실패 dirty) +
///   label/required/placeholder 타입 abort.
fn base_scan(o: &Map<String, Value>) -> Br {
    if !matches!(o.get("key"), Some(Value::String(_)))
        || !opt_str(o, "label")
        || !opt_bool(o, "required")
        || !opt_str(o, "placeholder")
    {
        return Br::Abort;
    }
    let key = o.get("key").and_then(Value::as_str).unwrap_or_default();
    if !key.bytes().all(key_char) || !(1..=40).contains(&key.len()) {
        return Br::Dirty("key".into(), "Invalid".into());
    }
    Br::Clean
}
/// DECL_KEYS 밖 키 — 요소 루트 경로의 unrecognized_keys Dirty.
fn root_extras(o: &Map<String, Value>) -> Br {
    extras_at(o, DECL_KEYS, String::new())
}
/// superRefine: default 배열 값이 전부 선언된 옵션 값 집합 안인지.
fn all_declared(ds: &[Value], vals: &[&str]) -> bool {
    ds.iter()
        .all(|d| vals.contains(&d.as_str().unwrap_or_default()))
}
/// radio/checkbox superRefine — 스키마 clean 전제: 값 중복→options, default 불일치→default.
fn opt_refine(o: &Map<String, Value>, items: &[Value], radio: bool) -> Br {
    let name = if radio { "radio" } else { "checkbox" };
    let vals: Vec<&str> = items
        .iter()
        .filter_map(|e| e.get("value").and_then(Value::as_str))
        .collect();
    if vals.iter().copied().collect::<HashSet<_>>().len() != vals.len() {
        return Br::Dirty(
            "options".into(),
            format!("{name} option values must be non-empty and unique"),
        );
    }
    let msg = match (radio, o.get("default")) {
        (true, Some(d)) if !vals.contains(&d.as_str().unwrap_or_default()) => {
            Some("radio default must match a declared option value")
        }
        (false, Some(Value::Array(ds))) if ds.iter().collect::<HashSet<_>>().len() != ds.len() => {
            Some("checkbox default values must be unique")
        }
        (false, Some(Value::Array(ds))) if !all_declared(ds, &vals) => {
            Some("checkbox default must match declared option values")
        }
        _ => None,
    };
    msg.map_or(Br::Clean, |m| Br::Dirty("default".into(), m.into()))
}
/// radio/checkbox 공통 분기 — shape 순 병합 후 base clean 일 때만 superRefine.
fn opt_br(o: &Map<String, Value>, radio: bool) -> Br {
    let ty = if radio { "radio" } else { "checkbox" };
    let items = o.get("options").and_then(Value::as_array);
    let mut s = base_scan(o)
        .then(ab(o.get("type") != Some(&json!(ty))))
        .then(ab(items.is_none()));
    if let Some(items) = items {
        for (j, e) in items.iter().enumerate() {
            s = s.then(opt_item_scan(j, e));
        }
    }
    s = s
        .then(ab(match o.get("default") {
            None => false,
            Some(d) if radio => !d.is_string(),
            Some(d) => !d.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        }))
        .then(ab(o.contains_key("deriveFrom")))
        .then(root_extras(o));
    if let (Br::Clean, Some(items)) = (&s, items) {
        s = opt_refine(o, items, radio);
    }
    s
}
/// switch 분기 — type 리터럴·default bool·options/deriveFrom z.never.
fn switch_br(o: &Map<String, Value>) -> Br {
    base_scan(o)
        .then(ab(o.get("type") != Some(&json!("switch"))
            || !opt_bool(o, "default")
            || o.contains_key("options")
            || o.contains_key("deriveFrom")))
        .then(root_extras(o))
}
/// text 분기 — type 은 optional 리터럴, deriveFrom 중첩, options/default never.
fn text_br(o: &Map<String, Value>) -> Br {
    base_scan(o)
        .then(ab(o.get("type").is_some_and(|v| *v != json!("text"))))
        .then(df_scan(o.get("deriveFrom")))
        .then(ab(o.contains_key("options") || o.contains_key("default")))
        .then(root_extras(o))
}
/// 요소의 union 결과 — 첫 Clean 브랜치, 아니면 첫 Dirty 이슈, 전부 Abort 면 Abort.
fn element_outcome(v: &Value) -> Br {
    let Some(o) = v.as_object() else {
        return Br::Abort;
    };
    let mut dirty = None;
    for b in [text_br(o), opt_br(o, true), opt_br(o, false), switch_br(o)] {
        match b {
            Br::Clean => return Br::Clean,
            Br::Dirty(p, m) if dirty.is_none() => dirty = Some((p, m)),
            _ => {}
        }
    }
    dirty.map_or(Br::Abort, |(p, m)| Br::Dirty(p, m))
}

pub fn extract_youtube_id(raw: &[u8]) -> Result<Value, String> {
    let v: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let s = v
        .get("value")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("value.match is not a function")?;
    Ok(json!({ "videoId": youtube_id(&s) }))
}
pub fn validate_run_inputs(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let run = input.get("runInputs");
    if run.is_none_or(|v| !truthy(v)) {
        return Ok(json!({"ok": true}));
    }
    // `runInputs.length === 0` — 비배열 {length:0} 객체도 스키마 검사 전에 조기 통과.
    if run.and_then(|v| v.get("length")).and_then(Value::as_f64) == Some(0.0) {
        return Ok(json!({"ok": true}));
    }
    let Some(arr) = run.and_then(Value::as_array) else {
        let t = match run.unwrap() {
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            _ => "object",
        };
        return Err(format!("{PREFIX}: Expected array, received {t}"));
    };
    if arr.is_empty() {
        return Ok(json!({"ok": true}));
    }
    let mut issues: Vec<String> = vec![];
    let mut aborted = false;
    if arr.len() > 5 {
        issues.push("Array must contain at most 5 element(s)".into());
    }
    for (i, e) in arr.iter().enumerate() {
        match element_outcome(e) {
            Br::Clean => {}
            Br::Dirty(p, m) => {
                let path = if p.is_empty() {
                    i.to_string()
                } else {
                    format!("{i}.{p}")
                };
                issues.push(format!("{path}: {m}"));
            }
            Br::Abort => {
                aborted = true;
                issues.push(format!("{i}: Invalid input"));
            }
        }
    }
    if !aborted {
        let mut seen = HashSet::new();
        for (i, e) in arr.iter().enumerate() {
            if !seen.insert(e.get("key").and_then(Value::as_str).unwrap_or_default()) {
                issues.push(format!("{i}.key: run input keys must be unique"));
            }
        }
    }
    if let Some(first) = issues.into_iter().next() {
        return Err(format!("{PREFIX}: {first}"));
    }
    let keys: HashSet<&str> = arr
        .iter()
        .filter_map(|e| e.get("key").and_then(Value::as_str))
        .collect();
    for e in arr {
        let Some(d) = e.get("deriveFrom").and_then(Value::as_object) else {
            continue;
        };
        let src = d.get("input").and_then(Value::as_str).unwrap_or_default();
        if !keys.contains(src) {
            return Err(format!(
                "{PREFIX}: input \"{}\" deriveFrom references unknown input \"{src}\"",
                js_str(e.get("key"))
            ));
        }
    }
    Ok(json!({"ok": true}))
}
pub fn apply_run_input_derivations(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let mut derived = vec![];
    match input.get("runInputs") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            for e in a {
                if e.is_null() {
                    return Err("Cannot read properties of null (reading 'deriveFrom')".into());
                }
                if e.get("deriveFrom").is_some_and(truthy) {
                    derived.push(e);
                }
            }
        }
        Some(_) => return Err("runInputs?.filter is not a function".into()),
    }
    let metadata = input.get("metadata");
    if derived.is_empty() {
        return Ok(
            json!({"status": "ok", "metadata": metadata.filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({}))}),
        );
    }
    let mut meta = Map::new();
    match metadata {
        Some(Value::Object(o)) => meta = o.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .for_each(|(i, v)| drop(meta.insert(i.to_string(), v.clone()))),
        Some(Value::String(s)) => s
            .chars()
            .enumerate()
            .for_each(|(i, c)| drop(meta.insert(i.to_string(), json!(c.to_string())))),
        _ => {}
    }
    for input_v in derived {
        let d = input_v.get("deriveFrom").unwrap();
        let key = js_str(input_v.get("key"));
        if nonempty_str(meta.get(key.as_str())).is_some() {
            continue;
        }
        let extracted = match nonempty_str(meta.get(js_str(d.get("input")).as_str())) {
            Some(src) => match d.get("extract").and_then(Value::as_str) {
                Some("youtubeVideoId") => youtube_id(src),
                _ => {
                    return Err("RUN_INPUT_EXTRACTORS[deriveFrom.extract] is not a function".into())
                }
            },
            None => None,
        };
        if let Some(id) = extracted {
            meta.insert(key, json!(id));
            continue;
        }
        if input_v.get("required") != Some(&Value::Bool(false)) {
            let mut err = json!({"status": "error", "message": format!("{} could not be derived from {}; check the URL format", key, js_str(d.get("input")))});
            if let Some(k) = input_v.get("key") {
                err["key"] = k.clone();
            }
            return Ok(err);
        }
        meta.shift_remove(key.as_str());
    }
    Ok(json!({"status": "ok", "metadata": Value::Object(meta)}))
}

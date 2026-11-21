//! tool-fingerprint.ts + tool-result-hygiene.ts 순수 포트.
//! Duck-typing parity: falsy→[], truthy 비반복·비문자열 요소는 TS TypeError → Err(exit 1).
use crate::env_sens::is_sensitive_tool_env_key;
use crate::js::*;
use icu_collator::options::CollatorOptions;
use icu_collator::CollatorBorrowed;
use icu_locale_core::{locale, Locale};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::sync::OnceLock;

const DUPLICATE_EXCERPT_CHARS: usize = 140;

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Node localeCompare 기본 로케일: LC_ALL > LANG, C/POSIX·미설정 → en-US.
fn default_locale() -> Locale {
    ["LC_ALL", "LANG"].iter().filter_map(|k| env::var(k).ok())
        .filter_map(|v| v.trim().split(['.', '@']).next().map(str::to_string))
        .find(|t| !t.is_empty())
        .and_then(|t| match t.as_str() { "C" | "POSIX" => None, _ => t.replace('_', "-").parse().ok() })
        .unwrap_or(locale!("en-US"))
}

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLL: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLL.get_or_init(|| CollatorBorrowed::try_new(default_locale().into(), CollatorOptions::default())
        .or_else(|_| CollatorBorrowed::try_new(locale!("en-US").into(), CollatorOptions::default()))
        .expect("icu collator compiled data unavailable"))
}

/// `obj.k` — primitives·부재 키는 undefined.
fn prop<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object().and_then(|m| m.get(k))
}

/// `normalizeStringList`: falsy→[]; array→trim/filter/dedupe(첫 출현)/UTF-16 sort;
/// truthy 비배열·비문자열 요소 → TypeError.
fn normalize_string_list(v: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(v) = v else { return Ok(vec![]) };
    if !js_truthy(v) {
        return Ok(vec![]);
    }
    let Value::Array(a) = v else {
        return Err("values.map is not a function".into());
    };
    let (mut seen, mut out) = (HashSet::new(), Vec::new());
    for e in a {
        let t = js_trim(e.as_str().ok_or("v.trim is not a function")?);
        if !t.is_empty() && seen.insert(t) {
            out.push(t.to_string());
        }
    }
    out.sort_by(|a, b| utf16_cmp(a, b));
    Ok(out)
}

/// `[...x]` — 배열은 요소, 문자열은 char(코드포인트), 그 외 truthy → TypeError.
fn spread(v: &Value, what: &str) -> Result<Vec<Value>, String> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(format!("{what} is not iterable")),
    }
}

fn str_list(v: Vec<String>) -> Value {
    Value::Array(v.into_iter().map(Value::String).collect())
}

fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    m.insert(k.into(), v);
}

/// V8 BinaryInsertionSort 의미론 — 피벗(arr[i])이 항상 비교자의 첫 인자(수신자).
/// `a.name.localeCompare(b.name)`: 수신자 name은 String이어야 하고(아니면 TypeError),
/// 인자 name은 ToString 강제된다. arr[0]은 절대 수신자가 되지 않는다.
fn sort_mcp_entries(entries: &mut Vec<Value>) -> Result<(), String> {
    for i in 1..entries.len() {
        let pivot_name = match prop(&entries[i], "name") {
            Some(Value::String(s)) => s.clone(),
            _ => return Err("pivot.name.localeCompare is not a function".into()),
        };
        let (mut lo, mut hi) = (0, i);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let arg = js_to_string(prop(&entries[mid], "name"));
            if collator().compare(&pivot_name, &arg).is_lt() {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        let pivot = entries.remove(i);
        entries.insert(lo, pivot);
    }
    Ok(())
}

/// `canonicalizeMcpServers` — falsy→[]; truthy는 spread 후 name.localeCompare 정렬.
fn canonicalize_mcp_servers(v: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(v) = v else { return Ok(vec![]) };
    if !js_truthy(v) || matches!(v, Value::Array(a) if a.is_empty()) {
        return Ok(vec![]);
    }
    let mut entries = spread(v, "input.mcpServers")?;
    sort_mcp_entries(&mut entries)?;
    entries
        .iter()
        .map(|entry| {
            if entry.is_null() {
                return Err("Cannot read properties of null (reading 'name')".into());
            }
            let mut m = Map::new();
            if let Some(n) = prop(entry, "name") {
                m.insert("name".into(), n.clone());
            }
            put(&mut m, "command", prop(entry, "command").cloned().unwrap_or(Value::Null));
            let args: Vec<Value> = match prop(entry, "args") {
                Some(v) if js_truthy(v) => spread(v, "entry.args")?,
                _ => vec![],
            };
            put(&mut m, "args", Value::Array(args));
            put(&mut m, "url", prop(entry, "url").cloned().unwrap_or(Value::Null));
            put(&mut m, "disabledTools", str_list(normalize_string_list(prop(entry, "disabledTools"))?));
            Ok(Value::Object(m))
        })
        .collect()
}

/// `hashInstructionsText`: falsy→null; string→sha256; 그 외 truthy → update TypeError.
fn hash_instructions_text(v: Option<&Value>) -> Result<Value, String> {
    match v.filter(|v| js_truthy(v)) {
        Some(Value::String(s)) => Ok(Value::String(sha256_hex(s))),
        Some(_) => Err("The \"data\" argument must be of type string".into()),
        None => Ok(Value::Null),
    }
}

/// `hashEnvShape`: falsy→[]; Object.keys(env).sort() 후 [key, sha(v)[..16]].
/// Object.keys는 배열·문자열에 UTF-16 인덱스, number/bool엔 []를 준다.
/// 비문자열·비null 값 → createHash.update TypeError.
fn hash_env_shape(v: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(v) = v else { return Ok(vec![]) };
    if !js_truthy(v) {
        return Ok(vec![]);
    }
    let mut pairs: Vec<(String, Value)> = match v {
        Value::Object(m) => m.iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
        Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        Value::String(s) => s.encode_utf16().enumerate()
            .map(|(i, u)| (i.to_string(), Value::String(String::from_utf16_lossy(&[u]))))
            .collect(),
        _ => vec![],
    };
    pairs.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    pairs
        .into_iter()
        .map(|(k, val)| match &val {
            Value::Null => Ok(json!([k, &sha256_hex("")[..16]])),
            Value::String(s) => Ok(json!([k, &sha256_hex(s)[..16]])),
            _ => Err("The \"data\" argument must be of type string".into()),
        })
        .collect()
}

/// `computeAgentToolFingerprint` — payload 키는 리터럴 삽입 순서 유지,
/// adapterType만 undefined일 때 키 자체가 생략된다.
pub fn compute_agent_tool_fingerprint(input: &Value) -> Result<String, String> {
    if input.is_null() {
        return Err("Cannot read properties of null (reading 'adapterType')".into());
    }
    let mut p = Map::new();
    put(&mut p, "version", json!(1));
    if let Some(v) = prop(input, "adapterType") {
        put(&mut p, "adapterType", v.clone());
    }
    for k in ["model", "thinkingEffort", "cwd"] {
        put(&mut p, k, prop(input, k).cloned().unwrap_or(Value::Null));
    }
    put(&mut p, "instructionsFileName", match prop(input, "instructionsFileName") {
        Some(v) if !v.is_null() => v.clone(),
        _ => json!("AGENTS.md"),
    });
    put(&mut p, "instructionsSha256", hash_instructions_text(prop(input, "instructionsText"))?);
    put(&mut p, "mcpServers", Value::Array(canonicalize_mcp_servers(prop(input, "mcpServers"))?));
    put(&mut p, "allowedTools", str_list(normalize_string_list(prop(input, "allowedTools"))?));
    put(&mut p, "disabledTools", str_list(normalize_string_list(prop(input, "disabledTools"))?));
    put(&mut p, "envShape", Value::Array(hash_env_shape(prop(input, "envKeys"))?));
    Ok(sha256_hex(&js_json_stringify(&Value::Object(p))))
}

/// `hasToolSurfaceChanged` — falsy previous→changed:false; truthy 비문자열
/// previous는 !== → changed:true. currentInput undefined → TypeError.
fn has_tool_surface_changed(input: &Value) -> Result<Value, String> {
    if !input.is_object() {
        return Err("Cannot read properties of input (reading 'previousFingerprint')".into());
    }
    let Some(current) = input.get("currentInput") else {
        return Err("Cannot read properties of undefined (reading 'adapterType')".into());
    };
    let fp = compute_agent_tool_fingerprint(current)?;
    let prev = input.get("previousFingerprint");
    let changed = prev.is_some_and(js_truthy) && !matches!(prev, Some(Value::String(s)) if *s == fp);
    Ok(json!({ "changed": changed, "currentFingerprint": fp }))
}

/// `normalizeToolErrorSignature`: \d+→#, \s+→" ", trim, lowercase.
/// JS \d는 ASCII 전용; JS \s 집합 == trim 집합(White_Space−U+0085+U+FEFF).
pub fn normalize_tool_error_signature(text: &str) -> String {
    let mut buf = String::with_capacity(text.len());
    let (mut pd, mut ps) = (false, false);
    for c in text.chars() {
        let (d, s) = (c.is_ascii_digit(), is_js_space(c));
        if d && !pd {
            buf.push('#');
        } else if s && !ps {
            buf.push(' ');
        } else if !(d || s) {
            buf.push(c);
        }
        (pd, ps) = (d, s);
    }
    js_trim(&buf).to_lowercase()
}

/// `signatureKey` — `${tool}|${status ?? "x"}|${sha256(norm[..2000 utf16])[..16]}`.
/// 2000자 절단은 UTF-16 유닛 기준; 갈라진 쌍은 Node utf8 해시와
/// 동일하게 from_utf16_lossy가 U+FFFD로 바꾼다.
fn signature_key(tool: Option<&Value>, status: Option<&Value>, error: &str) -> String {
    let units: Vec<u16> = normalize_tool_error_signature(error).encode_utf16().collect();
    let kept = String::from_utf16_lossy(&units[..units.len().min(2000)]);
    let status_s = status.filter(|v| !v.is_null()).map_or_else(|| "x".into(), |v| js_to_string(Some(v)));
    format!("{}|{status_s}|{}", js_to_string(tool), &sha256_hex(&kept)[..16])
}

/// `condenseErrorText` — `error.length`는 문자열이면 UTF-16 길이, 배열이면
/// 요소 수, 그 외엔 undefined(→ 발췌 없이 원본). null/undefined는 TypeError.
fn condense_error_text(error: Option<&Value>, count: Option<&Value>) -> Result<String, String> {
    let excerpt: Value = match error {
        Some(Value::String(s)) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            if units.len() <= DUPLICATE_EXCERPT_CHARS { Value::String(s.clone()) } else {
                Value::String(format!("{} …", String::from_utf16_lossy(&units[..DUPLICATE_EXCERPT_CHARS])))
            }
        }
        Some(Value::Array(a)) if a.len() > DUPLICATE_EXCERPT_CHARS => {
            Value::Array(a[..DUPLICATE_EXCERPT_CHARS].to_vec())
        }
        Some(Value::Null) | None => {
            return Err("Cannot read properties of null/undefined (reading 'length')".into());
        }
        Some(v) => v.clone(),
    };
    Ok(format!(
        "{} [duplicate tool error ×{} in this run — identical to an earlier response; do not retry the same call unchanged]",
        js_to_string(Some(&excerpt)),
        js_to_string(count)
    ))
}

pub const SUBCOMMANDS: &[&str] = &[
    "compute-agent-tool-fingerprint", "has-tool-surface-changed",
    "normalize-tool-error-signature", "tool-error-signature-key",
    "condense-tool-error-text", "is-sensitive-tool-env-key",
];

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let get = |k: &str| input.get(k);
    match subcommand {
        "compute-agent-tool-fingerprint" => Ok(json!(compute_agent_tool_fingerprint(&input)?)),
        "has-tool-surface-changed" => has_tool_surface_changed(&input),
        "normalize-tool-error-signature" => Ok(json!(normalize_tool_error_signature(
            get("text")
                .and_then(Value::as_str)
                .ok_or("input.text.replace is not a function")?,
        ))),
        "tool-error-signature-key" => Ok(json!(signature_key(
            get("tool"),
            get("status"),
            get("error")
                .and_then(Value::as_str)
                .ok_or("input.error.replace is not a function")?,
        ))),
        "condense-tool-error-text" => Ok(json!(condense_error_text(get("error"), get("count"))?)),
        "is-sensitive-tool-env-key" => Ok(json!(is_sensitive_tool_env_key(get("key")))),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

//! paperclip-mission-core — stdin/stdout JSON subcommands mirroring the
//! server/src/services/missions/* TS modules. Err(_) results mirror TS
//! TypeError throws: they go to stderr with exit 1.
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

/// JS-semantics shims shared by the ported normalizer (plan_graph.rs does
/// `use crate::js::*`). Raw Value + permissive reads preserve duck-typing parity.
#[rustfmt::skip]
mod js {
    use serde_json::{Map, Value};
    use std::collections::HashSet;
    use std::hash::Hash;

    /// String#trim/trimEnd domain: Unicode White_Space minus U+0085 (NEL), plus U+FEFF.
    fn is_js_trim_char(c: char) -> bool { (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}' }
    pub fn js_trim(s: &str) -> &str { s.trim_matches(is_js_trim_char) }
    pub fn js_trim_end(s: &str) -> &str { s.trim_end_matches(is_js_trim_char) }

    /// `typeof v === "string" && v.trim() ? v.trim() : null`.
    pub fn read_string(v: &Value) -> Option<String> {
        let t = js_trim(v.as_str()?);
        if t.is_empty() { None } else { Some(t.to_string()) }
    }

    /// Non-array → []; otherwise keep entries that read as non-empty strings.
    pub fn read_string_array(v: &Value) -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(read_string).collect()).unwrap_or_default()
    }

    /// `Array.isArray(v) && !v.some(e => readString(e) === null)` (empty passes).
    pub fn valid_string_array(v: &Value) -> bool {
        v.as_array()
            .is_some_and(|a| a.iter().all(|e| read_string(e).is_some()))
    }

    /// `Object.prototype.hasOwnProperty.call(v, key)` — only objects own named keys.
    pub fn has_own(v: &Value, key: &str) -> bool {
        v.as_object().is_some_and(|m| m.contains_key(key))
    }

    /// `readString(v)?.toLowerCase()`.
    pub fn lower(v: &Value) -> Option<String> {
        read_string(v).map(|s| s.to_lowercase())
    }

    /// `Array.from(new Set(v))` — first-occurrence order preserved.
    pub fn unique<T: Eq + Hash + Clone>(v: Vec<T>) -> Vec<T> {
        let mut seen = HashSet::new();
        v.into_iter().filter(|x| seen.insert(x.clone())).collect()
    }

    /// JS truthiness (serde_json::Number is finite, so `!= 0` covers -0/NaN).
    pub fn js_truthy(v: &Value) -> bool {
        match v {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64() != Some(0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }

    /// `{...v}`: objects copy own props, arrays/strings index-spread, primitives → {}.
    pub fn js_spread(v: &Value) -> Map<String, Value> {
        match v {
            Value::Object(o) => o.clone(),
            Value::Array(a) => a
                .iter()
                .enumerate()
                .map(|(i, e)| (i.to_string(), e.clone()))
                .collect(),
            Value::String(s) => s
                .chars()
                .enumerate()
                .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
                .collect(),
            _ => Map::new(),
        }
    }

    /// ECMA `Number::toString` for finite f64 (shortest round-trip digits via `{:e}`).
    pub fn js_num_str(f: f64) -> String {
        if f == 0.0 {
            return "0".into(); // covers -0
        }
        let neg = f.is_sign_negative();
        let a = f.abs();
        let body = if a.fract() == 0.0 && a < 1e21 {
            format!("{a:.0}")
        } else {
            let e = format!("{a:e}");
            let (mant, exp) = e.split_once('e').unwrap_or((e.as_str(), "0"));
            let digits: String = mant.chars().filter(|c| *c != '.').collect();
            let n = exp.parse::<i32>().unwrap_or(0) + 1;
            let k = digits.len() as i32;
            if (k..=21).contains(&n) {
                format!("{digits}{}", "0".repeat((n - k).max(0) as usize))
            } else if (1..=21).contains(&n) {
                format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
            } else if n > -6 && n <= 0 {
                format!("0.{}{digits}", "0".repeat((-n).max(0) as usize))
            } else if k == 1 {
                format!("{digits}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
            } else {
                let (h, t) = (&digits[..1], &digits[1..]);
                format!("{h}.{t}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
            }
        };
        if neg {
            format!("-{body}")
        } else {
            body
        }
    }

    /// JS `ToString`; `None` models `undefined` (array elements render nullish as "").
    pub fn js_to_string(v: Option<&Value>) -> String {
        match v {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => js_num_str(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a
                .iter()
                .map(|e| {
                    if e.is_null() {
                        String::new()
                    } else {
                        js_to_string(Some(e))
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".into(),
        }
    }

    /// `JSON.stringify(v)` for JSON-representable input (integer-index keys sort
    /// numerically first, non-finite numbers become null).
    pub fn js_json_stringify(v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n
                .as_f64()
                .filter(|f| f.is_finite())
                .map_or_else(|| "null".into(), js_num_str),
            Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
            Value::Array(a) => {
                format!("[{}]", a.iter().map(js_json_stringify).collect::<Vec<_>>().join(","))
            }
            Value::Object(m) => {
                let mut e: Vec<(&String, &Value)> = m.iter().collect();
                e.sort_by_key(|(k, _)| array_index_key(k).map(|i| (0, i)).unwrap_or((1, 0)));
                let parts = e.iter().map(|(k, v)| {
                    format!("{}:{}", js_json_stringify(&Value::String((*k).clone())), js_json_stringify(v))
                });
                format!("{{{}}}", parts.collect::<Vec<_>>().join(","))
            }
        }
    }

    /// JS "integer index" key: canonical u32 decimal below 2^32 - 1.
    fn array_index_key(k: &str) -> Option<u64> {
        k.parse::<u64>()
            .ok()
            .filter(|n| *n < 4_294_967_295 && n.to_string() == k)
    }
}

mod agent_role_boundaries;
// Deliberately hand-compacted to honor the file line caps.
#[rustfmt::skip]
mod artifact_contract;
#[rustfmt::skip]
mod delivery_verification;
#[rustfmt::skip] // hand-compacted to honor the 300-line file limit
mod mission_owner_decision_text;
#[rustfmt::skip] // hand-compacted to honor the 300-line file limit
mod operator_card_summary;
// Deliberately hand-compacted to honor the 300-line file limit.
#[rustfmt::skip]
mod plan_graph;
mod quality_contract;
mod quality_contract_lines;
mod revision_delta;
mod revision_plan_declaration_targets;
mod revision_reuse;
mod revision_reuse_steps;
// Deliberately hand-compacted to honor the 300-line file limit.
#[rustfmt::skip]
mod structural_materialization;
// Deliberately hand-compacted to honor the 300-line file limit.
#[rustfmt::skip]
mod structural_topology;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn input_array<'a>(input: &'a Value, key: &str) -> Result<&'a [Value], String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{key} must be an array"))
}

fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    match subcommand {
        "normalize-dependency-graph" => {
            let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let units = input_array(&input, "units")?;
            // TS `draftSteps = []` defaults only on undefined; explicit null throws.
            let draft_steps: &[Value] = match input.get("draftSteps") {
                None => &[],
                Some(_) => input_array(&input, "draftSteps")?,
            };
            plan_graph::normalize_mission_plan_dependency_graph(units, draft_steps)
        }
        "is-unit-materialized" => {
            let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let unit = input.get("unit").cloned().unwrap_or(Value::Null);
            Ok(json!(plan_graph::is_mission_plan_unit_materialized(&unit)?))
        }
        "remap-to-step-ids" => {
            let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let units = input_array(&input, "units")?;
            let step_ids = input_array(&input, "stepIds")?;
            Ok(json!(plan_graph::remap_canonical_dependencies_to_step_ids(
                units, step_ids
            )?))
        }
        s if agent_role_boundaries::SUBCOMMANDS.contains(&s) => {
            agent_role_boundaries::dispatch(s, raw)
        }
        s if revision_reuse::SUBCOMMANDS.contains(&s) => revision_reuse::dispatch(s, raw),
        s if revision_plan_declaration_targets::SUBCOMMANDS.contains(&s) => {
            revision_plan_declaration_targets::dispatch(s, raw)
        }
        s if structural_materialization::SUBCOMMANDS.contains(&s) => {
            structural_materialization::dispatch(s, raw)
        }
        s if structural_topology::SUBCOMMANDS.contains(&s) => structural_topology::dispatch(s, raw),
        s if delivery_verification::SUBCOMMANDS.contains(&s) => {
            delivery_verification::dispatch(s, raw)
        }
        _ => quality_contract::dispatch(subcommand, raw),
    }
}

#[rustfmt::skip] // hand-compacted to honor the 300-line file limit
fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        let subs = [agent_role_boundaries::SUBCOMMANDS, delivery_verification::SUBCOMMANDS, operator_card_summary::SUBCOMMANDS, quality_contract::SUBCOMMANDS, revision_plan_declaration_targets::SUBCOMMANDS, revision_reuse::SUBCOMMANDS, structural_materialization::SUBCOMMANDS, structural_topology::SUBCOMMANDS].concat();
        return Err(format!("usage: paperclip-mission-core <{}>", subs.join("|")));
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    // Lone-surrogate output needs raw print (see module doc).
    if operator_card_summary::SUBCOMMANDS.contains(&subcommand) {
        println!("{}", operator_card_summary::dispatch(subcommand, &raw)?);
        return Ok(());
    }
    let out = dispatch(subcommand, &raw)?;
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

#[cfg(test)]
#[rustfmt::skip] // one-line JSON fixtures keep the parity tables diffable
mod tests;

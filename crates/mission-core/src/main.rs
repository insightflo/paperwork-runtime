//! paperclip-mission-core — stdin/stdout JSON subcommands mirroring the
//! server/src/services/missions/* TS modules. Err(_) results mirror TS
//! TypeError throws: they go to stderr with exit 1.
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

/// JS-semantics shims shared by the ported normalizer (plan_graph.rs does
/// `use crate::js::*`). Raw Value + permissive reads preserve duck-typing parity.
mod js {
    use serde_json::{Map, Value};
    use std::collections::HashSet;
    use std::hash::Hash;

    /// String#trim domain: Unicode White_Space + U+FEFF (Rust `trim` omits the BOM).
    pub fn js_trim(s: &str) -> &str {
        s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
    }

    /// `typeof v === "string" && v.trim() ? v.trim() : null`.
    pub fn read_string(v: &Value) -> Option<String> {
        let t = js_trim(v.as_str()?);
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }

    /// Non-array → []; otherwise keep entries that read as non-empty strings.
    pub fn read_string_array(v: &Value) -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().filter_map(read_string).collect())
            .unwrap_or_default()
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
}

mod agent_role_boundaries;
// Deliberately hand-compacted to honor the 300-line file limit.
#[rustfmt::skip]
mod plan_graph;
mod quality_contract;
mod quality_contract_lines;
mod revision_delta;
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
        s if structural_materialization::SUBCOMMANDS.contains(&s) => {
            structural_materialization::dispatch(s, raw)
        }
        s if structural_topology::SUBCOMMANDS.contains(&s) => structural_topology::dispatch(s, raw),
        _ => quality_contract::dispatch(subcommand, raw),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        let subs = [
            agent_role_boundaries::SUBCOMMANDS,
            quality_contract::SUBCOMMANDS,
            revision_reuse::SUBCOMMANDS,
            structural_materialization::SUBCOMMANDS,
            structural_topology::SUBCOMMANDS,
        ]
        .concat();
        return Err(format!(
            "usage: paperclip-mission-core <{}>",
            subs.join("|")
        ));
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let out = dispatch(subcommand, &raw)?;
    println!(
        "{}",
        serde_json::to_string(&out).map_err(|e| e.to_string())?
    );
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

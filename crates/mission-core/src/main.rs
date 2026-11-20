//! paperclip-mission-core — stdin/stdout JSON subcommands mirroring
//! server/src/services/missions/mission-plan-dependency-graph.ts and
//! mission-quality-contract.ts.
//! Err(_) results mirror TS TypeError throws: they go to stderr with exit 1.
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

// Deliberately hand-compacted to honor the 300-line file limit.
#[rustfmt::skip]
mod plan_graph;
mod quality_contract;
mod quality_contract_lines;

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
        _ => quality_contract::dispatch(subcommand, raw),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(format!(
            "usage: paperclip-mission-core <{}>",
            quality_contract::SUBCOMMANDS.join("|")
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
mod tests {
    use super::*;
    use serde_json::Map;

    fn run(sub: &str, payload: &str) -> Result<Value, String> {
        dispatch(sub, payload.as_bytes())
    }
    fn ok(sub: &str, payload: &str) -> Value {
        run(sub, payload).unwrap()
    }
    fn codes(out: &Value) -> Vec<&str> {
        out["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|d| d["code"].as_str())
            .collect()
    }

    #[test]
    fn js_shim_semantics() {
        assert_eq!(js::read_string(&json!("  a\u{feff} ")), Some("a".to_string()));
        assert_eq!(js::read_string(&json!(" \u{00a0} ")), None);
        assert_eq!(js::read_string(&json!(7)), None);
        assert!(js::valid_string_array(&json!([])));
        assert!(!js::valid_string_array(&json!(["a", 1])));
        assert_eq!(js::unique(vec!["x", "y", "x"]), vec!["x", "y"]);
        assert!(!js::js_truthy(&json!("")) && !js::js_truthy(&json!(0)) && js::js_truthy(&json!([])));
        assert_eq!(js::js_spread(&json!(["a", "b"]))["0"], json!("a"));
        assert_eq!(js::js_spread(&json!(null)), Map::new());
    }

    #[test]
    fn normalize_merges_alias_forms_draft_targets_and_passthrough() {
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"a","unitId":"legacy-a","sourceRef":{"id":"src-a"}},
            {"id":"b","dependsOn":["legacy-a"]},
            {"id":"c","after":["b"],"dependencies":["a","a"]},
            {"id":"d"},
            {"id":"e","kind":"oversight","dependencies":["d"]}],
            "draftSteps":[
                {"unitId":"d","dependencies":["c"]},
                {"units":[],"unitId":"b","dependsOn":["a"]},
                {"units":["e"],"dependsOn":["c"]},
                "plain step", {"id":"note","title":"x"}, 7, ["x","y"]]}"#);
        assert_eq!(out["ok"], json!(true));
        let g = &out["graph"];
        assert_eq!(g["dependencyIndex"], json!([[], [0], [0, 1], [2], [3, 2]]));
        assert_eq!(g["units"][1]["dependencies"], json!(["a"]));
        assert_eq!(g["units"][1]["dependsOn"], Value::Null);
        assert_eq!(g["units"][2]["after"], Value::Null);
        assert_eq!(g["materializedDependencyIndex"], json!([[], [0], [0, 1], [2]]));
        assert_eq!(g["draftSteps"][0], json!({"unitId": "d", "dependencies": ["c"]}));
        assert_eq!(g["draftSteps"][1], json!({"units": [], "unitId": "b", "dependencies": ["a"]}));
        assert_eq!(g["draftSteps"][2]["units"], json!(["e"]));
        assert_eq!(g["draftSteps"][3], json!("plain step"));
        assert_eq!(g["draftSteps"][4], json!({"id": "note", "title": "x"}));
        assert_eq!(g["draftSteps"][5], json!({}));
        assert_eq!(g["draftSteps"][6], json!({"0": "x", "1": "y"}));
    }

    #[test]
    fn normalize_diagnostics_cover_policy_shapes_refs_and_cycles() {
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"deliveryVerification":{},"dependsOn":[]},{"id":"dup"},{"id":"dup"},{}],
            "draftSteps":[{"capAcceptance":null}]}"#);
        assert_eq!(codes(&out), [
            "board_only_plan_policy", "board_only_plan_policy",
            "missing_unit_id", "missing_unit_id", "duplicate_unit_id"]);
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"a","dependencies":"x"},{"id":"b","dependsOn":[1,"c"]},{"id":"c","after":null}],
            "draftSteps":[{"units":"nope","dependsOn":["a"]},{"unitId":5,"after":["a"]}]}"#);
        assert_eq!(codes(&out), [
            "invalid_dependency_shape", "invalid_dependency_shape", "invalid_dependency_shape",
            "invalid_dependency_shape", "unresolved_dependency_target_ref",
            "invalid_dependency_shape", "unresolved_dependency_target_ref"]);
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"a","sourceRef":{"id":"s"}},{"id":"b","sourceRef":{"id":"s"}},
            {"id":"c","dependencies":["s","ghost","a"]}]}"#);
        assert_eq!(codes(&out), ["ambiguous_dependency_ref", "unresolved_dependency_ref"]);
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"a","dependencies":["c"]},{"id":"b","dependencies":["a"]},
            {"id":"c","dependencies":["b"]},{"id":"d","dependencies":["d"]}]}"#);
        assert_eq!(codes(&out), ["self_dependency", "dependency_cycle"]);
        assert_eq!(out["diagnostics"][1]["message"], json!("Plan dependency cycle detected: a -> c -> b -> a."));
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"a","dependencies":["o"]},{"id":"o","kind":"oversight"}]}"#);
        assert_eq!(codes(&out), ["materialized_dependency_on_filtered_unit"]);
        let out = ok("normalize-dependency-graph", r#"{"units":[
            {"id":"w"},{"id":"o","kind":"oversight","dependencies":["w"]}]}"#);
        assert_eq!(out["ok"], json!(true));
    }

    #[test]
    fn materialized_and_remap_dispatch() {
        let mat = |extra: &str| ok("is-unit-materialized", &format!("{{\"unit\":{{\"id\":\"u\"{extra}}}}}"));
        assert_eq!(mat(""), json!(true));
        assert_eq!(mat(r#","type":"oversight","triggerOn":"escalation""#), json!(false));
        assert_eq!(mat(r#","type":"oversight""#), json!(true));
        assert_eq!(mat(r#","kind":"  Oversight ""#), json!(false));
        assert_eq!(mat(r#","type":"tool","qaType":"structural","kind":"oversight","triggerOn":"escalation""#), json!(true));
        assert_eq!(mat(r#","sourceRef":{"type":"cross_company_mission_request"}"#), json!(false));
        assert!(run("is-unit-materialized", r#"{"unit":null}"#).is_err());
        let out = ok("remap-to-step-ids", r#"{"units":[{"id":"a"},{"id":"b","dependencies":["a"]},{"id":"c","dependencies":["b"]}],"stepIds":["s1","s2","s3"]}"#);
        assert_eq!(out, json!([[], ["s1"], ["s2"]]));
        assert!(run("remap-to-step-ids", r#"{"units":[{"id":"a"}],"stepIds":[]}"#).unwrap_err().contains("equal length"));
        assert!(run("remap-to-step-ids", r#"{"units":[{"id":"a","dependencies":["ghost"]}],"stepIds":["s1"]}"#).unwrap_err().contains("ghost"));
    }

    #[test]
    fn dispatcher_fails_closed() {
        assert!(run("nope", "{}").is_err());
        assert!(run("normalize-dependency-graph", "not json").is_err());
        assert!(run("normalize-dependency-graph", r#"{"draftSteps":[]}"#).is_err());
        assert!(run("normalize-dependency-graph", r#"{"units":[],"draftSteps":null}"#).is_err());
        assert!(run("normalize-dependency-graph", r#"{"units":[null]}"#)
            .unwrap_err().contains("Cannot convert undefined or null to object"));
        let out = ok("normalize-dependency-graph", r#"{"units":[]}"#);
        assert_eq!(out["ok"], json!(true));
    }
}

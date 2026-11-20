//! Pure port of server/src/services/missions/structural-materialization.ts —
//! classification, fail-closed unit validation, `{$steps.*}` toolArgs rewriting
//! and structural-validator toolArgs enforcement (the file's re-exported
//! topology/plan-validation helpers live in crate::structural_topology).
//! Err(_) mirrors TS throws → stderr + exit 1. Hand-compacted (rustfmt-skip).
use crate::js::*;
use crate::revision_delta as d;
use serde_json::{json, Map, Value};

pub const SUBCOMMANDS: &[&str] = &[
    "is-structural-gate-step", "is-declared-structural-unit",
    "is-partial-structural-declaration", "validate-structural-unit",
    "rewrite-tool-args-step-references", "fill-structural-validator-tool-args",
    "rewrite-step-tool-args",
];
pub(crate) const DELEGATE: &str = "delegate_to_company";
const STEP_FIELDS: [&str; 3] = ["workProductPath", "workProductDir", "siblingAssetsDir"];
const PREFIX: &str = "{$steps.";

/// Map wire form — non-objects keep their JS receiver-error text.
enum MapArg<'a> { Obj(&'a Map<String, Value>), Bad(&'static str) }
fn map_arg(input: &Value) -> MapArg<'_> {
    match input.get("map") {
        Some(Value::Object(o)) => MapArg::Obj(o),
        Some(Value::Null) => MapArg::Bad("Cannot read properties of null"),
        Some(_) => MapArg::Bad("unitIdToStepId"),
        None => MapArg::Bad("Cannot read properties of undefined"),
    }
}
fn map_get<'a>(m: &'a MapArg<'a>, k: &str) -> Result<Option<&'a Value>, String> {
    match m {
        MapArg::Obj(o) => Ok(o.get(k)),
        MapArg::Bad("unitIdToStepId") => Err("unitIdToStepId.get is not a function".into()),
        MapArg::Bad(e) => Err(format!("{e} (reading 'get')")),
    }
}
fn map_size(m: &MapArg) -> Result<usize, String> {
    match m {
        MapArg::Obj(o) => Ok(o.len()),
        MapArg::Bad("unitIdToStepId") => Ok(usize::MAX), // `.size` → undefined !== 0
        MapArg::Bad(e) => Err(format!("{e} (reading 'size')")),
    }
}
/// readUnitToolNames — toolNames/tools keep raw strings; toolName via readString.
pub(crate) fn unit_tool_names(u: &Value) -> Vec<String> {
    let keep = |v: &Value| v.as_str().filter(|s| !js_trim(s).is_empty()).map(str::to_string);
    let mut out: Vec<String> = ["toolNames", "tools"].iter()
        .flat_map(|k| u[k].as_array().into_iter().flatten().filter_map(keep)).collect();
    out.extend(read_string(&u["toolName"]));
    unique(out)
}
pub(crate) fn is_declared(u: &Value) -> bool {
    lower(&u["type"]).as_deref() == Some("tool") && lower(&u["qaType"]).as_deref() == Some("structural")
}
fn is_partial(u: &Value) -> bool {
    lower(&u["qaType"]).as_deref() == Some("structural") && lower(&u["type"]).as_deref() != Some("tool")
}
/// structural-gate.ts isStructuralGateStep — falsy `step` exits before reads.
pub(crate) fn is_gate(s: &Value) -> bool {
    js_truthy(s) && lower(&s["type"]).as_deref() == Some("tool")
        && lower(&s["qaType"]).as_deref() == Some("structural")
        && s["agentId"].as_str().is_none_or(|a| js_trim(a).is_empty())
        && s["toolNames"].as_array().is_some_and(|a| a.iter().filter(|t| t.as_str().is_some_and(|x| !js_trim(x).is_empty())).count() == 1)
}
fn invalid(kind: &str, u: &Value, title: &str, index: Option<&Value>, tail: String) -> String {
    let id = read_string(&u["id"]).unwrap_or_else(|| d::js_str_opt(index));
    format!("Invalid structural {kind} \"{title}\" (id={id}): {tail}")
}
fn validate_unit(u: &Value, title: &str, index: Option<&Value>) -> Result<(), String> {
    if is_partial(u) {
        return Err(invalid("unit", u, title, index, "qaType:\"structural\" requires type:\"tool\". Remove qaType or set type:\"tool\".".into()));
    }
    if !is_declared(u) {
        return Ok(());
    }
    let names = unit_tool_names(u);
    if names.iter().any(|n| n == DELEGATE) {
        return Err(invalid("tool unit", u, title, index, "delegate_to_company cannot serve as a structural validator.".into()));
    }
    if names.len() != 1 {
        return Err(invalid("tool unit", u, title, index, format!("declared type:\"tool\" + qaType:\"structural\" requires exactly one toolName, got {}. Fix the plan or remove the structural declaration.", names.len())));
    }
    Ok(())
}
/// JS ToNumber of a `.length` read — the `i < length` iteration bound.
fn js_len(v: &Value) -> usize {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or_default(),
        Value::String(s) => js_trim(s).parse().unwrap_or_default(),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Array(a) => match a.as_slice() {
            [] | [Value::Null] => 0.0,
            [x] => d::js_str(x).parse().unwrap_or_default(),
            _ => f64::NAN },
        _ => 0.0, // null/object → 0/NaN → no iterations
    };
    if n.is_nan() { 0 } else { n.max(0.0) as usize }
}
/// `steps[i]` domain for `for i < steps.length` loops: array items and object
/// `.length` + indexed keys (strings/primitives iterate but never match).
fn seq_items(v: &Value) -> Result<Vec<Option<&Value>>, String> {
    Ok(match v {
        Value::Array(a) => a.iter().map(Some).collect(),
        Value::Null => return Err("Cannot read properties of null (reading 'length')".into()),
        Value::Object(o) => (0..js_len(&o["length"])).map(|i| o.get(&i.to_string())).collect(),
        _ => Vec::new(),
    })
}
/// fillStructuralValidatorToolArgs — toolArgs must be a non-empty object/array.
fn fill_tool_args(v: Option<&Value>) -> Result<(), String> {
    let items = match v {
        None => return Err("Cannot read properties of undefined (reading 'length')".into()),
        Some(v) => seq_items(v)?,
    };
    for s in items {
        let Some(s) = s else {
            return Err("Cannot read properties of undefined (reading 'type')".into());
        };
        if s.is_null() {
            return Err("Cannot read properties of null (reading 'type')".into());
        }
        if s["type"].as_str() != Some("tool") || s["qaType"].as_str() != Some("structural") {
            continue;
        }
        let ok = s.get("toolArgs").is_some_and(|t| js_truthy(t)
            && (t.as_object().is_some_and(|o| !o.is_empty()) || t.as_array().is_some_and(|a| !a.is_empty())));
        if ok {
            continue;
        }
        let name = s.get("name").filter(|v| !v.is_null()).or_else(|| s.get("id"));
        return Err(format!("Invalid structural unit \"{}\" (stepId={}): structural tool steps require toolArgs matching the selected tool's input schema. Declare toolArgs on the plan unit.", d::js_str_opt(name), d::js_str_opt(s.get("id"))));
    }
    Ok(())
}
/// STEP_REF_TOKEN — `{$steps.<refId>.<field>}`: greedy `[^}]+` refId (split at
/// the LAST `.`) plus a fixed literal field.
fn rewrite_str(s: &str, m: &MapArg) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(start) = s[i..].find(PREFIX).map(|r| i + r) {
        let body = start + PREFIX.len();
        let Some(end) = s[body..].find('}').map(|r| body + r) else { break };
        let hit = s[body..end].rfind('.').and_then(|p| {
            let (id, field) = (&s[body..body + p], &s[body + p + 1..end]);
            (!id.is_empty() && STEP_FIELDS.contains(&field)).then_some((id, field))
        });
        match hit {
            None => { out.push_str(&s[i..body]); i = body; } // emit failed prefix, rescan inside
            Some((id, field)) => {
                out.push_str(&s[i..start]);
                match map_get(m, id)? {
                    Some(v) if js_truthy(v) => out.push_str(&format!("{PREFIX}{}.{field}}}", d::js_str(v))),
                    _ => out.push_str(&s[start..=end]),
                }
                i = end + 1;
            }
        }
    }
    out.push_str(&s[i..]);
    Ok(out)
}
fn rewrite_value(v: &Value, m: &MapArg) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) => Value::String(rewrite_str(s, m)?),
        Value::Array(a) => Value::Array(a.iter().map(|e| rewrite_value(e, m)).collect::<Result<_, _>>()?),
        Value::Object(o) => Value::Object(o.iter().map(|(k, e)| rewrite_value(e, m).map(|r| (k.clone(), r))).collect::<Result<Map<String, Value>, String>>()?),
        _ => v.clone(),
    })
}
/// rewriteStepToolArgs — mutates plannedSteps[i] like the TS indexed loop.
fn rewrite_steps(steps: Option<&Value>, m: &MapArg) -> Result<Value, String> {
    if map_size(m)? == 0 {
        return Ok(steps.cloned().unwrap_or(Value::Null));
    }
    let mut v = match steps {
        None => return Err("Cannot read properties of undefined (reading 'length')".into()),
        Some(v) => v.clone(),
    };
    match &mut v {
        Value::Array(a) => {
            for s in a.iter_mut() {
                if s.is_null() {
                    return Err("Cannot read properties of null (reading 'toolArgs')".into());
                }
                if let Some(t) = s.get("toolArgs").cloned() {
                    let mut o = js_spread(s);
                    o.insert("toolArgs".into(), rewrite_value(&t, m)?);
                    *s = Value::Object(o);
                }
            }
        }
        Value::Object(o) => {
            for i in 0..js_len(&o["length"]) {
                let e = match o.get(&i.to_string()).cloned() {
                    None => return Err("Cannot read properties of undefined (reading 'toolArgs')".into()),
                    Some(Value::Null) => return Err("Cannot read properties of null (reading 'toolArgs')".into()),
                    Some(e) => e,
                };
                if let Some(t) = e.get("toolArgs") {
                    let mut sp = js_spread(&e);
                    sp.insert("toolArgs".into(), rewrite_value(t, m)?);
                    o.insert(i.to_string(), Value::Object(sp));
                }
            }
        }
        Value::Null => return Err("Cannot read properties of null (reading 'length')".into()),
        _ => {} // primitives/strings: elements have no toolArgs → unchanged
    }
    Ok(v)
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let unit = |prop: &str| -> Result<&Value, String> {
        match input.get("unit") {
            Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{prop}')")),
            None => Err(format!("Cannot read properties of undefined (reading '{prop}')")),
            Some(v) => Ok(v),
        }
    };
    match subcommand {
        "is-structural-gate-step" => Ok(json!(is_gate(&input["step"]))),
        "is-declared-structural-unit" => Ok(json!(is_declared(unit("type")?))),
        "is-partial-structural-declaration" => Ok(json!(is_partial(unit("qaType")?))),
        "validate-structural-unit" => {
            validate_unit(unit("qaType")?, &d::js_str_opt(input.get("title")), input.get("index"))?;
            Ok(Value::Null)
        }
        "rewrite-tool-args-step-references" => rewrite_value(&input["toolArgs"], &map_arg(&input)),
        "fill-structural-validator-tool-args" => { fill_tool_args(input.get("steps"))?; Ok(Value::Null) }
        "rewrite-step-tool-args" => rewrite_steps(input.get("steps"), &map_arg(&input)),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

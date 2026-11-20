//! [파일 목적] definition-step-validation.ts + artifact-config-validation.ts 의
//!   validateWorkflowQaConfigs 부분 포트(Stage 8C) — validate-definition-steps /
//!   definition-step-warnings / summarize-step-warnings 서브커맨드.
//! [parity] `${v}`=js_str. `ref in selectors` 는 JS `in` — own 키 + Object.prototype
//!   +배열이면 canonical index/length/Array.prototype. policySchema/qaConfigSchema 는
//!   고정 메시지 "Invalid workflow policy" 만 필요해 pass/fail 술어로 포팅한다
//!   (zod strict=알려진 키만 허용, optional 필드는 부재만 통과 — null 도 거부).
//! [외부 연결] consumer: dispatch.rs. artifact_refs::{collect_artifact_references,
//!   find_tool_reference_errors}·js_value::js_str·crate root 공용 술어(truthy/strict/
//!   js_in+prototype 표) 재사용.

use crate::artifact_refs::{collect_artifact_references, find_tool_reference_errors};
use crate::js_value::js_str;
use crate::{ab, extras_at, js_in, strict, truthy, Br, TOO_SMALL};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

// ── policySchema + qaConfigSchema (validateWorkflowQaConfigs) ────────────
fn js_pointer(s: &str) -> bool {
    if s.encode_utf16().count() > 500 || (!s.is_empty() && !s.starts_with('/')) {
        return false;
    }
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '~' && !matches!(it.next(), Some('0') | Some('1')) || (c as u32) <= 0x1f {
            return false;
        }
    }
    true
}
fn int_ok(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64)
        .is_some_and(|f| f.is_finite() && f.fract() == 0.0 && (0.0..=10_000.0).contains(&f))
}
fn ptrs(v: Option<&Value>, required: bool) -> bool {
    match v {
        None => !required,
        Some(Value::Array(a)) => {
            (1..=100).contains(&a.len()) && a.iter().all(|e| e.as_str().is_some_and(js_pointer))
        }
        _ => false,
    }
}
fn params_ok(
    v: Option<&Value>,
    keys: &[&str],
    inner: impl Fn(&Map<String, Value>) -> bool,
) -> bool {
    v.is_none_or(|p| p.as_object().is_some_and(|o| strict(o, keys) && inner(o)))
}
fn qa_ok(v: &Value) -> bool {
    const IDS: &[&str] = &[
        "provenance",
        "result-format",
        "no-sensitive-data",
        "no-external-script",
        "no-external-iframe",
        "https-links",
        "min-source-links",
        "links-reachable",
        "uploaded-asset-required",
        "tag-count",
        "required-fields",
        "no-template-remnants",
        "asset-existence",
    ];
    let rules = v
        .as_object()
        .filter(|o| strict(o, &["rules"]))
        .and_then(|o| o.get("rules"))
        .and_then(Value::as_object);
    let Some(rules) = rules else { return false };
    strict(rules, IDS) && rules.iter().all(|(id, r)| rule_ok(id, r))
}
fn rule_ok(id: &str, r: &Value) -> bool {
    let Some(o) = r.as_object().filter(|o| strict(o, &["enabled", "params"])) else {
        return false;
    };
    let mandatory = matches!(
        id,
        "provenance"
            | "result-format"
            | "no-sensitive-data"
            | "no-external-script"
            | "no-external-iframe"
            | "https-links"
    );
    let en = o.get("enabled");
    if if mandatory {
        en.is_some_and(|e| *e != Value::Bool(true))
    } else {
        en.is_some_and(|e| !e.is_boolean())
    } {
        return false;
    }
    match id {
        "min-source-links" => params_ok(o.get("params"), &["min", "pointers"], |p| {
            int_ok(p.get("min")) && ptrs(p.get("pointers"), false)
        }),
        "tag-count" => params_ok(o.get("params"), &["pointer", "min", "max"], |p| {
            int_ok(p.get("min"))
                && p.get("max").is_none_or(|m| int_ok(Some(m)))
                && p.get("pointer")
                    .is_none_or(|x| x.as_str().is_some_and(js_pointer))
                && p.get("max")
                    .is_none_or(|m| m.as_f64() >= p.get("min").and_then(Value::as_f64))
        }),
        "required-fields" => params_ok(o.get("params"), &["pointers"], |p| {
            ptrs(p.get("pointers"), true)
        }),
        "no-template-remnants" => params_ok(o.get("params"), &["patterns"], |p| {
            p.get("patterns")
                .and_then(Value::as_array)
                .is_some_and(|a| {
                    (1..=100).contains(&a.len())
                        && a.iter().all(|s| {
                            s.as_str()
                                .is_some_and(|t| (1..=500).contains(&t.encode_utf16().count()))
                        })
                })
        }),
        "asset-existence" => params_ok(o.get("params"), &["pointers"], |p| {
            ptrs(p.get("pointers"), false)
        }),
        _ if mandatory || matches!(id, "links-reachable" | "uploaded-asset-required") => {
            params_ok(o.get("params"), &[], |_| true)
        }
        _ => false,
    }
}

// ── runInputs 스키마 유효성 술어 — run_input_derivations 의 소비자인데 300줄
//   상한 때문에 이 파일에 둔다(루트 main.rs 도 포화).
/// runInputs deriveFrom 내부 — 비오브젝트·input/extract 부재·타입·enum 불일치 abort,
///   input 공란(min1)·strict extras 만 dirty.
pub(crate) fn df_scan(v: Option<&Value>) -> Br {
    let Some(d) = v.and_then(Value::as_object) else {
        return ab(v.is_some());
    };
    let input = match d.get("input") {
        Some(Value::String(s)) if s.is_empty() => {
            Br::Dirty("deriveFrom.input".into(), TOO_SMALL.into())
        }
        Some(Value::String(_)) => Br::Clean,
        _ => return Br::Abort,
    };
    input
        .then(ab(d.get("extract") != Some(&json!("youtubeVideoId"))))
        .then(extras_at(d, &["input", "extract"], "deriveFrom".into()))
}

// ── 서브커맨드 핸들러 ────────────────────────────────────────────────────
pub fn validate_definition_steps(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let steps = input.get("steps");
    if let Some(Value::Array(a)) = steps {
        for s in a {
            if !truthy(s) || (!s.is_object() && !s.is_array()) {
                continue;
            }
            // JS `typeof step === 'object'` 는 배열도 통과 — z.object 는 배열을 거부한다.
            let Some(o) = s.as_object() else {
                return Err("Invalid workflow policy".into());
            };
            if !(o
                .get("deliveryVerification")
                .is_none_or(|v| *v == json!("required"))
                && o.get("capAcceptance")
                    .is_none_or(|v| *v == json!("blocked"))
                && o.get("qaConfig").is_none_or(qa_ok))
            {
                return Err("Invalid workflow policy".into());
            }
        }
    }
    if steps.is_none_or(|v| !truthy(v)) {
        return Ok(json!({"ok": true}));
    }
    let items = match steps.unwrap() {
        Value::Array(a) => a.clone(),
        Value::String(s) => s.chars().map(|c| json!(c.to_string())).collect(),
        _ => return Err("steps is not iterable".into()),
    };
    let (mut seen, mut dupset, mut dups) = (HashSet::new(), HashSet::new(), vec![]);
    for s in &items {
        if !truthy(s) {
            continue;
        }
        let Some(id) = s.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(id) && dupset.insert(id) {
            dups.push(id);
        }
    }
    if !dups.is_empty() {
        return Err(format!("Duplicate workflow step ids: {}", dups.join(", ")));
    }
    if !steps.unwrap().is_array() {
        return Err("steps.map is not a function".into());
    }
    let errors = find_tool_reference_errors(&items)?;
    if errors.is_empty() {
        return Ok(json!({"ok": true}));
    }
    let summary = errors
        .iter()
        .map(|e| {
            format!(
                "step \"{}\" references \"{}\" ({})",
                js_str(e.get("stepId")),
                js_str(e.get("referencedStepId")),
                js_str(e.get("reason"))
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!("Invalid workflow toolArgs references: {summary}. Only known forward ancestor steps may be referenced."))
}
pub fn definition_step_warnings(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("steps.map is not a function")?;
    let errors = find_tool_reference_errors(steps)?;
    let rejected: HashSet<String> = errors
        .iter()
        .map(|e| {
            format!(
                "{}\u{0}{}",
                js_str(e.get("stepId")),
                js_str(e.get("referencedStepId"))
            )
        })
        .collect();
    let mut warnings = vec![];
    for s in steps {
        let mut refs = collect_artifact_references(s.get("toolArgs"));
        if refs.is_empty() {
            continue;
        }
        refs.sort();
        let sel = s
            .get("workProductSelectors")
            .filter(|v| v.is_object() || v.is_array());
        for r in refs {
            if rejected.contains(&format!("{}\u{0}{r}", js_str(s.get("id")))) || js_in(&r, sel) {
                continue;
            }
            let msg = format!("Step \"{0}\" consumes the work product of ancestor step \"{1}\" through a {{$steps.{1}.workProduct*}} token but declares no workProductSelectors rule for it. \
                Without a rule the runtime falls back to a representative-first, latest-first pick and can permanently pin an arbitrary artifact (for example an image instead of content.json), which later fails consumption with qa_artifact_consumer_input_mismatch. \
                Fix by adding to step \"{0}\": \"workProductSelectors\": {{ \"{1}\": {{ \"type\": \"<work product type>\", \"title\": \"<exact registered work product title>\" }} }} — read the exact type and title from the artifacts registered by producing step \"{1}\". \
                References supplied by a runtime seed (workflowRunSeeds) are exempt from this warning and need no selector.", js_str(s.get("id")), r);
            let mut w = json!({"kind": "workproduct_selector_missing", "referencedStepId": r, "message": msg});
            if let Some(id) = s.get("id") {
                w["stepId"] = id.clone();
            }
            warnings.push(w);
        }
    }
    Ok(json!({ "warnings": warnings }))
}
pub fn summarize_step_warnings(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let warnings = input
        .get("warnings")
        .and_then(Value::as_array)
        .ok_or("warnings.map is not a function")?;
    let mut out = vec![];
    for w in warnings {
        if w.is_null() {
            return Err("Cannot destructure null".into());
        }
        let mut m = Map::new();
        for k in ["kind", "stepId", "referencedStepId"] {
            if let Some(v) = w.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
        out.push(Value::Object(m));
    }
    Ok(json!({ "summary": out }))
}

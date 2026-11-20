//! Pure port of server/src/services/missions/mission-quality-contract.ts.
//! Dynamic reads mirror JS property/iteration/template semantics (crate::js
//! supplies trim/truthiness). Err(_) mirrors TS TypeError throws.
//! Verbatim string constants/line builders live in crate::quality_contract_lines.
use crate::js::{js_trim, js_truthy};
use crate::quality_contract_lines as qcl;
use serde_json::{json, Map, Value};

pub const SUBCOMMANDS: &[&str] = &[
    "normalize-dependency-graph",
    "is-unit-materialized",
    "remap-to-step-ids",
    "extract-quality-contract",
    "render-quality-contract-section",
    "render-adaptive-quality-profile",
    "render-quality-review-lines",
    "render-evidence-writing-lines",
    "render-evidence-qa-lines",
    "render-verification-gate-lines",
    "verification-criteria",
    "render-structural-gate-lines",
    "quality-contract-constants",
];

/// `${v}` template interpolation; `None` models a read that produced `undefined`.
fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num_to_string(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(join_elem).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Array.prototype.join element ToString: null/undefined render as "".
fn join_elem(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        to_string(Some(v))
    }
}

#[rustfmt::skip] // 300-line file limit
fn num_to_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64().map(i128::from).or_else(|| n.as_u64().map(i128::from)) {
        return i.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f == f.trunc() && f.abs() < 1e21 {
        format!("{}", f.trunc() as i64)
    } else {
        format!("{f}")
    }
}

fn str_to_num(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        0.0
    } else {
        t.parse().unwrap_or(f64::NAN)
    }
}

/// `v > 0` under JS ToNumber coercion (for `value.length > 0` reads).
fn gt_zero(v: Option<&Value>) -> bool {
    let n: f64 = match v {
        Some(Value::Bool(b)) => u8::from(*b).into(),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_to_num(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => str_to_num(&to_string(Some(&a[0]))),
            _ => f64::NAN,
        },
        _ => return false,
    };
    n > 0.0
}

/// `(expr ?? "").trim()` — null/undefined collapse to "", strings js-trim,
/// other types raise the V8 TypeError text for the given source expression.
fn read_trimmed(v: Option<&Value>, expr: &str) -> Result<String, String> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(js_trim(s).to_string()),
        _ => Err(format!("{expr}.trim is not a function")),
    }
}

/// `if (contract.k.length > 0) { push(header); for (item of contract.k) ... }`:
/// strings iterate code points; a truthy length on a non-iterable throws.
fn emit_list(
    lines: &mut Vec<String>,
    header: &str,
    v: Option<&Value>,
    expr: &str,
) -> Result<(), String> {
    let gt0 = match v {
        None => return Err("Cannot read properties of undefined (reading 'length')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'length')".into()),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Object(o)) => gt_zero(o.get("length")),
        Some(_) => false,
    };
    if !gt0 {
        return Ok(());
    }
    lines.push(header.into());
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .for_each(|i| lines.push(format!("  - {}", to_string(Some(i))))),
        Some(Value::String(s)) => s.chars().for_each(|c| lines.push(format!("  - {c}"))),
        _ => return Err(format!("{expr} is not iterable")),
    }
    Ok(())
}

pub fn extract_mission_quality_contract(input: &Value) -> Result<Value, String> {
    if input.is_null() {
        return Err("Cannot read properties of null (reading 'missionGoal')".into());
    }
    let goal = read_trimmed(input.get("missionGoal"), "(input.missionGoal ?? \"\")")?;
    let sig = |k: &str| {
        input
            .get("qualitySignals")
            .and_then(|s| s.get(k))
            .and_then(Value::as_bool)
            == Some(true)
    };
    #[rustfmt::skip] // 300-line file limit
    let (beg, act, deep, html) =
        (sig("beginnerFacing"), sig("actionableReport"), sig("deepResearch"), sig("publishHtml"));
    let any = beg || act || deep || html;

    let mut must_deliver: Vec<&str> = Vec::new();
    let mut failure_criteria: Vec<&str> = Vec::new();
    let mut hard_stop_rules: Vec<&str> = Vec::new();
    if beg || act {
        must_deliver.push("A deliverable the intended audience can understand and use for the mission's stated decision or action.");
        failure_criteria.push(
            "Well-structured but a non-expert still cannot understand it or judge what to do next.",
        );
    }
    if deep {
        must_deliver.push(
            "Sufficient source breadth and depth, with contradictions and skepticism addressed.",
        );
        failure_criteria.push("Surface-level research: few sources, contradictions unexamined, or claims unsupported.");
    }
    if beg {
        hard_stop_rules.push("Beginner-facing artifact but the plan has no audience-appropriate comprehension or usability criterion tied to the requested outcome — REQUEST_CHANGES.");
    }
    if deep {
        hard_stop_rules.push("Deep-research artifact but no source-breadth/depth/contradiction/skeptic criterion — REQUEST_CHANGES.");
    }

    // `goal || title.trim() || "(unspecified ...)"` — title is read only when
    // goal is empty, so a non-string title throws only on that path.
    let purpose = if !goal.is_empty() {
        goal
    } else {
        let t = read_trimmed(input.get("missionTitle"), "(input.missionTitle ?? \"\")")?;
        if t.is_empty() {
            "(unspecified mission purpose)".into()
        } else {
            t
        }
    };

    let target_user = if beg {
        "non-expert / beginner"
    } else {
        "(unspecified audience)"
    };
    let use_case = if act {
        "decide and act on the deliverable"
    } else {
        "(unspecified use case)"
    };
    let signals = json!({
        "beginnerFacing": beg, "actionableReport": act, "deepResearch": deep, "publishHtml": html,
    });
    let mut o = Map::new();
    o.insert("purpose".into(), json!(purpose));
    o.insert("targetUser".into(), json!(target_user));
    o.insert("useCase".into(), json!(use_case));
    o.insert("mustDeliver".into(), json!(must_deliver));
    o.insert("failureCriteria".into(), json!(failure_criteria));
    o.insert("evaluationAxes".into(), json!(qcl::EVALUATION_AXES));
    o.insert("hardStopRules".into(), json!(hard_stop_rules));
    o.insert("signals".into(), signals);
    o.insert("underspecified".into(), json!(!any));
    o.insert(
        "clarifyNote".into(),
        if any {
            Value::Null
        } else {
            json!(qcl::CLARIFY_NOTE)
        },
    );
    Ok(Value::Object(o))
}

pub fn render_mission_quality_contract_section(contract: Option<&Value>) -> Result<Value, String> {
    match contract {
        None => return Err("Cannot read properties of undefined (reading 'purpose')".into()),
        Some(Value::Null) => {
            return Err("Cannot read properties of null (reading 'purpose')".into())
        }
        _ => {}
    }
    let get = |k: &str| contract.and_then(|v| v.get(k));
    let mut lines: Vec<String> = vec!["## Mission quality contract".into(), String::new()];
    lines.push(format!("- purpose: {}", to_string(get("purpose"))));
    lines.push(format!("- target user: {}", to_string(get("targetUser"))));
    lines.push(format!("- use case: {}", to_string(get("useCase"))));
    emit_list(
        &mut lines,
        "- must deliver:",
        get("mustDeliver"),
        "contract.mustDeliver",
    )?;
    emit_list(
        &mut lines,
        "- failure criteria:",
        get("failureCriteria"),
        "contract.failureCriteria",
    )?;
    match get("evaluationAxes") {
        Some(Value::Array(a)) => lines.push(format!(
            "- evaluation axes: {}",
            a.iter().map(join_elem).collect::<Vec<_>>().join(", ")
        )),
        None => return Err("Cannot read properties of undefined (reading 'join')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'join')".into()),
        _ => return Err("contract.evaluationAxes.join is not a function".into()),
    }
    if get("clarifyNote").map(js_truthy).unwrap_or(false) {
        lines.push(format!("- note: {}", to_string(get("clarifyNote"))));
    }
    emit_list(
        &mut lines,
        "- hard-stop rules (judge against this; REQUEST_CHANGES if clearly violated):",
        get("hardStopRules"),
        "contract.hardStopRules",
    )?;
    lines.push(String::new());
    Ok(json!(lines))
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let parse = |raw: &[u8]| serde_json::from_slice::<Value>(raw).map_err(|e| e.to_string());
    match subcommand {
        "extract-quality-contract" => extract_mission_quality_contract(&parse(raw)?),
        "render-quality-contract-section" => {
            render_mission_quality_contract_section(parse(raw)?.get("contract"))
        }
        "render-adaptive-quality-profile" => Ok(json!(qcl::adaptive_quality_profile_lines())),
        "render-quality-review-lines" => Ok(json!(qcl::mission_quality_review_lines())),
        "render-evidence-writing-lines" => Ok(json!(qcl::evidence_writing_lines())),
        "render-evidence-qa-lines" => Ok(json!(qcl::evidence_qa_lines())),
        "render-verification-gate-lines" => match parse(raw)?.get("options") {
            Some(Value::Null) => {
                Err("Cannot read properties of null (reading 'intermediateQa')".into())
            }
            options => Ok(json!(qcl::verification_gate_lines(
                options
                    .and_then(|o| o.get("intermediateQa"))
                    .map(js_truthy)
                    .unwrap_or(false)
            ))),
        },
        "verification-criteria" => Ok(json!(qcl::verification_gate_lines(false)
            .join("\n")
            .trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .to_string())),
        "render-structural-gate-lines" => Ok(json!(qcl::structural_gate_lines())),
        "quality-contract-constants" => Ok(json!({
            "EVIDENCE_CHAIN_FORMAT": qcl::EVIDENCE_CHAIN_FORMAT,
            "EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE": qcl::EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
            "MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE": qcl::MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
            "EVIDENCE_EXPLANATION_QUALITY_MARKER": qcl::EVIDENCE_EXPLANATION_QUALITY_MARKER,
            "VERIFICATION_BEFORE_COMPLETION_MARKER": qcl::VERIFICATION_BEFORE_COMPLETION_MARKER,
            "STRUCTURAL_GATE_ALREADY_RUN_MARKER": qcl::STRUCTURAL_GATE_ALREADY_RUN_MARKER,
        })),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

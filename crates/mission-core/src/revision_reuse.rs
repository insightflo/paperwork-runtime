//! Pure port of server/src/services/missions/revision-reuse-plan.ts (verbatim
//! reuse planning): refs record parse, identity-only/conflict/step-override
//! collectors, canonical delta builder. Step-graph functions live in
//! crate::revision_reuse_steps; Err(_) mirrors TS TypeError throws.
use crate::js::*;
use crate::revision_delta as d;
use crate::revision_reuse_steps as steps;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const SUBCOMMANDS: &[&str] = &[
    "parse-reuse-plan-record",
    "collect-identity-only-violations",
    "collect-closure-conflicts",
    "collect-step-override-violations",
    "resolve-reuse-closure",
    "project-reuse-step-to-unit",
    "assign-reserved-qa-step-ids",
    "build-canonical-revision-delta",
];
const SCHEMA_VERSION: &str = "mission-revision-reuse.v1";

pub fn diag(code: &str, message: String) -> Value {
    json!({"code": code, "message": message, "severity": "invalid"})
}
pub fn reuse_invalid(message: String) -> Value {
    diag("mission_revision_reuse_invalid", message)
}
pub fn dep_invalid(message: String) -> Value {
    diag("mission_revision_reuse_dependency_invalid", message)
}
pub fn fail(d: Value) -> Value {
    json!({"ok": false, "diagnostics": [d]})
}
/// ReadonlySet wire param: JS `new Set(expr)` domain → primitive lookup keys.
fn str_set(v: Option<&Value>) -> Result<HashSet<String>, String> {
    Ok(d::new_set_items(v)?
        .iter()
        .filter_map(d::js_map_key)
        .collect())
}

fn parse_reuse_plan_record(refs: Option<&Value>) -> Value {
    let Some(rec) = refs
        .and_then(|r| r.get("revisionReusePlan"))
        .filter(|v| v.is_object())
    else {
        return Value::Null;
    };
    let arr = |k: &str| {
        rec.get(k).and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter(|e| e.as_str().is_some_and(|s| !s.is_empty()))
                    .cloned()
                    .collect::<Vec<_>>()
            })
        })
    };
    let (Some(run), Some(roots), Some(closure)) = (
        rec.get("sourceWorkflowRunId").and_then(Value::as_str),
        arr("roots"),
        arr("closureUnitIds"),
    ) else {
        return Value::Null;
    };
    if rec.get("schemaVersion") != Some(&json!(SCHEMA_VERSION))
        || run.is_empty()
        || roots.is_empty()
        || closure.is_empty()
        || roots.iter().any(|r| !closure.contains(r))
    {
        return Value::Null;
    }
    json!({"schemaVersion": SCHEMA_VERSION, "sourceWorkflowRunId": run,
        "roots": roots, "closureUnitIds": closure})
}

fn collect_identity_only_violations(
    units: Option<&Value>,
    reuse_ids: &HashSet<String>,
) -> Result<Value, String> {
    let mut out = Vec::new();
    for unit in d::iter_values(units.unwrap_or(&Value::Null), "authoredUnits")? {
        if unit.is_null() {
            return Err("Cannot read properties of null (reading 'id')".into());
        }
        let Some(uid) = unit.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if !reuse_ids.contains(&format!("s:{uid}")) {
            continue;
        }
        let o = unit.as_object().unwrap();
        let ok = |v: Option<&Value>| {
            v.and_then(Value::as_str)
                .is_some_and(|s| (1..=200).contains(&d::utf16_len(s)))
        };
        let strict = o.keys().all(|k| k == "id" || k == "sourceStepId")
            && ok(o.get("id"))
            && ok(o.get("sourceStepId"))
            && o["id"] == o["sourceStepId"];
        if !strict {
            let unknown: Vec<String> = d::js_own_keys(o)
                .into_iter()
                .filter(|k| k != "id" && k != "sourceStepId")
                .collect();
            out.push(reuse_invalid(if unknown.is_empty() {
                format!("재사용 단위 {uid} 의 신원 계약이 올바르지 않습니다(id === sourceStepId).")
            } else {
                format!("재사용 단위 {uid} 는 신원(id/sourceStepId)만 선언할 수 있습니다 — 저작 구성 필드({}) 가 함께 선언되었습니다. 변경이 필요하면 modify 로 제출하세요.", unknown.join(", "))
            }));
        }
    }
    Ok(Value::Array(out))
}

fn collect_closure_conflicts(input: &Value) -> Result<Value, String> {
    let root_set = str_set(input.get("reuseRootUnitIds"))?;
    let mut out = Vec::new();
    for id in d::iter_values(&input["closureUnitIds"], "input.closureUnitIds")? {
        if d::js_map_key(&id).is_some_and(|k| root_set.contains(&k)) {
            continue;
        }
        let mut authored = false;
        for u in d::array_method(input.get("authoredUnits"), "input.authoredUnits", "some")? {
            if u.is_null() {
                return Err("Cannot read properties of null (reading 'id')".into());
            }
            if u.get("id").is_some_and(|v| d::js_strict_eq(v, &id)) {
                authored = true;
                break;
            }
        }
        let mut delta_entry: Option<&Value> = None;
        for u in d::array_method(input.get("deltaUnits"), "input.deltaUnits", "find")? {
            if u.is_null() {
                return Err("Cannot read properties of null (reading 'unitId')".into());
            }
            if u.get("unitId").is_some_and(|v| d::js_strict_eq(v, &id)) {
                delta_entry = Some(u);
                break;
            }
        }
        if !authored && delta_entry.is_none() {
            continue;
        }
        let claims = [
            authored.then(|| "저작된 계획 항목".to_string()),
            delta_entry.map(|e| format!("변경안 {} 항목", d::js_str_opt(e.get("operation")))),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" 과(와) ");
        out.push(dep_invalid(format!(
            "단계 {} 은(는) 재사용 클로저의 일부로 서버가 원본 실행에서 그대로 복사합니다 — {claims}이(가) 이 단계를 다르게 실행하려 합니다. 충돌 항목을 제거하거나 해당 단계를 재사용(reuse) 로 표시하세요.",
            d::js_str(&id)
        )));
    }
    Ok(Value::Array(out))
}

fn collect_step_override_violations(
    steps_v: Option<&Value>,
    closure: &HashSet<String>,
) -> Result<Value, String> {
    let mut out = Vec::new();
    let Some(arr) = steps_v.and_then(Value::as_array) else {
        return Ok(Value::Array(out));
    };
    for (i, e) in arr.iter().enumerate() {
        if !e.is_object() {
            continue;
        }
        let uid = e
            .get("unitId")
            .filter(|v| !v.is_null())
            .or_else(|| e.get("id"));
        let Some(uid) = uid.and_then(Value::as_str) else {
            continue;
        };
        if closure.contains(&format!("s:{uid}")) {
            out.push(reuse_invalid(format!(
                "decision.steps[{i}] 이(가) 재사용 단위 {uid} 의 배선을 덮어쓰려 합니다 — A 는 원본 실행 구성만 따릅니다."
            )));
        }
    }
    Ok(Value::Array(out))
}

fn build_canonical_revision_delta(raw: &Value, closure: Option<&Value>) -> Result<Value, String> {
    let Some(units) = d::parse_delta_units(raw) else {
        return Ok(raw.clone());
    };
    let existing: HashSet<String> = units
        .iter()
        .filter_map(|u| u["unitId"].as_str().map(str::to_string))
        .collect();
    let mut merged = units;
    for id in d::array_method(closure, "closureUnitIds", "filter")? {
        if id.as_str().is_none_or(|s| !existing.contains(s)) {
            merged.push(json!({"unitId": id, "operation": "reuse", "sourceStepId": id}));
        }
    }
    let mut out = js_spread(raw);
    out.insert("units".into(), Value::Array(merged));
    Ok(Value::Object(out))
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "parse-reuse-plan-record" => Ok(parse_reuse_plan_record(input.get("refs"))),
        "collect-identity-only-violations" => collect_identity_only_violations(
            input.get("authoredUnits"),
            &str_set(input.get("reuseUnitIds"))?,
        ),
        "collect-closure-conflicts" => collect_closure_conflicts(&input),
        "collect-step-override-violations" => collect_step_override_violations(
            input.get("decisionSteps"),
            &str_set(input.get("closureUnitIds"))?,
        ),
        "resolve-reuse-closure" => {
            steps::resolve_reuse_closure(input.get("sourceSteps"), input.get("roots"))
        }
        "project-reuse-step-to-unit" => steps::project_reuse_step_to_unit(input.get("step")),
        "assign-reserved-qa-step-ids" => steps::assign_reserved_qa_step_ids(&input),
        "build-canonical-revision-delta" => {
            build_canonical_revision_delta(&input["rawDelta"], input.get("closureUnitIds"))
        }
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

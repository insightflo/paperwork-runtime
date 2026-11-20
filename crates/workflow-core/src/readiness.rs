//! [파일 목적] dag-readiness-facts.ts 순수 코어의 Rust 포트(Stage 3) — runnable-steps /
//!   skippable-steps / activate 서브커맨드. findRunnableSteps 의 필터 순서(launched →
//!   escalation → pending stepRun → workProductSelectors → grace-wait → retry-due →
//!   classifyStepActivation)를 재현한다.
//! [parity] `Object.keys(selectors ?? {})` quirk(문자열→UTF-16 인덱스 키)·`issueId == null`
//!   (null/undefined 만)·단일 now 스냅샷(TS 는 Date 를 두 번 찍지만 계약은 nowIso 하나)·
//!   JS truthiness(`workflowRetry` 존재)를 정렬한다.
//! [외부 연결] consumer: main.rs CLI. edge 평가·PredFacts 해석은 control_flow 재사용,
//!   retry-due 는 Stage-1 is_workflow_retry_due 재사용.

use crate::{edge_step, pred_facts_map};
use paperclip_workflow_core::control_flow::{classify_step_activation, js_truthy, string_elements};
use paperclip_workflow_core::{is_workflow_retry_due, parse_iso8601_millis};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnableInput {
    steps: Vec<Value>,
    #[serde(default)]
    preds: HashMap<String, Value>,
    #[serde(default)]
    step_runs: Map<String, Value>,
    #[serde(default)]
    options: RunnableOptions,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RunnableOptions {
    launched_step_ids: Option<Value>,
    now_iso: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkippableInput {
    steps: Vec<Value>,
    #[serde(default)]
    preds: HashMap<String, Value>,
    #[serde(default)]
    options: SkippableOptions,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkippableOptions {
    launched_step_ids: Option<Value>,
    eligible_step_ids: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateInput {
    steps: Vec<Value>,
    #[serde(default)]
    preds: HashMap<String, Value>,
}

/// JS truthy-값이면 필터링 대상 id 집합으로 환산. `new Set(str)` 의 문자열 반복까지 근사.
///   null/absent → None(필터 없음), 비문자열·비배열 truthy → 빈 집합(전부 차단).
fn opt_id_set(v: Option<&Value>) -> Option<HashSet<String>> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.chars().map(String::from).collect()),
        other => Some(string_elements(other).into_iter().collect()),
    }
}

/// JS Object.keys — 객체는 own 키, 문자열은 UTF-16 코드유닛 인덱스, 배열은 인덱스, 그 외 빈 배열.
fn object_keys(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        Some(Value::String(s)) => (0..s.encode_utf16().count())
            .map(|i| i.to_string())
            .collect(),
        Some(Value::Array(a)) => (0..a.len()).map(|i| i.to_string()).collect(),
        _ => vec![],
    }
}

/// controlNodeGraceWait 읽기 — since/nextEvaluateAt 모두 비지 않은 문자열일 때만 유효(TS 동일).
///   Date.parse 가 finite 해야 차단; `now <= nextEvaluateAt`(`<=` — release pass 자신도 차단).
fn grace_wait_blocking(metadata: Option<&Value>, now_ms: i64) -> bool {
    let Some(wait) = metadata
        .and_then(Value::as_object)
        .and_then(|o| o.get("controlNodeGraceWait"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    let get = |k: &str| wait.get(k).and_then(Value::as_str).unwrap_or("");
    let (since, next) = (get("since"), get("nextEvaluateAt"));
    if since.is_empty() || next.is_empty() {
        return false;
    }
    parse_iso8601_millis(next).is_some_and(|ms| now_ms <= ms)
}

/// isRetryDelayBlockingDispatch — workflowRetry 가 truthy 이면서 due 가 아니면 차단.
fn retry_delay_blocking(metadata: Option<&Value>, now_ms: i64) -> bool {
    let retry = metadata
        .and_then(Value::as_object)
        .and_then(|o| o.get("workflowRetry"));
    js_truthy(retry) && !is_workflow_retry_due(retry, now_ms)
}

fn step_id(step: &Value) -> Option<&str> {
    step.get("id").and_then(Value::as_str)
}

/// findRunnableSteps — stepRun 맵의 status/issueId/metadata + preds edge 평가로 발화 대상 선정.
fn is_runnable(
    step: &Value,
    step_runs: &Map<String, Value>,
    preds: &HashMap<String, paperclip_workflow_core::control_flow::PredFacts>,
    launched: Option<&HashSet<String>>,
    now_ms: i64,
) -> bool {
    let id = step_id(step);
    if launched.is_some_and(|set| !id.is_some_and(|i| set.contains(i))) {
        return false;
    }
    if step.get("triggerOn").and_then(Value::as_str) == Some("escalation") {
        return false;
    }
    // 비문자열 id 는 stepRuns 키와 절대 일치하지 않는다(JS Map.get SameValueZero) → 부재 취급.
    let Some(run) = id.and_then(|i| step_runs.get(i)) else {
        return false;
    };
    if run.get("status").and_then(Value::as_str) != Some("pending") {
        return false;
    }
    // selector 선행 조회는 step 목록이 아니라 stepRunMap — `?? {}` quirk 로 비객체 도 keys 를 가진다.
    if object_keys(step.get("workProductSelectors"))
        .iter()
        .any(|k| {
            step_runs
                .get(k)
                .and_then(|r| r.get("status"))
                .and_then(Value::as_str)
                != Some("completed")
        })
    {
        return false;
    }
    let issue_null = matches!(run.get("issueId"), None | Some(Value::Null));
    if issue_null
        && step.get("type").and_then(Value::as_str) == Some("if")
        && grace_wait_blocking(run.get("metadata"), now_ms)
    {
        return false;
    }
    if retry_delay_blocking(run.get("metadata"), now_ms) {
        return false;
    }
    classify_step_activation(&edge_step(step), preds).runnable
}

pub fn runnable_steps(raw: &[u8]) -> Result<Value, String> {
    let input: RunnableInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let now_iso = input
        .options
        .now_iso
        .ok_or_else(|| "invalid nowIso".to_string())?;
    let now_ms = parse_iso8601_millis(&now_iso).ok_or_else(|| "invalid nowIso".to_string())?;
    let launched = opt_id_set(input.options.launched_step_ids.as_ref());
    let preds = pred_facts_map(input.preds);
    let step_ids: Vec<String> = input
        .steps
        .iter()
        .filter(|step| is_runnable(step, &input.step_runs, &preds, launched.as_ref(), now_ms))
        .filter_map(|step| step_id(step).map(str::to_string))
        .collect();
    Ok(json!({ "stepIds": step_ids }))
}

/// findSkippableSteps — launchedStepIds + eligibleStepIds(TS isStepEligible 콜백의 브리지 산출물).
pub fn skippable_steps(raw: &[u8]) -> Result<Value, String> {
    let input: SkippableInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let launched = opt_id_set(input.options.launched_step_ids.as_ref());
    let eligible = opt_id_set(input.options.eligible_step_ids.as_ref());
    let preds = pred_facts_map(input.preds);
    let step_ids: Vec<String> = input
        .steps
        .iter()
        .map(edge_step)
        .filter(|step| launched.as_ref().is_none_or(|set| set.contains(&step.id)))
        .filter(|step| eligible.as_ref().is_none_or(|set| set.contains(&step.id)))
        .filter(|step| classify_step_activation(step, &preds).skippable)
        .map(|step| step.id)
        .collect();
    Ok(json!({ "stepIds": step_ids }))
}

/// activate — classifyStepActivation 의 batch 진입점(입력 순서 유지).
pub fn activate(raw: &[u8]) -> Result<Value, String> {
    let input: ActivateInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let preds = pred_facts_map(input.preds);
    let activations: Vec<Value> = input
        .steps
        .iter()
        .map(|step| {
            let a = classify_step_activation(&edge_step(step), &preds);
            json!({
                "stepId": step.get("id").cloned().unwrap_or(Value::Null),
                "runnable": a.runnable,
                "skippable": a.skippable,
                "waiting": a.waiting,
            })
        })
        .collect();
    Ok(json!({ "activations": activations }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sub: fn(&[u8]) -> Result<Value, String>, payload: &str) -> Value {
        sub(payload.as_bytes()).unwrap()
    }

    #[test]
    fn runnable_filters_in_contract_order() {
        // b: deps a(completed) → runnable. c: if+무이슈 grace 미래 → 차단 / 과거 → 통과.
        // d: retry due(과거) → 통과. e: retry 미래 → 차단. f: 비-pending → 차단.
        // g: selectors "ab" → Object.keys → "0","1" 의 stepRun 부재 → 차단. h: escalation → 차단.
        let steps = r#"[{"id":"b","dependencies":["a"],"type":"agent"},{"id":"c","type":"if","dependencies":[]},{"id":"d","dependencies":[]},{"id":"e","dependencies":[]},{"id":"f","dependencies":[]},{"id":"g","dependencies":[],"workProductSelectors":"ab"},{"id":"h","dependencies":[],"triggerOn":"escalation"},{"id":"x","dependencies":["a"],"type":"agent"}]"#;
        let payload = |grace_next: &str| {
            format!(
                r#"{{"steps":{steps},"preds":{{"a":{{"status":"completed"}}}},"stepRuns":{{"a":{{"status":"completed"}},"b":{{"status":"pending","issueId":"i1","metadata":null}},"c":{{"status":"pending","issueId":null,"metadata":{{"controlNodeGraceWait":{{"since":"2026-11-20T00:00:00Z","nextEvaluateAt":"{grace_next}"}}}}}},"d":{{"status":"pending","metadata":{{"workflowRetry":{{"state":"waiting","retryNumber":1,"maxRetries":2,"nextEligibleAt":"2000-01-01T00:00:00Z"}}}}}},"e":{{"status":"pending","metadata":{{"workflowRetry":{{"state":"waiting","retryNumber":1,"maxRetries":2,"nextEligibleAt":"9999-01-01T00:00:00Z"}}}}}},"f":{{"status":"running"}},"g":{{"status":"pending"}},"x":{{"status":"pending"}}}},"options":{{"nowIso":"2026-11-20T12:00:00Z"}}}}"#
            )
        };
        let out = run(runnable_steps, &payload("9999-01-01T00:00:00Z"));
        assert_eq!(out["stepIds"], json!(["b", "d", "x"]));
        // nextEvaluateAt < now 여야 release(`<=` 이므로 동일 시각도 차단).
        let out = run(runnable_steps, &payload("2000-01-01T00:00:00Z"));
        assert_eq!(out["stepIds"], json!(["b", "c", "d", "x"]));
        // launched 제한 + issueId 있는 if → grace 미적용(issue 가 있으면 대상 아님).
        let steps = r#"[{"id":"c","type":"if","dependencies":[]},{"id":"x","dependencies":["a"],"type":"agent"}]"#;
        let out = run(
            runnable_steps,
            &format!(
                r#"{{"steps":{steps},"preds":{{"a":{{"status":"completed"}}}},"stepRuns":{{"c":{{"status":"pending","issueId":"i9","metadata":{{"controlNodeGraceWait":{{"since":"2026-01-01T00:00:00Z","nextEvaluateAt":"9999-01-01T00:00:00Z"}}}}}},"x":{{"status":"pending"}}}},"options":{{"launchedStepIds":["c"],"nowIso":"2026-11-20T00:00:00Z"}}}}"#
            ),
        );
        assert_eq!(out["stepIds"], json!(["c"]));
    }

    #[test]
    fn skippable_and_activate() {
        let steps = r#"[{"id":"s1","dependencies":["a"]},{"id":"s2","dependencies":["b"]},{"id":"s3","dependencies":[],"conditionalDependencies":[{"stepId":"a","when":"failure"}]},{"id":"s4","dependencies":["c"]}]"#;
        let preds =
            r#"{"a":{"status":"failed"},"b":{"status":"completed"},"c":{"status":"pending"}}"#;
        let out = run(
            skippable_steps,
            &format!(r#"{{"steps":{steps},"preds":{preds},"options":{{}}}}"#),
        );
        assert_eq!(out["stepIds"], json!(["s1"]));
        let out = run(
            skippable_steps,
            &format!(
                r#"{{"steps":{steps},"preds":{preds},"options":{{"eligibleStepIds":["s1","s4"]}}}}"#
            ),
        );
        assert_eq!(out["stepIds"], json!(["s1"]));
        let out = run(
            skippable_steps,
            &format!(
                r#"{{"steps":{steps},"preds":{preds},"options":{{"launchedStepIds":["s4"]}}}}"#
            ),
        );
        assert_eq!(out["stepIds"], json!([]));
        let out = run(activate, &format!(r#"{{"steps":{steps},"preds":{preds}}}"#));
        assert_eq!(
            out["activations"],
            json!([
                {"stepId":"s1","runnable":false,"skippable":true,"waiting":false},
                {"stepId":"s2","runnable":true,"skippable":false,"waiting":false},
                {"stepId":"s3","runnable":true,"skippable":false,"waiting":false},
                {"stepId":"s4","runnable":false,"skippable":false,"waiting":true},
            ])
        );
    }
}

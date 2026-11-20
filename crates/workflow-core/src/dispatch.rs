//! [파일 목적] 서브커맨드 디스패치 테이블 — stdin JSON → Value 응답. main.rs 가
//!   300줄 상한에 걸려 Stage 7A 에서 본 모듈로 분리했다(입력 struct·dispatch·테스트 포함).
//! [외부 연결] 각 Stage 모듈(readiness/render/retry_batch/condition_eval/artifact_refs/
//!   structural_gate)의 `pub fn(raw)->Result<Value,String>` 핸들러를 매칭하고,
//!   edge_step/pred_facts_map 헬퍼는 crate root(main.rs)의 것을 공유한다.

use crate::{edge_step, pred_facts_map};
use paperclip_workflow_core::{
    append_retry_attempt, calculate_workflow_retry_delay_seconds, classify_workflow_step_retry,
    control_flow::{
        classify_step_activation, find_skippable_steps, string_elements, EdgeBearingStep,
    },
    dag::{has_disallowed_cycle, validate_dag},
    has_malformed_workflow_retry, is_step_run_awaiting_retry, is_workflow_retry_due,
    normalize_workflow_retry_policy, parse_iso8601_millis, read_workflow_retry_metadata,
    sanitize_error_summary, WorkflowRetryBackoff, WorkflowRetryPolicySource,
    WorkflowStepRetryClassificationInput,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalculateDelayInput {
    delay_seconds: u64,
    backoff: WorkflowRetryBackoff,
    jitter: bool,
    retry_number: u64,
    #[serde(default = "default_half")]
    random_sample: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyInput {
    #[serde(flatten)]
    input: WorkflowStepRetryClassificationInput,
    #[serde(default = "default_half")]
    random_sample: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendAttemptInput {
    history: Option<Value>,
    attempt: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DueInput {
    metadata: Option<Value>,
    now_iso: String,
}

/// DAG/activation 서브커맨드 공통 — step/pred 는 TS duck-typing 관대성 정렬을 위해 raw Value 로 받는다
///   (비문자열 id·stepId·dep·status 도 serde 실패가 아니라 JS-permissive 해석으로 흘린다).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepsInput {
    steps: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyActivationInput {
    step: Value,
    preds: HashMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindSkippableInput {
    steps: Vec<Value>,
    preds: HashMap<String, Value>,
    launched_step_ids: Option<Value>,
}

fn default_half() -> f64 {
    0.5
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    match subcommand {
        "normalize-policy" => {
            let input: WorkflowRetryPolicySource =
                serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            serde_json::to_value(normalize_workflow_retry_policy(&input)).map_err(|e| e.to_string())
        }
        "calculate-delay" => {
            let input: CalculateDelayInput =
                serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            Ok(json!({
                "delaySeconds": calculate_workflow_retry_delay_seconds(
                    input.delay_seconds,
                    input.backoff,
                    input.jitter,
                    input.retry_number,
                    input.random_sample,
                )
            }))
        }
        "classify-retry" => {
            let input: ClassifyInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            serde_json::to_value(classify_workflow_step_retry(
                &input.input,
                input.random_sample,
            ))
            .map_err(|e| e.to_string())
        }
        "sanitize-error" => {
            let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let val = input.as_object().and_then(|m| m.get("value"));
            Ok(json!({ "summary": sanitize_error_summary(val) }))
        }
        "append-attempt" => {
            let input: AppendAttemptInput =
                serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            serde_json::to_value(append_retry_attempt(input.history.as_ref(), &input.attempt))
                .map_err(|e| e.to_string())
        }
        "read-metadata" => {
            let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(read_workflow_retry_metadata(
                input.as_object().and_then(|m| m.get("metadata")),
            ))
            .map_err(|e| e.to_string())?)
        }
        "is-due" => {
            let input: DueInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let now_ms =
                parse_iso8601_millis(&input.now_iso).ok_or_else(|| "invalid nowIso".to_string())?;
            Ok(json!({
                "due": is_workflow_retry_due(input.metadata.as_ref(), now_ms),
                "awaiting": is_step_run_awaiting_retry(input.metadata.as_ref()),
                "malformed": has_malformed_workflow_retry(input.metadata.as_ref()),
            }))
        }
        "validate-dag" => {
            let input: StepsInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            serde_json::to_value(validate_dag(&input.steps)).map_err(|e| e.to_string())
        }
        "has-disallowed-cycle" => {
            let input: StepsInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            Ok(json!({ "hasCycle": has_disallowed_cycle(&input.steps) }))
        }
        "classify-activation" => {
            let input: ClassifyActivationInput =
                serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            serde_json::to_value(classify_step_activation(
                &edge_step(&input.step),
                &pred_facts_map(input.preds),
            ))
            .map_err(|e| e.to_string())
        }
        "find-skippable" => {
            let input: FindSkippableInput =
                serde_json::from_slice(raw).map_err(|e| e.to_string())?;
            let steps: Vec<EdgeBearingStep> = input.steps.iter().map(edge_step).collect();
            let launched: Option<HashSet<String>> = input
                .launched_step_ids
                .as_ref()
                .map(|v| string_elements(Some(v)).into_iter().collect());
            Ok(json!({
                "stepIds": find_skippable_steps(&steps, &pred_facts_map(input.preds), launched.as_ref())
            }))
        }
        "runnable-steps" => crate::readiness::runnable_steps(raw),
        "skippable-steps" => crate::readiness::skippable_steps(raw),
        "activate" => crate::readiness::activate(raw),
        "render-tool-args" => crate::render::render_tool_args(raw),
        "classify-retry-batch" => crate::retry_batch::classify_retry_batch(raw),
        "evaluate-conditions" => crate::condition_eval::evaluate_conditions(raw),
        "artifact-references" => crate::artifact_refs::artifact_references(raw),
        "ancestor-step-ids" => crate::artifact_refs::ancestor_step_ids(raw),
        "tool-reference-errors" => crate::artifact_refs::tool_reference_errors(raw),
        "gate-producer-token" => crate::structural_gate::gate_producer_token(raw),
        "same-producer-token" => crate::structural_gate::same_producer_token(raw),
        "is-structural-gate" => crate::structural_gate::is_structural_gate(raw),
        "structural-topology-errors" => crate::structural_gate::structural_topology_errors(raw),
        "check-step-eligibility" => crate::resume_eligibility::check_step_eligibility(raw),
        "sort-steps-by-priority" => crate::resume_eligibility::sort_steps_by_priority(raw),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

#[cfg(test)]
#[rustfmt::skip] // fixture/기대값을 한 줄 raw-string JSON 으로 유지 — 읽기 표이 compact 해진다.
mod tests {
    use super::*;

    fn run(sub: &str, payload: &str) -> Value {
        dispatch(sub, payload.as_bytes()).unwrap()
    }
    fn eq(sub: &str, payload: &str, expected: &str) {
        assert_eq!(run(sub, payload), serde_json::from_str::<Value>(expected).unwrap());
    }

    #[test]
    fn retry_subcommands_round_trip() {
        eq("normalize-policy", r#"{"onFailure":"retry","maxRetries":3,"graphRetryBackoff":"linear"}"#, r#"{"enabled":true,"maxRetries":3,"delaySeconds":0,"backoff":"linear","jitter":false}"#);
        eq("calculate-delay", r#"{"delaySeconds":10,"backoff":"exponential","jitter":false,"retryNumber":3}"#, r#"{"delaySeconds":40}"#);
        eq("sanitize-error", r#"{"value":"Authorization: Bearer abc"}"#, r#"{"summary":"[REDACTED]"}"#);
        eq("append-attempt", r#"{"attempt":{"retryNumber":1,"failedAt":"2026-11-20T00:00:00Z","errorSummary":"x"}}"#, r#"[{"retryNumber":1,"failedAt":"2026-11-20T00:00:00Z","errorSummary":"x"}]"#);
        let m = r#"{"state":"waiting","retryNumber":1,"maxRetries":2,"nextEligibleAt":"2026-11-20T00:00:00Z"}"#;
        eq("is-due", &format!("{{\"metadata\":{m},\"nowIso\":\"2026-11-20T01:00:00Z\"}}"), r#"{"due":true,"awaiting":false,"malformed":false}"#);
        eq("is-due", &format!("{{\"metadata\":{{\"workflowRetry\":{m}}},\"nowIso\":\"2026-11-20T01:00:00Z\"}}"), r#"{"due":false,"awaiting":true,"malformed":false}"#);
    }

    #[test]
    fn dag_and_activation_subcommands() {
        let steps = r#"[{"id":"a","dependencies":[]},{"id":"b","dependencies":["a"],"conditionalDependencies":[{"stepId":"a","when":"qa_request_changes","isBackEdge":true,"maxIterations":2}]}]"#;
        eq("has-disallowed-cycle", &format!("{{\"steps\":{steps}}}"), r#"{"hasCycle":false}"#);
        let out = run("validate-dag", &format!("{{\"steps\":{steps}}}"));
        assert_eq!(out["valid"], json!(true));
        assert_eq!(out["warnings"], json!(["Step \"b\" is unreachable from any entry point"]));
        // permissive preds: 비객체/비문자열 status/비bool dispatchReady 도 JS 관대 해석(serde 실패 아님).
        // 비문자열 stepId edge 는 drop, always edge 는 skipped 선행에 발화.
        eq("classify-activation", r#"{"step":{"id":"s","dependencies":["a","b","c"]},"preds":{"a":9,"b":{"status":"completed","dispatchReady":"no"},"c":{"status":"pending"}}}"#, r#"{"runnable":false,"skippable":false,"waiting":true}"#);
        eq("classify-activation", r#"{"step":{"id":"s","dependencies":[],"conditionalDependencies":[{"stepId":7},{"stepId":"a","when":"always"}]},"preds":{"a":{"status":"skipped"}}}"#, r#"{"runnable":true,"skippable":false,"waiting":false}"#);
        eq("find-skippable", r#"{"steps":[{"id":"s1","dependencies":["a"]},{"id":"s2","dependencies":["b"]}],"preds":{"a":{"status":"failed"},"b":{"status":"completed"}},"launchedStepIds":["s1"]}"#, r#"{"stepIds":["s1"]}"#);
    }

    #[test]
    fn stage4a_subcommands_dispatch() {
        let out = run("classify-retry-batch", r#"{"nowIso":"2026-11-20T00:00:00.000Z","items":[{"id":"s","policy":{"enabled":true,"maxRetries":2,"delaySeconds":0,"backoff":"fixed","jitter":false},"stepRunStatus":"failed","retryCount":0,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false}]}"#);
        assert_eq!(out["items"][0]["eligible"], json!(true));
        let out = run("evaluate-conditions", r#"{"combinator":"all","conditions":[{"source":{"kind":"tool_json","stepId":"p","path":"$","toolName":"m"},"dataType":"number","operator":"less_than","rightValue":9,"left":5}]}"#);
        assert_eq!(out, json!({"outcome":true,"results":[true]}));
    }

    #[test]
    fn stage7a_subcommands_dispatch() {
        eq("artifact-references", r#"{"value":{"t":"{$steps.a.workProductPath} {$steps.b.siblingAssetsDir}"}}"#, r#"{"references":["a","b"]}"#);
        eq("ancestor-step-ids", r#"{"currentStepId":"c","steps":[{"id":"a"},{"id":"b","dependencies":["a"]},{"id":"c","dependencies":["b"]}]}"#, r#"{"ancestors":["b","a"]}"#);
        eq("tool-reference-errors", r#"{"steps":[{"id":"a","toolArgs":"{$steps.ghost.workProductDir}"}]}"#, r#"{"errors":[{"stepId":"a","referencedStepId":"ghost","reason":"unknown_step"}]}"#);
        eq("gate-producer-token", r#"{"value":{"producerStepId":" p ","iterationIndex":2,"completedAt":" t "}}"#, r#"{"token":{"producerStepId":"p","iterationIndex":2,"completedAt":"t"}}"#);
        eq("same-producer-token", r#"{"left":{"producerStepId":"p","iterationIndex":1,"completedAt":"t"},"right":{"producerStepId":"p","iterationIndex":1.0,"completedAt":"t"}}"#, r#"{"same":true}"#);
        eq("is-structural-gate", r#"{"step":{"type":"tool","qaType":"structural","toolNames":["x"]}}"#, r#"{"isGate":true}"#);
        eq("structural-topology-errors", r#"{"steps":[{"id":"p","type":"action"},{"id":"g","type":"tool","qaType":"structural","toolNames":["x"],"dependencies":["p"]},{"id":"q","type":"qa","dependencies":["g"]}]}"#, r#"{"errors":["QA step \"q\" depends on structural gate \"g\" but omits producer \"p\"."]}"#);
    }

    #[test]
    fn stage7c_subcommands_dispatch() {
        eq("check-step-eligibility", r#"{"history":{"status":"running"}}"#, r#"{"blocker":"active_work"}"#);
        // 필드 부재 — `issueId !== null` 은 undefined 도 !== null: 기록 이력으로 본다.
        eq("check-step-eligibility", r#"{"history":{"status":"pending","kind":"agent","effect":"none"}}"#, r#"{"blocker":"executed_step"}"#);
        eq("check-step-eligibility", r#"{"history":{"status":"pending","kind":"agent","effect":"none","issueId":null,"startedAt":null,"hasAttempt":false,"hasQueue":false,"hasExternalResult":false}}"#, r#"{"blocker":null}"#);
        eq("sort-steps-by-priority", r#"{"steps":[{"id":"a","executionControls":{"priority":"low"}},{"id":"b","executionControls":{"priority":"critical"}},{"id":"c"}]}"#, r#"{"steps":[{"id":"b","executionControls":{"priority":"critical"}},{"id":"a","executionControls":{"priority":"low"}},{"id":"c"}]}"#);
        eq("sort-steps-by-priority", r#"{"steps":"ba"}"#, r#"{"steps":["b","a"]}"#);
    }

    #[test]
    fn rejects_unknown_subcommand() {
        assert!(dispatch("nope", b"{}").is_err());
    }
}

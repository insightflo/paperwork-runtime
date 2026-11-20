use paperclip_workflow_core::{
    append_retry_attempt, calculate_workflow_retry_delay_seconds, classify_workflow_step_retry,
    control_flow::{
        classify_step_activation, find_skippable_steps, string_elements, EdgeBearingStep, PredFacts,
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
use std::env;
use std::io::{self, Read};
use std::process;

/// Stage 3 서브커맨드 — bin 모듈(lib 미공개). render: tool-arg 템플릿, readiness: 실행 게이트.
mod readiness;
mod render;
mod render_path;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

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

/// EdgeBearingStep 의 JS-permissive 구성: 문자열 id 만 채택, deps/conditional 는 raw 보존.
fn edge_step(v: &Value) -> EdgeBearingStep {
    EdgeBearingStep {
        id: v
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        dependencies: v.get("dependencies").cloned(),
        conditional_dependencies: v.get("conditionalDependencies").cloned(),
    }
}

fn pred_facts_map(preds: HashMap<String, Value>) -> HashMap<String, PredFacts> {
    preds
        .into_iter()
        .map(|(k, v)| (k, PredFacts::from_value(&v)))
        .collect()
}

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
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
        "runnable-steps" => readiness::runnable_steps(raw),
        "skippable-steps" => readiness::skippable_steps(raw),
        "activate" => readiness::activate(raw),
        "render-tool-args" => render::render_tool_args(raw),
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(
            "usage: paperclip-workflow-core <normalize-policy|calculate-delay|classify-retry|sanitize-error|append-attempt|read-metadata|is-due|validate-dag|has-disallowed-cycle|classify-activation|find-skippable|runnable-steps|skippable-steps|activate|render-tool-args>"
                .to_string(),
        );
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
    fn rejects_unknown_subcommand() {
        assert!(dispatch("nope", b"{}").is_err());
    }
}

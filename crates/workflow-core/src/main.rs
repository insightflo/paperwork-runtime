use paperclip_workflow_core::{
    append_retry_attempt, calculate_workflow_retry_delay_seconds, classify_workflow_step_retry,
    has_malformed_workflow_retry, is_step_run_awaiting_retry, is_workflow_retry_due,
    normalize_workflow_retry_policy, parse_iso8601_millis, read_workflow_retry_metadata,
    sanitize_error_summary, WorkflowRetryBackoff, WorkflowRetryPolicySource,
    WorkflowStepRetryClassificationInput,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

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

fn default_half() -> f64 {
    0.5
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
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(
            "usage: paperclip-workflow-core <normalize-policy|calculate-delay|classify-retry|sanitize-error|append-attempt|read-metadata|is-due>"
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

use paperclip_workflow_core::control_flow::{EdgeBearingStep, PredFacts};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::io::{self, Read};
use std::process;

/// Stage 서브커맨드 bin 모듈(lib 미공개) — js_value: JS 의미론, condition_eval:
///   IF 조건 평가, retry_batch: 재시도 배치 판정·패치, render: tool-arg, readiness: 게이트,
///   dispatch: 서브커맨드 테이블, artifact_refs/structural_gate: Stage 7A 포트.
mod artifact_refs;
mod condition_eval;
mod dispatch;
mod js_value;
mod qa_defect_card;
mod readiness;
mod render;
mod render_path;
mod retry_batch;
mod structural_gate;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

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

/// qa-defect-card-historical 은 lone surrogate 문자열을 낼 수 있어 Value 직렬화를 우회해
///   직접 JSON 텍스트를 받는다; 나머지 서브커맨드는 dispatch::dispatch 의 Value 경로.
fn dispatch_text(subcommand: &str, raw: &[u8]) -> Result<String, String> {
    if subcommand == "qa-defect-card-historical" {
        return qa_defect_card::historical_card(raw);
    }
    dispatch::dispatch(subcommand, raw)
        .and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(
            "usage: paperclip-workflow-core <normalize-policy|calculate-delay|classify-retry|classify-retry-batch|sanitize-error|append-attempt|read-metadata|is-due|validate-dag|has-disallowed-cycle|classify-activation|find-skippable|runnable-steps|skippable-steps|activate|render-tool-args|evaluate-conditions|qa-defect-card-historical|artifact-references|ancestor-step-ids|tool-reference-errors|gate-producer-token|same-producer-token|is-structural-gate|structural-topology-errors>"
                .to_string(),
        );
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    println!("{}", dispatch_text(subcommand, &raw)?);
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

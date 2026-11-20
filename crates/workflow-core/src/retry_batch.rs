//! [파일 목적] 실패 stepRun 배치의 retry 판정 + 스케줄 메타데이터 산출(Stage 4A).
//!   classify-retry-batch: item 마다 policySource → normalize → classify → eligible 시
//!   buildRetryMetadataPatch(step-retry-scheduler.ts)와 동일한 metadata 갱신을 반환한다.
//!   배치이므로 호출자는 spawn 1회로 N개 실패 stepRun 의 판정·패치를 얻는다.
//! [parity] jitter 는 외부 주입 jitterRandom(f64) — Rust 는 RNG 를 소유하지 않는다.
//!   지연 상한 86400s·base==0→0·exponent 오버플로 상한은 Stage-1 lib 계약 그대로.
//!   patch 삭제 키·workflowRetryAttempts 누적 규칙은 scheduler 와 동일 목록이다.
//! [외부 연결] consumer: main.rs CLI. CAS/이벤트/run-reopen·품질예산 같은 DB 부수효과는
//!   TS(step-retry-scheduler.ts) 책임 — 이 모듈은 순수 산출물만 만든다.

use paperclip_workflow_core::{
    append_retry_attempt, classify_workflow_step_retry, normalize_workflow_retry_policy,
    parse_iso8601_millis, sanitize_error_summary, WorkflowRetryPolicy, WorkflowRetryPolicySource,
    WorkflowStepRetryClassificationInput, WorkflowStepRetryDecision,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// buildRetryMetadataPatch 와 동일 — 재시도 전 stale 실행 흔적은 메타데이터에서 제거.
const STALE_KEYS: [&str; 6] = [
    "toolResult",
    "toolInvocation",
    "toolQueue",
    "cacheHit",
    "controlFlowSkipped",
    "workflowRetryExhaustion",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchInput {
    now_iso: String,
    #[serde(default)]
    items: Vec<BatchItem>,
}

/// item 1건 = 실패 stepRun 의 분류 입력 + 메타데이터 패치 재료.
///   `policy` 가 오면 그대로, 아니면 `policySource` 를 normalize 한다(TS pass 와 동일 경로).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchItem {
    #[serde(default)]
    id: Value,
    policy: Option<WorkflowRetryPolicy>,
    #[serde(default)]
    policy_source: WorkflowRetryPolicySource,
    #[serde(default)]
    step_run_status: Value,
    #[serde(default)]
    retry_count: f64,
    #[serde(default)]
    is_control_node: bool,
    #[serde(default)]
    step_type_supported: bool,
    #[serde(default)]
    is_qa_step: bool,
    #[serde(default)]
    qa_request_changes: bool,
    #[serde(default)]
    recovery_active: bool,
    #[serde(default = "default_half")]
    jitter_random: f64,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    source_request_id: Value,
    #[serde(default)]
    source_completed_at: Value,
    #[serde(default)]
    error_summary: Value,
}

fn default_half() -> f64 {
    0.5
}

/// epoch ms → Date.prototype.toISOString()("YYYY-MM-DDTHH:mm:ss.sssZ", UTC 고정).
///   chrono 없이 civil-from-days 로 직접 포맷한다(lib days_from_civil 의 역함수).
fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (hour, min, sec, frac) = (
        rem / 3_600_000,
        rem % 3_600_000 / 60_000,
        rem % 60_000 / 1_000,
        rem % 1_000,
    );
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{frac:03}Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + i64::from(m <= 2), m, d)
}

/// buildWorkflowRetryMetadata — sourceRequestId/sourceCompletedAt 은 TS 도 raw 통과시키고
///   lastErrorSummary 만 sanitize 한다(Stage-1 sanitize_error_summary 재사용).
fn build_retry_metadata(
    item: &BatchItem,
    retry_number: u64,
    max_retries: u64,
    delay_seconds: u64,
    now_ms: i64,
) -> Map<String, Value> {
    let next_ms = now_ms
        .saturating_add((delay_seconds.min(i64::MAX as u64 / 1_000) as i64).saturating_mul(1_000));
    let mut m = Map::new();
    m.insert("state".into(), json!("waiting"));
    m.insert("retryNumber".into(), json!(retry_number));
    m.insert("maxRetries".into(), json!(max_retries));
    m.insert("nextEligibleAt".into(), json!(iso_from_millis(next_ms)));
    m.insert("sourceRequestId".into(), item.source_request_id.clone());
    m.insert("sourceCompletedAt".into(), item.source_completed_at.clone());
    m.insert(
        "lastErrorSummary".into(),
        sanitize_error_summary(Some(&item.error_summary)).map_or(Value::Null, Value::String),
    );
    m
}

/// buildRetryMetadataPatch — 비객체 metadata 는 `{...snapshot}` 의 빈 스프레드에 근사한다.
fn patched_metadata(item: &BatchItem, retry_meta: Map<String, Value>, retry_number: u64) -> Value {
    let mut cleaned = item.metadata.as_object().cloned().unwrap_or_default();
    for k in STALE_KEYS {
        cleaned.remove(k);
    }
    cleaned.insert("workflowRetry".into(), Value::Object(retry_meta));
    // retryNumber-1 가 음수면 append 가 drop(TS isFiniteNonNegInt 동일) — i64 로 그대로 전달.
    let prev_number = i64::try_from(retry_number).unwrap_or(i64::MAX) - 1;
    let attempt = json!({
        "retryNumber": prev_number,
        "failedAt": item.source_completed_at,
        "errorSummary": sanitize_error_summary(Some(&item.error_summary)),
    });
    let attempts = append_retry_attempt(cleaned.get("workflowRetryAttempts"), &attempt);
    cleaned.insert(
        "workflowRetryAttempts".into(),
        serde_json::to_value(attempts).unwrap_or_default(),
    );
    Value::Object(cleaned)
}

fn classify_item(item: &BatchItem, now_ms: i64) -> Value {
    let policy = item
        .policy
        .clone()
        .unwrap_or_else(|| normalize_workflow_retry_policy(&item.policy_source));
    let decision = classify_workflow_step_retry(
        &WorkflowStepRetryClassificationInput {
            policy,
            step_run_status: item.step_run_status.clone(),
            retry_count: item.retry_count,
            is_control_node: item.is_control_node,
            step_type_supported: item.step_type_supported,
            is_qa_step: item.is_qa_step,
            qa_request_changes: item.qa_request_changes,
            recovery_active: item.recovery_active,
        },
        item.jitter_random,
    );
    match decision {
        WorkflowStepRetryDecision::Ineligible { reason, .. } => {
            json!({ "id": item.id, "eligible": false, "reason": reason })
        }
        WorkflowStepRetryDecision::Eligible {
            retry_number,
            max_retries,
            delay_seconds,
            ..
        } => {
            let retry_meta =
                build_retry_metadata(item, retry_number, max_retries, delay_seconds, now_ms);
            json!({
                "id": item.id,
                "eligible": true,
                "retryNumber": retry_number,
                "maxRetries": max_retries,
                "delaySeconds": delay_seconds,
                "retryMetadata": retry_meta.clone(),
                "metadata": patched_metadata(item, retry_meta, retry_number),
            })
        }
    }
}

/// classify-retry-batch 서브커맨드 — {nowIso, items[]} → {items:[판정(+패치)]}.
pub fn classify_retry_batch(raw: &[u8]) -> Result<Value, String> {
    let input: BatchInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let now_ms =
        parse_iso8601_millis(&input.now_iso).ok_or_else(|| "invalid nowIso".to_string())?;
    let items: Vec<Value> = input
        .items
        .iter()
        .map(|item| classify_item(item, now_ms))
        .collect();
    Ok(json!({ "items": items }))
}

#[cfg(test)]
#[rustfmt::skip] // fixture/기대값을 한 줄 raw-string JSON 으로 유지 — 읽기 표이 compact 해진다.
mod tests {
    use super::*;

    fn run(payload: &str) -> Value {
        classify_retry_batch(payload.as_bytes()).unwrap()
    }

    #[test]
    fn eligible_items_get_scheduler_shaped_metadata_patch() {
        let payload = r#"{"nowIso":"2026-11-20T00:00:00.000Z","items":[
            {"id":"sr1","policySource":{"onFailure":"retry","maxRetries":3,"graphRetryDelaySeconds":30,"graphRetryBackoff":"linear","graphRetryJitter":true},
             "stepRunStatus":"failed","retryCount":0,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false,
             "jitterRandom":0.5,"metadata":{"toolResult":{"x":1},"note":"keep","workflowRetryAttempts":[{"retryNumber":0,"errorSummary":"Bearer abc123token"}]},
             "sourceRequestId":"req-9","sourceCompletedAt":"2026-11-20T00:00:00.000Z","errorSummary":"Authorization: Bearer abc"},
            {"id":"sr2","policySource":{"onFailure":"abort_workflow"},"stepRunStatus":"failed","retryCount":0,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false}
        ]}"#;
        let out = run(payload);
        let (a, b) = (&out["items"][0], &out["items"][1]);
        // linear base30 n=1 → raw30, jitterRandom.5 → factor1.0 → delay30 → +30s.
        assert_eq!(a["delaySeconds"], json!(30));
        assert_eq!(a["retryMetadata"]["nextEligibleAt"], json!("2026-11-20T00:00:30.000Z"));
        assert_eq!(a["retryMetadata"]["lastErrorSummary"], json!("[REDACTED]"));
        assert_eq!(b["reason"], json!("disabled"));
        // patch: toolResult 삭제·note 보존·history 기존 1건+신규 1건(새 attempt 도 sanitize).
        let patched = &a["metadata"];
        assert!(patched.get("toolResult").is_none());
        assert_eq!(patched["note"], json!("keep"));
        assert_eq!(patched["workflowRetryAttempts"].as_array().unwrap().len(), 2);
        assert_eq!(patched["workflowRetryAttempts"][0]["errorSummary"], json!("Bearer [REDACTED]"));
    }

    #[test]
    fn delay_zero_keeps_next_eligible_at_at_now_and_cap_stays_86400() {
        let out = run(r#"{"nowIso":"2026-11-20T00:00:00.000Z","items":[
            {"id":"z","policy":{"enabled":true,"maxRetries":5,"delaySeconds":0,"backoff":"exponential","jitter":true},
             "stepRunStatus":"failed","retryCount":0,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false,"jitterRandom":0.9},
            {"id":"cap","policy":{"enabled":true,"maxRetries":9,"delaySeconds":100000,"backoff":"linear","jitter":false},
             "stepRunStatus":"failed","retryCount":0,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false}
        ]}"#);
        assert_eq!(out["items"][0]["delaySeconds"], json!(0));
        assert_eq!(out["items"][0]["retryMetadata"]["nextEligibleAt"], json!("2026-11-20T00:00:00.000Z"));
        assert_eq!(out["items"][1]["delaySeconds"], json!(86_400));
        assert_eq!(out["items"][1]["retryMetadata"]["nextEligibleAt"], json!("2026-11-21T00:00:00.000Z"));
    }

    #[test]
    fn ineligible_reasons_and_empty_batch() {
        let out = run(r#"{"nowIso":"2026-11-20T00:00:00.000Z","items":[
            {"id":"c","policy":{"enabled":true,"maxRetries":2,"delaySeconds":1,"backoff":"fixed","jitter":false},
             "stepRunStatus":"failed","retryCount":0,"isControlNode":true,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false},
            {"id":"x","policy":{"enabled":true,"maxRetries":2,"delaySeconds":1,"backoff":"fixed","jitter":false},
             "stepRunStatus":"failed","retryCount":2,"isControlNode":false,"stepTypeSupported":true,"isQaStep":false,"qaRequestChanges":false,"recoveryActive":false}
        ]}"#);
        assert_eq!(out["items"][0]["reason"], json!("control_node"));
        assert_eq!(out["items"][1]["reason"], json!("exhausted"));
        let empty = run(r#"{"nowIso":"2026-11-20T00:00:00.000Z","items":[]}"#);
        assert_eq!(empty["items"], json!([]));
        assert!(classify_retry_batch(br#"{"nowIso":"nope","items":[]}"#).is_err());
    }
}

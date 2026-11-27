//! [파일 목적] `paperclip-workflow-core` bin 의 S22 harness_gate 서브커맨드 end-to-end 테스트 — 컴파일된
//!   바이너리를 stdin JSON → stdout JSON 계약으로 실제 실행한다. 유닛 테스트(dispatch.rs)와 달리
//!   프로세스 경계·exit code·stderr 도 함께 검증한다. 기대값은 하드코딩(라이브러리로 재계산하지
//!   않음) — CLI 계약이 바뀌면 이 파일이 먼저 깨진다. 대상: main.rs → dispatch.rs → harness_gate/cli.rs.

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_paperclip-workflow-core");

fn spawn(subcommand: &str, payload: &str) -> Output {
    let mut child = Command::new(BIN)
        .arg(subcommand)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {BIN}: {e}"));
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(payload.as_bytes()).expect("write stdin");
    drop(stdin); // 닫아야 바이너리가 read_to_end 를 끝내고 응답한다.
    child.wait_with_output().expect("wait_for_output")
}

/// 성공 경로 — exit 0, stdout 는 단일 JSON 문서.
fn json_out(subcommand: &str, payload: &str) -> Value {
    let out = spawn(subcommand, payload);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stderr.is_empty(),
        "{subcommand} failed or wrote stderr: {stderr}"
    );
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{subcommand} stdout is not JSON ({e}): {stdout}"))
}

fn eq(subcommand: &str, payload: &str, expected: Value) {
    assert_eq!(json_out(subcommand, payload), expected, "{subcommand}");
}

fn close(actual: &Value, expected: f64) -> bool {
    actual.as_f64().is_some_and(|x| (x - expected).abs() < 1e-9)
}

const PRIOR: &str = r#"{"ewmaSuccess":2.0,"ewmaFail":1.0,"rawSamples":4,"consecutiveErrors":1}"#;

fn attribution(outcome: &str, verdict_pass: Option<bool>) -> String {
    let verdict = verdict_pass.map(|v| v.to_string()).unwrap_or("null".into());
    format!(
        r#"{{"prior":{PRIOR},"attribution":{{"runId":"run-1","stepRunId":"step-9","outcome":"{outcome}","verdictPass":{verdict},"stallDetected":false,"durationMs":1200}}}}"#
    )
}

#[test]
fn evaluate_dispatch_route_sharp_split_escalate() {
    // sharp: low risk && p >= θ(기본 0.7)
    eq(
        "evaluate-dispatch-route",
        r#"{"successProbability":0.94,"riskLevel":"low","consecutiveErrors":0}"#,
        json!({"route":"sharp","sharpThreshold":0.7,"forcedReason":null}),
    );
    // split: 동적 임계치 0.9 를 못 미침 → threshold 는 입력값으로 반영
    eq(
        "evaluate-dispatch-route",
        r#"{"sharpThreshold":0.9,"successProbability":0.85,"riskLevel":"low","consecutiveErrors":0}"#,
        json!({"route":"split","sharpThreshold":0.9,"forcedReason":null}),
    );
    // split: p 는 충분해도 risk 가 low 가 아니면 fast-path 불가
    eq(
        "evaluate-dispatch-route",
        r#"{"successProbability":0.99,"riskLevel":"high","consecutiveErrors":0}"#,
        json!({"route":"split","sharpThreshold":0.7,"forcedReason":null}),
    );
    // escalate: 연속 오류 2회 는 p·risk 와 무관하게 G2 강제
    eq(
        "evaluate-dispatch-route",
        r#"{"successProbability":0.99,"riskLevel":"low","consecutiveErrors":2}"#,
        json!({"route":"escalate_advisor","sharpThreshold":0.7,"forcedReason":"consecutive_errors>=2"}),
    );
}

#[test]
fn advisor_required_gate_priority_g2_over_g1_over_g3() {
    // G2 > G1: 계획 승인 대기여도 연속 오류 2회가 우선
    eq(
        "advisor-required-gate",
        r#"{"planPendingApproval":true,"consecutiveErrors":2,"verifierPassed":true}"#,
        json!({"gate":"g2_second_error"}),
    );
    // G1 > G3
    eq(
        "advisor-required-gate",
        r#"{"planPendingApproval":true,"consecutiveErrors":0,"verifierPassed":true}"#,
        json!({"gate":"g1_pre_plan"}),
    );
    // G3: verifier 통과만 해당
    eq(
        "advisor-required-gate",
        r#"{"planPendingApproval":false,"consecutiveErrors":0,"verifierPassed":true}"#,
        json!({"gate":"g3_pre_closeout"}),
    );
    // 해당 없음 → null (fail-closed: 자문 없이 진행 가능한 상태)
    eq(
        "advisor-required-gate",
        r#"{"planPendingApproval":false,"consecutiveErrors":1,"verifierPassed":false}"#,
        json!({"gate":null}),
    );
}

#[test]
fn advisor_checkpoint_valid_json_pass_and_challenge() {
    // pass: runId 트림, gate·verdict 구조 Echo
    eq(
        "advisor-checkpoint",
        r#"{"schemaVersion":1,"runId":" run-1 ","gate":"g1_pre_plan","decision":"pass"}"#,
        json!({"valid":true,"allowsProgress":true,"checkpoint":{"schemaVersion":1,"runId":"run-1","gate":"g1_pre_plan","verdict":{"decision":"pass"}}}),
    );
    // challenge: valid 문서지만 progress 불가, 공백 reason 은 "unspecified" 로 정규화
    let out = json_out(
        "advisor-checkpoint",
        r#"{"schemaVersion":1,"runId":"run-1","gate":"g3_pre_closeout","decision":"challenge","reason":"   "}"#,
    );
    assert_eq!(out["valid"], json!(true));
    assert_eq!(out["allowsProgress"], json!(false));
    assert_eq!(
        out["checkpoint"]["verdict"],
        json!({"decision":"challenge","reason":"unspecified"})
    );
}

#[test]
fn advisor_checkpoint_fails_closed_on_natural_language_and_bad_run_id() {
    // 자연어 판정은 JSON 안에 있어도 invalid_advisor_verdict — pass 로 해석되지 않는다.
    eq(
        "advisor-checkpoint",
        r#"{"schemaVersion":1,"runId":"run-1","gate":"g2_second_error","decision":"the plan looks good to me"}"#,
        json!({"valid":false,"allowsProgress":false,"error":"invalid_advisor_verdict"}),
    );
    // runId 부재/공백 → missing_run_id (문서가 다른 run 에 귀속되지 않게 fail-closed)
    for payload in [
        r#"{"schemaVersion":1,"gate":"g2_second_error","decision":"pass"}"#,
        r#"{"schemaVersion":1,"runId":"   ","gate":"g2_second_error","decision":"pass"}"#,
    ] {
        eq(
            "advisor-checkpoint",
            payload,
            json!({"valid":false,"allowsProgress":false,"error":"missing_run_id"}),
        );
    }
    // 아예 JSON 이 아닌 자연어 stdin → exit 1, stdout 없음, stderr 에 오류
    let out = spawn("advisor-checkpoint", "advisor approved this plan, go ahead");
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(!out.stderr.is_empty());
}

#[test]
fn apply_step_attribution_ewma_posterior_update() {
    // 성공 w=1: ewmaSuccess = 2.0·0.92 + 1, ewmaFail = 1.0·0.92, 연속 오류 리셋
    let out = json_out("apply-step-attribution", &attribution("ok", None));
    assert_eq!(out["runId"], json!("run-1"));
    assert_eq!(out["stepRunId"], json!("step-9"));
    assert_eq!(out["kind"], json!("success"));
    assert_eq!(out["recorded"], json!(true));
    assert_eq!(out["weight"], json!(1.0));
    assert_eq!(out["prior"]["rawSamples"], json!(5));
    assert_eq!(out["prior"]["consecutiveErrors"], json!(0));
    assert!(close(&out["prior"]["ewmaSuccess"], 2.0 * 0.92 + 1.0));
    assert!(close(&out["prior"]["ewmaFail"], 1.0 * 0.92));

    // verifier 반려 w=2: ewmaFail = 1.0·0.92 + 2.0, 연속 오류 1 → 2
    let out = json_out("apply-step-attribution", &attribution("ok", Some(false)));
    assert_eq!(out["kind"], json!("failed"));
    assert_eq!(out["weight"], json!(2.0));
    assert_eq!(out["prior"]["rawSamples"], json!(5));
    assert_eq!(out["prior"]["consecutiveErrors"], json!(2));
    assert!(close(&out["prior"]["ewmaSuccess"], 2.0 * 0.92));
    assert!(close(&out["prior"]["ewmaFail"], 1.0 * 0.92 + 2.0));
}

#[test]
fn apply_step_attribution_isolates_skipped_and_interrupted() {
    // 환경류 결과는 EWMA·카운터·표본수를 전부 불변(recorded=false) — 호출자는 재배차 경로로.
    for outcome in ["skipped", "interrupted"] {
        let out = json_out("apply-step-attribution", &attribution(outcome, None));
        assert_eq!(out["kind"], json!("isolated"), "{outcome}");
        assert_eq!(out["recorded"], json!(false), "{outcome}");
        assert_eq!(out["weight"], json!(0.0), "{outcome}");
        assert_eq!(
            out["prior"],
            serde_json::from_str::<Value>(PRIOR).unwrap(),
            "{outcome}"
        );
    }
}

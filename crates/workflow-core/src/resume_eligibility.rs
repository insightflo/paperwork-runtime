//! [파일 목적] resume/eligibility.ts + dag-step-priority.ts 의 Rust 포트 (Stage 7C)
//!   — check-step-eligibility / sort-steps-by-priority 서브커맨드.
//! [parity] checkStepEligibility: `stuck === true` 엄격(bool 만), `f !== null` 은
//!   부재(undefined)도 !== null 이라 true, hasAttempt/hasQueue/hasOwner/hasExternalResult 는
//!   JS truthy(빈 배열·객체도 true, ±0·"" 는 false), status/kind/effect 는 === 문자열
//!   비교 — agent|tool 이 아닌 kind(비문자열·부재 포함)는 전부 control 경로. 비객체
//!   history 는 모든 필드 undefined 로 흘러 unsupported_status, null/부재 history 만
//!   TypeError → Err. sortWorkflowStepsByPriority: [...steps] 는 배열 복사·문자열
//!   code-point 순회만 iterable(그 외 TypeError), `step.executionControls?.priority`
//!   는 step null 에서만 TypeError — comparator 는 len>=2 일 때만 호출되므로 [null]
//!   단독은 통과. 정렬은 rank 내림차 안정 정렬(JS TimSort ≡ Rust sort_by).
//! [외부 연결] consumer: main.rs dispatch — `{"history":{...}}` → `{"blocker":str|null}`,
//!   `{"steps":[...]}` → `{"steps":[...]}`.

use serde_json::{json, Value};

/// `history.<key>` — 비객체(원시·배열) 기반 필드는 undefined. null/부재 history 는
///   호출부에서 Err 로 먼저 걸러진다.
fn field<'a>(h: &'a Value, key: &str) -> Option<&'a Value> {
    h.as_object().and_then(|o| o.get(key))
}

/// `v === "<s>"` — 문자열 엄격 비교(비문자열·부재는 항상 false).
fn str_eq(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::String(x)) if x == s)
}

/// JS truthy — undefined/null/false/±0/"" 만 false. 빈 배열·객체는 JS 에서 truthy.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `v !== null` — undefined(필드 부재)도 !== null 이므로 true. null 만 false.
fn not_null(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Null))
}

/// checkStepEligibility — TS 와 동일한 규칙 순서:
///   1) running(비stuck)→active_work, completed→executed_step,
///      pending/failed/skipped 외→unsupported_status, hasOwner(비stuck)→active_work.
///   2) agent|tool: pending+기록 흔적(issueId|startedAt !==null, hasAttempt/hasQueue/
///      hasExternalResult truthy)→executed_step; effect==="unknown"→external_effect_unknown;
///      그 외(알려진 effect)는 null 적격.
///   3) 그 외 kind(control 경로): issueId|hasExternalResult→executed_step;
///      effect external|unknown→control_tool_effects_unverified;
///      pending+잔존 흔적(startedAt|hasAttempt|hasQueue)→executed_step.
fn eligibility(h: &Value) -> Option<&'static str> {
    let f = |k: &str| field(h, k);
    let status = f("status");
    // stuck 은 running 에만 의미가 있고 `=== true` 여야 한다(1·"true" 등은 무시).
    let stuck = matches!(f("stuck"), Some(Value::Bool(true))) && str_eq(status, "running");
    if str_eq(status, "running") && !stuck {
        return Some("active_work");
    }
    if str_eq(status, "completed") {
        return Some("executed_step");
    }
    let resumable = matches!(
        status.and_then(Value::as_str),
        Some("pending" | "failed" | "skipped")
    );
    if !stuck && !resumable {
        return Some("unsupported_status");
    }
    if truthy(f("hasOwner")) && !stuck {
        return Some("active_work");
    }

    if str_eq(f("kind"), "agent") || str_eq(f("kind"), "tool") {
        let has_recorded = not_null(f("issueId"))
            || not_null(f("startedAt"))
            || truthy(f("hasAttempt"))
            || truthy(f("hasQueue"))
            || truthy(f("hasExternalResult"));
        if has_recorded && str_eq(status, "pending") {
            return Some("executed_step");
        }
        if str_eq(f("effect"), "unknown") {
            return Some("external_effect_unknown");
        }
        return None;
    }

    // agent|tool 이 아닌 kind 는 전부 control 경로(control 포함, TS 와 동일).
    if not_null(f("issueId")) || truthy(f("hasExternalResult")) {
        return Some("executed_step");
    }
    if str_eq(f("effect"), "external") || str_eq(f("effect"), "unknown") {
        return Some("control_tool_effects_unverified");
    }
    if str_eq(status, "pending")
        && (not_null(f("startedAt")) || truthy(f("hasAttempt")) || truthy(f("hasQueue")))
    {
        return Some("executed_step");
    }
    None
}

/// workflowPriorityRank — switch === 라 대소문자·공백 변형은 0. priority 비문자열이거나
///   executionControls/step 이 비객체이면(`?.` 경유) 0. step null 은 호출부 Err.
fn priority_rank(step: &Value) -> i64 {
    let Some(p) = step
        .as_object()
        .and_then(|o| o.get("executionControls"))
        .and_then(Value::as_object)
        .and_then(|o| o.get("priority"))
    else {
        return 0;
    };
    match p.as_str() {
        Some("critical") => 4,
        Some("high") => 3,
        Some("normal") => 2,
        Some("low") => 1,
        _ => 0,
    }
}

pub fn check_step_eligibility(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    // history 부재(undefined)/null — `history.stuck` 접근이 TypeError.
    let h = input
        .get("history")
        .ok_or_else(|| "cannot read properties of undefined".to_string())?;
    if h.is_null() {
        return Err("cannot read properties of null".to_string());
    }
    Ok(json!({ "blocker": eligibility(h) }))
}

pub fn sort_steps_by_priority(raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    // [...steps] — JSON 도메인에서 iterable 은 배열(복사)·문자열(code-point 순회)뿐.
    let mut steps: Vec<Value> = match input.get("steps") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        _ => return Err("steps is not iterable".to_string()),
    };
    // comparator 는 len>=2 에서만 호출된다 — null 요소의 `.executionControls` TypeError 경계.
    if steps.len() > 1 && steps.iter().any(Value::is_null) {
        return Err("cannot read properties of null".to_string());
    }
    steps.sort_by_key(|s| std::cmp::Reverse(priority_rank(s)));
    Ok(json!({ "steps": steps }))
}

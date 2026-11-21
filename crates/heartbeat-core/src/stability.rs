//! Stage 2 ports: heartbeat-stability.ts (env knobs + run-stability helpers),
//! heartbeat-run-context.ts, heartbeat-session-reset.ts and
//! heartbeat-output-validation.ts — pure functions only (no DB/process).
//! [JS parity] missing `env` -> real process env (TS `= process.env` default);
//! `env` null -> Err; non-string non-null env values -> Err (`.trim()` throw).
//! JS `iu` folds -> (?i)+ASCII (?-u:\b); `\s` -> JS_WS set; `^$` (no m) -> \A\z.
//! json!() emits non-finite numbers as null = JSON.stringify.
use crate::js;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

const JS_WS: &str =
    r"\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

fn re(p: &str) -> Regex {
    Regex::new(p).expect("static regex")
}

/// One static per ported JS RegExp, hand-compacted for the 300-line limit.
#[rustfmt::skip]
mod pat {
    use super::*;
    /// `\b(...)\b/iu` title heuristics — iu fold == native (?i).
    pub static SKIP_TITLE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)(lead|approval|approve|audit|auditor|validator|validation|validate|verify|QA|review|check)(?-u:\b)"));
    pub static DELIVERABLE_TITLE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)(synthesi[sz]e|synthesis|generate|produce|create|draft|artifact|document|note|infographic|export|deliver|html|pdf|report)(?-u:\b)"));
    /// `/(...)/u` — case-SENSITIVE (no i flag): only uppercase HTML/PDF match.
    pub static KO_TITLE: LazyLock<Regex> = LazyLock::new(|| re(r"(작성|생성|제작|산출물|문서|자료|보고서|리포트|HTML|PDF)"));
    /// `/`?\[?ARTIFACT\]?`?\s*:/iu` — `\s` is the JS whitespace set.
    pub static ARTIFACT_CONTRACT: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)`?\[?ARTIFACT\]?`?[{JS_WS}]*:")));
    /// `/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u` — JS `^$` are absolute (no m).
    pub static QA_TYPE: LazyLock<Regex> = LazyLock::new(|| re(r"\A[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*\z"));
}
use pat::*;

/// Env source: missing `env` -> real process env (TS `= process.env` default);
/// `env` null -> Err; other non-objects read every key as undefined.
enum Env<'a> {
    Real,
    Json(&'a Value),
}

/// `env[key]` -> Err on non-string non-null (the `.trim()` TypeError).
#[rustfmt::skip]
fn env_opt(src: &Env, key: &str) -> Result<Option<String>, String> {
    match src {
        Env::Real => Ok(std::env::var(key).ok()),
        Env::Json(v) => match v.get(key) { None | Some(Value::Null) => Ok(None), Some(Value::String(s)) => Ok(Some(s.clone())), Some(_) => Err(format!("env.{key}.trim is not a function")) },
    }
}

/// resolve*(env): trimmed "0" disables; positive finite Number -> floor*scale.
#[rustfmt::skip]
fn env_int(src: &Env, key: &str, scale: f64, default: f64) -> Result<f64, String> {
    let raw = env_opt(src, key)?.map_or_else(String::new, |s| js::js_trim(&s).to_string());
    if raw == "0" { return Ok(0.0); }
    let n = js::js_str_to_num(&raw);
    Ok(if n.is_finite() && n > 0.0 { n.floor() * scale } else { default })
}

/// provider-403 gating: unset/null -> default; ""/0/off/none -> disabled.
#[rustfmt::skip]
enum Gate {
    Default,
    Disabled,
    Csv(String),
}

fn p403_gate(src: &Env, key: &str) -> Result<Gate, String> {
    let Some(raw) = env_opt(src, key)? else {
        return Ok(Gate::Default);
    };
    let t = js::js_trim(&raw);
    if t.is_empty() || t == "0" || matches!(t.to_lowercase().as_str(), "off" | "none") {
        return Ok(Gate::Disabled);
    }
    Ok(Gate::Csv(t.to_string()))
}

/// resolveProvider403RetryDelaysMin — CSV of parseInt(.,10) positive integers.
#[rustfmt::skip]
fn p403_delays(src: &Env) -> Result<Value, String> {
    Ok(match p403_gate(src, "PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN")? {
        Gate::Default => json!([5, 15, 30]),
        Gate::Disabled => json!([]),
        Gate::Csv(t) => json!(t.split(',').map(js::js_parse_int10)
            .filter(|v| v.is_finite() && v.trunc() == *v && *v > 0.0)
            .collect::<Vec<f64>>()),
    })
}

/// resolveProvider403LadderReasonCodes — tokens trim().toUpperCase(), deduped.
#[rustfmt::skip]
fn p403_codes(src: &Env) -> Result<Value, String> {
    Ok(match p403_gate(src, "PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES")? {
        Gate::Default => json!(["PROVIDER_AUTH_OR_FORBIDDEN_403", "PROVIDER_QUOTA_OR_AUTH_403"]),
        Gate::Disabled => json!([]),
        Gate::Csv(t) => {
            let mut out: Vec<String> = Vec::new();
            for tok in t.split(',').map(|s| js::js_trim(s).to_uppercase()) {
                if !tok.is_empty() && !out.contains(&tok) { out.push(tok); }
            }
            json!(out)
        }
    })
}

/// `stability-env` — all eight env-resolved knobs in one bundle (evaluated in
/// TS source order; the first TypeError propagates).
#[rustfmt::skip]
pub fn stability_env(input: &Value) -> Result<Value, String> {
    let src = match input.get("env") {
        None => Env::Real,
        Some(Value::Null) => return Err("Cannot read properties of null".into()),
        Some(v) => Env::Json(v),
    };
    // adapterConfig.runawayLogLimitBytes (finite number) wins over env.
    let runaway = match js::prop(input.get("adapterConfig"), "runawayLogLimitBytes") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => n.as_f64().unwrap_or(0.0).floor().max(0.0),
        _ => env_int(&src, "PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES", 1.0, 16_777_216.0)?,
    };
    Ok(json!({
        "qaStepActiveExecutionTimeoutMs": env_int(&src, "PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS", 1000.0, 1_800_000.0)?,
        "runawayLogLimitBytes": runaway,
        "adapterFailedTransientRetryMaxSec": env_int(&src, "PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC", 1.0, 300.0)?,
        "noProgressAdvisoryThreshold": env_int(&src, "PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD", 1.0, 2.0)?,
        "noProgressAutoBlockThreshold": env_int(&src, "PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD", 1.0, 3.0)?,
        "noProgressWindowMs": env_int(&src, "PAPERCLIP_NO_PROGRESS_WINDOW_SEC", 1000.0, 21_600_000.0)?,
        "provider403RetryDelaysMin": p403_delays(&src)?,
        "provider403ReasonCodes": p403_codes(&src)?,
    }))
}

/// `run-context` — readNonEmptyString / deriveTaskKey /
/// resolveAdapterFallbackAttempt / normalizeAgentNameKey / isSameTaskScope.
/// None can throw: every read is `?.`-guarded or type-guarded.
#[rustfmt::skip]
pub fn run_context(input: &Value) -> Value {
    let pick = |src: Option<&Value>| ["taskKey", "taskId", "issueId"].iter()
        .find_map(|k| js::read_nonempty_trimmed(js::prop(src, k)));
    // parseObject(contextRaw): only real objects keep their fields.
    let ctx = input.get("contextRaw").filter(|v| v.is_object());
    let fb = finite_floor(ctx.and_then(|v| v.get("fallbackAttempt")));
    json!({
        "readNonEmptyString": js::read_nonempty_trimmed(input.get("value")),
        "taskKey": pick(input.get("contextSnapshot")).or_else(|| pick(input.get("payload"))),
        "fallbackAttempt": if fb.is_finite() && fb > 0.0 { fb } else { 0.0 },
        "agentNameKey": js::read_nonempty_trimmed(input.get("agentName")).map(|s| s.to_lowercase()),
        "sameTaskScope": js::js_nullish_eq(input.get("left"), input.get("right")),
    })
}

/// `session-reset` — hasWorkflowQaReworkContract /
/// shouldResetTaskSessionForWake / describeSessionResetReason. TS asymmetry
/// kept: "mission_owner_planning_issue_created" resets but describes null.
#[rustfmt::skip]
pub fn session_reset(input: &Value) -> Value {
    let ctx = input.get("contextSnapshot");
    let force = js::prop(ctx, "forceFreshSession") == Some(&Value::Bool(true));
    let contract = js::prop(ctx, "paperclipWorkflowReworkContract").filter(|v| v.is_object());
    let rework = js::read_nonempty_trimmed(contract.and_then(|v| v.get("kind"))).as_deref() == Some("workflow_qa_rework");
    let wake = js::read_nonempty_trimmed(js::prop(ctx, "wakeReason"));
    let should = force || rework
        || matches!(wake.as_deref(), Some("issue_assigned" | "mission_owner_planning_issue_created" | "mission_unblock_action_created" | "mission_unblock_action_stalled"));
    let reason = match (force, rework, wake.as_deref()) {
        (true, _, _) => Some("forceFreshSession was requested"),
        (false, true, _) => Some("workflow QA rework requires a fresh session"),
        (false, false, Some("issue_assigned")) => Some("wake reason is issue_assigned"),
        (false, false, Some("mission_unblock_action_created")) => Some("wake reason is mission_unblock_action_created"),
        (false, false, Some("mission_unblock_action_stalled")) => Some("wake reason is mission_unblock_action_stalled"),
        _ => None,
    };
    json!({"hasQaReworkContract": rework, "shouldReset": should, "reason": reason})
}

/// `v?.trim() ?? ""` — TypeError on non-string non-null (`?.` guards nullish).
#[rustfmt::skip]
fn trim_or_empty(v: Option<&Value>, err: &str) -> Result<String, String> {
    match v { None | Some(Value::Null) => Ok(String::new()), Some(Value::String(s)) => Ok(js::js_trim(s).to_string()), Some(_) => Err(err.into()) }
}

/// canApplyMissingWorkProductRegistrationGate — originKind exclusions, the
/// explicit stepRunRequiresWorkProduct flag, then title/description
/// heuristics in TS order (non-string title/description -> TypeError).
#[rustfmt::skip]
fn gate(issue: &Value, flag: Option<&Value>) -> Result<bool, String> {
    if matches!(issue.get("originKind").and_then(Value::as_str),
        Some("mission_main_executor_plan" | "mission_main_executor_oversight" | "mission_main_executor_unblock"))
        || flag == Some(&Value::Bool(false))
    {
        return Ok(false);
    }
    if flag == Some(&Value::Bool(true)) {
        return Ok(true);
    }
    let title = trim_or_empty(issue.get("title"), "issue.title?.trim is not a function")?;
    let t_iu = title.replace('\u{017f}', "s").replace('\u{212a}', "k");
    if SKIP_TITLE.is_match(&t_iu) { return Ok(false); }
    let desc = trim_or_empty(issue.get("description"), "desc?.trim is not a function")?;
    Ok((desc.contains("Deliverable output (use exactly this directory)") && ARTIFACT_CONTRACT.is_match(&desc))
        || DELIVERABLE_TITLE.is_match(&t_iu) || KO_TITLE.is_match(&title))
}

/// `output-validation` — gate(issue, stepRunRequiresWorkProduct) +
/// resolveStepRunRequiresWorkProduct(metadata). `issue` absent/null ->
/// TypeError; stepRequires omitted when undefined (matching JSON.stringify).
#[rustfmt::skip]
pub fn output_validation(input: &Value) -> Result<Value, String> {
    let issue = input.get("issue").filter(|v| !v.is_null()).ok_or("Cannot read properties of null/undefined")?;
    let mut out = serde_json::Map::new();
    out.insert("gate".into(), Value::Bool(gate(issue, input.get("stepRunRequiresWorkProduct"))?));
    if let Some(sr) = input.get("metadata").filter(|v| v.is_object())
        .and_then(|v| v.get("graphWorkProductRequired")).filter(|v| v.is_boolean()).cloned() {
        out.insert("stepRequires".into(), sr);
    }
    Ok(Value::Object(out))
}

/// `typeof v === "number" && Number.isFinite(v)` -> floor, else 0.
fn finite_floor(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
        .floor()
}

/// workflow-step-role isQaLikeStep: qaType matching the QA-type pattern, or
/// trim().toLowerCase() type in {qa, validation, validator}.
#[rustfmt::skip]
fn is_qa_like(step: &Value) -> bool {
    let norm = |v: Option<&Value>| js::js_trim(v.and_then(Value::as_str).unwrap_or("")).to_lowercase();
    QA_TYPE.is_match(&norm(step.get("qaType")))
        || matches!(norm(step.get("type")).as_str(), "qa" | "validation" | "validator")
}

/// resolveStepAwareActiveExecutionTimeoutMs — an absent base flows through as
/// `undefined`: nullish contract -> key dropped (JSON.stringify), truthy
/// contract -> Math.max(_, NaN) -> NaN -> null.
#[rustfmt::skip]
fn step_aware(input: &Value) -> Option<Value> {
    let base = input.get("baseMs");
    let base_n = js::js_number(base);
    if base_n <= 0.0 { return Some(json!(0.0)); }
    let Some(c) = input.get("contract").filter(|c| c.is_object()) else { return base.cloned(); };
    let st = finite_floor(c.get("stepTimeoutSeconds"));
    if st > 0.0 { return Some(json!(js::js_max(base_n, st * 1000.0))); }
    let qa = js::js_number(input.get("qaStepActiveExecutionTimeoutMs"));
    if c.get("isQaStep") == Some(&Value::Bool(true)) && qa > 0.0 { return Some(json!(js::js_max(base_n, qa))); }
    base.cloned()
}

/// `stability-compute` — resolveRunawayAdvisorySoftBytes /
/// resolveStepAwareActiveExecutionTimeoutMs / stepTimeoutSignalsFromStep.
#[rustfmt::skip]
pub fn stability_compute(input: &Value) -> Result<Value, String> {
    let limit = js::js_number(input.get("runawayLogLimitBytes"));
    let soft = if limit > 0.0 { (limit * 0.6).floor().max(1_048_576.0).min(limit) } else { 0.0 };
    let step = input.get("step").filter(|v| !v.is_null()).ok_or("Cannot read properties of null/undefined")?;
    let mut out = serde_json::Map::new();
    out.insert("runawayAdvisorySoftBytes".into(), json!(soft));
    if let Some(v) = step_aware(input) { out.insert("stepAwareTimeoutMs".into(), v); }
    out.insert("stepTimeoutSignals".into(), json!({
        "stepTimeoutSeconds": finite_floor(step.get("timeoutSeconds")).max(0.0),
        "isQaStep": is_qa_like(step),
    }));
    Ok(Value::Object(out))
}

#[rustfmt::skip]
fn need_arr<'a>(v: Option<&'a Value>, err: &str) -> Result<&'a Vec<Value>, String> {
    if let Some(Value::Array(a)) = v { Ok(a) } else { Err(err.into()) }
}

/// Epoch-ms coercion: numbers pass through, everything else -> NaN.
#[rustfmt::skip]
fn ms(v: Option<&Value>) -> f64 { v.and_then(Value::as_f64).unwrap_or(f64::NAN) }

/// `progress-evidence` — hasRunProgressEvidence. `.has`/`.some` on non-array
/// fields and a nullish `run` are TypeErrors; order mirrors TS evaluation.
#[rustfmt::skip]
pub fn progress_evidence(input: &Value) -> Result<Value, String> {
    let wpr = need_arr(input.get("workProductRunIds"), "workProductRunIds.has is not a function")?;
    let run = input.get("run").filter(|v| !v.is_null()).ok_or("Cannot read properties of null/undefined")?;
    let id = run.get("id");
    let has = |a: &[Value]| id.is_some_and(|i| a.iter().any(|v| js::js_nullish_eq(Some(v), Some(i))));
    if has(wpr) || has(need_arr(input.get("transitionRunIds"), "transitionRunIds.has is not a function")?) {
        return Ok(json!(true));
    }
    let ws = match run.get("startedAt") { None | Some(Value::Null) => ms(run.get("createdAt")), v => ms(v) };
    let we = match run.get("finishedAt") { None | Some(Value::Null) => ws, v => ms(v) };
    let act = need_arr(input.get("agentCommentTimestamps"), "agentCommentTimestamps.some is not a function")?;
    Ok(json!(act.iter().any(|t| { let n = ms(Some(t)); n >= ws && n <= we })))
}

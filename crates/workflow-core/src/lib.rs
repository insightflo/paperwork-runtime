use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

pub const MAX_RETRY_DELAY_SECONDS: u64 = 86_400;
const FAILURE_SUMMARY_MAX: usize = 500;
const METADATA_STRING_MAX: usize = 500;
const MAX_ATTEMPT_HISTORY: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowRetryBackoff {
    Fixed,
    Linear,
    Exponential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRetryPolicy {
    pub enabled: bool,
    pub max_retries: u64,
    pub delay_seconds: u64,
    pub backoff: WorkflowRetryBackoff,
    pub jitter: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRetryPolicySource {
    pub on_failure: Option<Value>,
    pub max_retries: Option<Value>,
    pub graph_retry_delay_seconds: Option<Value>,
    pub graph_retry_backoff: Option<Value>,
    pub graph_retry_jitter: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WorkflowStepRetryDecision {
    Eligible {
        eligible: bool,
        #[serde(rename = "retryNumber")]
        retry_number: u64,
        #[serde(rename = "maxRetries")]
        max_retries: u64,
        #[serde(rename = "delaySeconds")]
        delay_seconds: u64,
    },
    Ineligible {
        eligible: bool,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepRetryClassificationInput {
    pub policy: WorkflowRetryPolicy,
    pub step_run_status: Value,
    pub retry_count: f64,
    pub is_control_node: bool,
    pub step_type_supported: bool,
    pub is_qa_step: bool,
    pub qa_request_changes: bool,
    pub recovery_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRetryAttemptSummary {
    pub retry_number: u64,
    pub failed_at: Option<String>,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRetryMetadata {
    pub state: String,
    pub retry_number: u64,
    pub max_retries: u64,
    pub next_eligible_at: String,
    pub source_request_id: Option<String>,
    pub source_completed_at: Option<String>,
    pub last_error_summary: Option<String>,
}

fn finite_nonneg_floor_u64(v: Option<&Value>, default: u64) -> u64 {
    match v {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() && f >= 0.0 => {
                let fl = f.floor();
                if fl >= u64::MAX as f64 {
                    u64::MAX
                } else {
                    fl as u64
                }
            }
            _ => default,
        },
        _ => default,
    }
}

pub fn normalize_workflow_retry_policy(source: &WorkflowRetryPolicySource) -> WorkflowRetryPolicy {
    let on_failure = source
        .on_failure
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let enabled = on_failure == "retry";
    let max_retries = finite_nonneg_floor_u64(source.max_retries.as_ref(), 2);
    let delay_seconds = finite_nonneg_floor_u64(source.graph_retry_delay_seconds.as_ref(), 0);
    let raw_backoff = source
        .graph_retry_backoff
        .as_ref()
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase());
    let backoff = match raw_backoff.as_deref() {
        Some("linear") => WorkflowRetryBackoff::Linear,
        Some("exponential") => WorkflowRetryBackoff::Exponential,
        _ => WorkflowRetryBackoff::Fixed,
    };
    let jitter = source.graph_retry_jitter.as_ref().and_then(Value::as_bool) == Some(true);
    WorkflowRetryPolicy {
        enabled: enabled && max_retries > 0,
        max_retries,
        delay_seconds,
        backoff,
        jitter,
    }
}

pub fn calculate_workflow_retry_delay_seconds(
    delay_seconds: u64,
    backoff: WorkflowRetryBackoff,
    jitter: bool,
    retry_number: u64,
    random_sample: f64,
) -> u64 {
    if delay_seconds == 0 {
        return 0;
    }
    let n = retry_number.max(1);
    let base = delay_seconds as f64;
    let mut raw = match backoff {
        WorkflowRetryBackoff::Fixed => base,
        WorkflowRetryBackoff::Linear => base * (n as f64),
        WorkflowRetryBackoff::Exponential => {
            base * 2_f64.powi(i32::try_from(n.saturating_sub(1)).unwrap_or(i32::MAX))
        }
    };
    if jitter {
        raw *= 0.8 + random_sample * 0.4;
    }
    if raw.is_nan() || raw <= 0.0 {
        return 0;
    }
    if raw.is_infinite() || raw.floor() >= MAX_RETRY_DELAY_SECONDS as f64 {
        return MAX_RETRY_DELAY_SECONDS;
    }
    raw.floor() as u64
}

pub fn classify_workflow_step_retry(
    input: &WorkflowStepRetryClassificationInput,
    random_sample: f64,
) -> WorkflowStepRetryDecision {
    if input.is_control_node {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "control_node",
        };
    }
    if !input.step_type_supported {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "unsupported_step",
        };
    }
    if !input.policy.enabled {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "disabled",
        };
    }
    if input.step_run_status.as_str() != Some("failed") {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "malformed_state",
        };
    }
    if input.is_qa_step && input.qa_request_changes {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "qa_rework",
        };
    }
    if input.recovery_active {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "recovery_active",
        };
    }
    let retry_count = if input.retry_count.is_finite() && input.retry_count >= 0.0 {
        if input.retry_count >= u64::MAX as f64 {
            u64::MAX
        } else {
            input.retry_count as u64
        }
    } else {
        0
    };
    let next_retry_number = retry_count.saturating_add(1);
    if next_retry_number > input.policy.max_retries {
        return WorkflowStepRetryDecision::Ineligible {
            eligible: false,
            reason: "exhausted",
        };
    }
    let delay_seconds = calculate_workflow_retry_delay_seconds(
        input.policy.delay_seconds,
        input.policy.backoff,
        input.policy.jitter,
        next_retry_number,
        random_sample,
    );
    WorkflowStepRetryDecision::Eligible {
        eligible: true,
        retry_number: next_retry_number,
        max_retries: input.policy.max_retries,
        delay_seconds,
    }
}

struct RedactPatterns {
    auth_header: Regex,
    bearer: Regex,
    sk_token: Regex,
    password: Regex,
    secret: Regex,
    json_field: Regex,
    whitespace: Regex,
}

fn patterns() -> &'static RedactPatterns {
    static PATTERNS: OnceLock<RedactPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| RedactPatterns {
        auth_header: Regex::new(r"(?i)(?:authorization|auth|x-api-key|apikey|api-key)\s*[:=]\s*(?:bearer\s+|token\s+)?\S+").unwrap(),
        bearer: Regex::new(r"(?i)(?-u:\b)Bearer\s+[A-Za-z0-9\-._~+/]+=*").unwrap(),
        sk_token: Regex::new(r"(?i)(?-u:\b)sk-[A-Za-z0-9]{20,}").unwrap(),
        password: Regex::new(r"(?i)(?:password|passwd|pwd)\s*[:=]\s*\S+").unwrap(),
        secret: Regex::new(r"(?i)(?:secret|token|access_key|accesskey|private_key)\s*[:=]\s*\S+").unwrap(),
        json_field: Regex::new(r#"(?i)(["'](?:api_key|apikey|secret|token|password|private_key)["']\s*:\s*["'])[^"']*(["'])"#).unwrap(),
        whitespace: Regex::new(r"\s+").unwrap(),
    })
}

fn js_to_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => js_to_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn collapse_and_bound(raw: &str, max_chars: usize) -> Option<String> {
    let no_ctrl: String = raw
        .chars()
        .map(|c| {
            if (c as u32) <= 0x1F || (c as u32) == 0x7F {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = patterns().whitespace.replace_all(&no_ctrl, " ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(max_chars).collect())
    }
}

fn bounded_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => collapse_and_bound(s, METADATA_STRING_MAX),
        _ => None,
    }
}

pub fn sanitize_error_summary(value: Option<&Value>) -> Option<String> {
    let raw = js_to_string(value);
    let trimmed_start = raw.trim();
    if ((trimmed_start.starts_with('{') && trimmed_start.ends_with('}'))
        || (trimmed_start.starts_with('[') && trimmed_start.ends_with(']')))
        && serde_json::from_str::<Value>(trimmed_start).is_ok()
    {
        return Some("[structured payload]".to_string());
    }
    let p = patterns();
    let r1 = p.auth_header.replace_all(&raw, "[REDACTED]");
    let r2 = p.bearer.replace_all(&r1, "Bearer [REDACTED]");
    let r3 = p.sk_token.replace_all(&r2, "[REDACTED]");
    let r4 = p.password.replace_all(&r3, "[REDACTED]");
    let r5 = p.secret.replace_all(&r4, "[REDACTED]");
    let r6 = p.json_field.replace_all(&r5, "${1}[REDACTED]${2}");
    collapse_and_bound(&r6, FAILURE_SUMMARY_MAX)
}

fn parse_non_neg_int(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(n)) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0 && f.fract() == 0.0)
                .map(|f| f as u64)
        }),
        _ => None,
    }
}

pub fn append_retry_attempt(
    history: Option<&Value>,
    attempt: &Value,
) -> Vec<WorkflowRetryAttemptSummary> {
    let mut sanitized = Vec::new();
    if let Some(Value::Array(arr)) = history {
        for obj in arr.iter().filter_map(Value::as_object) {
            if let Some(retry_number) = parse_non_neg_int(obj.get("retryNumber")) {
                sanitized.push(WorkflowRetryAttemptSummary {
                    retry_number,
                    failed_at: bounded_string(obj.get("failedAt")),
                    error_summary: sanitize_error_summary(obj.get("errorSummary")),
                });
            }
        }
    }
    if let Some(obj) = attempt.as_object() {
        if let Some(retry_number) = parse_non_neg_int(obj.get("retryNumber")) {
            sanitized.push(WorkflowRetryAttemptSummary {
                retry_number,
                failed_at: bounded_string(obj.get("failedAt")),
                error_summary: sanitize_error_summary(obj.get("errorSummary")),
            });
        }
    }
    if sanitized.len() > MAX_ATTEMPT_HISTORY {
        sanitized.drain(..sanitized.len() - MAX_ATTEMPT_HISTORY);
    }
    sanitized
}

pub fn read_workflow_retry_metadata(metadata: Option<&Value>) -> Option<WorkflowRetryMetadata> {
    let obj = metadata?.as_object()?;
    let state = obj.get("state").and_then(Value::as_str)?;
    if state != "waiting" && state != "dispatching" {
        return None;
    }
    let retry_number = parse_non_neg_int(obj.get("retryNumber")).filter(|n| *n >= 1)?;
    let max_retries = parse_non_neg_int(obj.get("maxRetries")).filter(|m| *m >= retry_number)?;
    let next_eligible_at = obj.get("nextEligibleAt").and_then(Value::as_str)?;
    parse_iso8601_millis(next_eligible_at)?;
    Some(WorkflowRetryMetadata {
        state: state.to_string(),
        retry_number,
        max_retries,
        next_eligible_at: next_eligible_at.to_string(),
        source_request_id: bounded_string(obj.get("sourceRequestId")),
        source_completed_at: bounded_string(obj.get("sourceCompletedAt")),
        last_error_summary: sanitize_error_summary(obj.get("lastErrorSummary")),
    })
}

pub fn is_workflow_retry_due(metadata: Option<&Value>, now_ms: i64) -> bool {
    let Some(m) = read_workflow_retry_metadata(metadata) else {
        return false;
    };
    m.state == "waiting" && parse_iso8601_millis(&m.next_eligible_at).is_some_and(|ms| now_ms >= ms)
}

pub fn is_step_run_awaiting_retry(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(Value::as_object)
        .is_some_and(|o| read_workflow_retry_metadata(o.get("workflowRetry")).is_some())
}

pub fn has_malformed_workflow_retry(metadata: Option<&Value>) -> bool {
    let Some(obj) = metadata.and_then(Value::as_object) else {
        return false;
    };
    matches!(obj.get("workflowRetry"), Some(raw) if !raw.is_null() && read_workflow_retry_metadata(Some(raw)).is_none())
}

pub fn parse_iso8601_millis(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date_part, rest_opt) = match s.split_once('T') {
        Some((d, r)) => (d, Some(r)),
        None => (s, None),
    };
    let mut dp = date_part.split('-');
    let (ys, ms, ds) = (dp.next()?, dp.next()?, dp.next()?);
    if dp.next().is_some() || ys.len() != 4 || ms.len() != 2 || ds.len() != 2 {
        return None;
    }
    let (year, month, day): (i64, i64, i64) =
        (ys.parse().ok()?, ms.parse().ok()?, ds.parse().ok()?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, min, sec, frac_ms, offset_ms): (i64, i64, i64, i64, i64) =
        if let Some(rest) = rest_opt {
            let (time_part, off_ms) = if let Some(t) = rest.strip_suffix('Z') {
                (t, 0)
            } else if let Some((t, o)) = rest.rsplit_once('+').or_else(|| rest.rsplit_once('-')) {
                let sign = if rest[t.len()..].starts_with('+') {
                    -1
                } else {
                    1
                };
                let (oh, om) = o.split_once(':')?;
                if oh.len() != 2 || om.len() != 2 {
                    return None;
                }
                let (oh_n, om_n): (i64, i64) = (oh.parse().ok()?, om.parse().ok()?);
                if !(0..=23).contains(&oh_n) || !(0..=59).contains(&om_n) {
                    return None;
                }
                (t, sign * (oh_n * 3_600 + om_n * 60) * 1_000)
            } else {
                return None;
            };
            let (hms, frac) = match time_part.split_once('.') {
                Some((h, f)) if !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()) => {
                    let d3: String = f.chars().take(3).collect();
                    (h, format!("{d3:0<3}").parse::<i64>().ok()?)
                }
                Some(_) => return None,
                None => (time_part, 0),
            };
            let mut hp = hms.split(':');
            let (hs, mns, ss) = (hp.next()?, hp.next()?, hp.next()?);
            if hp.next().is_some() || hs.len() != 2 || mns.len() != 2 || ss.len() != 2 {
                return None;
            }
            let (h_n, mn_n, s_n): (i64, i64, i64) =
                (hs.parse().ok()?, mns.parse().ok()?, ss.parse().ok()?);
            if !(0..=23).contains(&h_n) || !(0..=59).contains(&mn_n) || !(0..=59).contains(&s_n) {
                return None;
            }
            (h_n, mn_n, s_n, frac, off_ms)
        } else {
            (0, 0, 0, 0, 0)
        };
    let days = days_from_civil(year, month, day);
    days.checked_mul(86_400)?
        .checked_add(hour * 3_600 + min * 60 + sec)?
        .checked_mul(1_000)?
        .checked_add(frac_ms)?
        .checked_add(offset_ms)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

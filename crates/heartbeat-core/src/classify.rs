//! Exact ports of heartbeat-failure-classification.ts and
//! heartbeat-codex-auth-classification.ts.
//! [JS regex parity] `\b` without `u` is ASCII-only -> `(?-u:\b)`; `.` without
//! `s` excludes \n \r U+2028 U+2029 -> JS_DOT; JS `\s` = White_Space minus
//! U+0085 plus U+FEFF -> JS_WS; `\d` = [0-9]. `i`-flag inputs go through
//! js::js_canon for JS canonicalize parity, and captures slice the ORIGINAL
//! text via js::orig_capture. A lone `.`/`.?` consumes one UTF-16 unit, so
//! astral chars are excluded there (JS_DOT1); `.*` consumes whole chars and
//! keeps the full JS_DOT class.
use crate::js;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

/// JS `\s` contents (White_Space - U+0085 + U+FEFF), class brackets added per use.
const JS_WS: &str =
    r"\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
/// JS `.` (no s flag): any char except the four line terminators.
const JS_DOT: &str = r"[^\n\r\u{2028}\u{2029}]";
/// JS `.` as a single UTF-16 unit: JS_DOT minus astral chars (2 units each).
const JS_DOT1: &str = r"[^\n\r\u{2028}\u{2029}\u{10000}-\u{10ffff}]";

fn re(p: &str) -> Regex {
    Regex::new(p).expect("static regex")
}

/// One static per ported JS RegExp. Deliberately hand-compacted to honor the
/// 300-line file limit — one pattern per line, matching the TS literals 1:1.
#[rustfmt::skip]
mod pat {
    use super::*;
    pub static KIMI: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)(kimi|moonshot|mimo)(?-u:\b)"));
    pub static CLAUDE_API_ERROR: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)claude_api_error_([0-9]+)"));
    pub static OVERLOAD_MSG: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)overloaded|temporarily overloaded|service is currently"));
    pub static GUARDRAIL: LazyLock<Regex> = LazyLock::new(|| re(r"step input manifest|runtime broad scan|broad scan (command|instruction)|(?-u:\b)find \.|git ls-files|(?-u:\b)ls -r|(?-u:\b)tree(?-u:\b)|(?-u:\b)grep -r"));
    pub static QUOTA_CODE: LazyLock<Regex> = LazyLock::new(|| re(r"(?-u:\b)(403|429)(?-u:\b)"));
    pub static QUOTA_BROAD: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"quota|rate{JS_DOT1}?limit|rate limit|insufficient|billing|capacity|exceeded")));
    pub static QUOTA_NARROW: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"quota|insufficient_quota|rate{JS_DOT1}?limit|rate limit|billing hard limit|credits? exhausted|capacity exceeded")));
    pub static HAS_403: LazyLock<Regex> = LazyLock::new(|| re(r"(?-u:\b)403(?-u:\b)"));
    pub static AUTH: LazyLock<Regex> = LazyLock::new(|| re(r"(?-u:\b)401(?-u:\b)|unauthorized|invalid api key|invalid token|authentication failed|reauth|required|login required|forbidden"));
    pub static COMMAND_ERR: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"enoent|command not found|spawn {JS_DOT}* enoent|no such file or directory|eacces|permission denied|not executable")));
    pub static TOOL_LIMIT: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)reached maximum iterations|tool[-{JS_WS}]?call limit|tool capacity|could not post|couldn't post|not able to post|before i could post|could not {JS_DOT}*mark|couldn't {JS_DOT}*mark")));
    pub static AUTH_ERROR_CODE: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)(?-u:\b)auth error code:[{JS_WS}]*([a-z0-9_]+)")));
    pub static AUTH_CODE_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)(refresh_token_reused|token_expired|invalid_grant|session_expired)(?-u:\b)"));
    pub static AUTH_ERROR_401: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)(?-u:\b)auth error:[{JS_WS}]*401(?-u:\b)")));
    pub static UNAUTH_401: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)(?-u:\b)401[{JS_WS}]+unauthorized(?-u:\b)")));
    pub static CODEX_AUTH_TEXT: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)provided authentication token is expired|access token could not be refreshed|please log out and sign in again|no codex credentials stored"));
    pub static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| re(r"[^A-Z0-9]+"));
}
use pat::*;

fn out(category: &str, reason_code: &str, summary: &str, fallback_candidates: &[&str]) -> Value {
    json!({
        "category": category,
        "reasonCode": reason_code,
        "summary": summary,
        "fallbackCandidates": fallback_candidates,
    })
}

/// `input[key] ?? ""` under JS ToString coercion (RegExp.exec/test coerce args).
fn coerced(input: &Value, key: &str) -> String {
    input
        .get(key)
        .filter(|v| !v.is_null())
        .map_or_else(String::new, |v| js::js_to_string(Some(v)))
}

/// heartbeatRunFailureText — non-blank strings kept untrimmed, joined "\n",
/// then trimmed.
pub fn run_failure_text(input: &Value) -> String {
    let joined = [
        "errorCode",
        "errorMessage",
        "stdoutExcerpt",
        "stderrExcerpt",
    ]
    .iter()
    .filter_map(|k| input.get(k).and_then(js::as_nonempty_string))
    .collect::<Vec<_>>()
    .join("\n");
    js::js_trim(&joined).to_string()
}

/// classifyHeartbeatRunFailure. Deliberately hand-compacted to honor the
/// 300-line file limit — each `return Ok(out(...))` mirrors the TS `return`.
#[rustfmt::skip]
pub fn classify_run_failure(input: &Value) -> Result<Value, String> {
    let haystack = run_failure_text(input);
    let normalized = haystack.to_lowercase();
    let provider_model_command = ["provider", "model", "command", "adapterType"]
        .iter()
        .filter_map(|k| input.get(k).and_then(js::as_nonempty_string))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let mut fallback_candidates: Vec<&str> = Vec::new();
    if KIMI.is_match(&js::js_canon(&format!("{provider_model_command}\n{haystack}"))) {
        for c in [
            "mimo26pro command/model if configured with available quota",
            "same-role alternate agent on a non-Kimi provider",
        ] {
            if !fallback_candidates.contains(&c) {
                fallback_candidates.push(c);
            }
        }
    }
    let fallback_candidates = fallback_candidates.as_slice();
    let status = input.get("status").and_then(Value::as_str);
    if status == Some("timed_out") {
        return Ok(out("timeout", "RUN_TIMED_OUT", "Heartbeat run timed out.", fallback_candidates));
    }
    if status == Some("cancelled") {
        return Ok(out("cancelled", "RUN_CANCELLED", "Heartbeat run was cancelled.", fallback_candidates));
    }
    // Overload is matched on errorCode before stderr so a stray ENOENT warning
    // cannot misclassify a transient 5xx as a command failure.
    let overload_status = CLAUDE_API_ERROR
        .captures(&js::js_canon(&coerced(input, "errorCode")))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    if matches!(overload_status.as_deref(), Some("500" | "503" | "529"))
        || OVERLOAD_MSG.is_match(&js::js_canon(&coerced(input, "errorMessage")))
    {
        let reason = overload_status.map_or_else(
            || "PROVIDER_OVERLOADED".to_string(),
            |s| format!("PROVIDER_OVERLOADED_{s}"),
        );
        return Ok(out("overload", &reason, "Provider temporarily overloaded (transient). Retry/backoff applicable; not a command/path/permission issue.", fallback_candidates));
    }
    let strong_evidence = ["errorCode", "errorMessage", "stderrExcerpt"]
        .iter()
        .filter_map(|k| input.get(k).and_then(js::as_nonempty_string))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if GUARDRAIL.is_match(&strong_evidence) {
        return Ok(out("command", "STEP_INPUT_MANIFEST_GUARDRAIL", "Run blocked by a Step Input Manifest / runtime broad-scan guardrail (command-policy/input-contract). Not a provider quota/auth failure; replan the command or adjust the manifest.", fallback_candidates));
    }
    if QUOTA_CODE.is_match(&normalized) && QUOTA_BROAD.is_match(&normalized) {
        let rc = if HAS_403.is_match(&normalized) { "PROVIDER_QUOTA_OR_AUTH_403" } else { "PROVIDER_QUOTA_OR_RATE_LIMIT" };
        return Ok(out("quota", rc, "Provider quota/rate-limit/auth-capacity failure detected from run output.", fallback_candidates));
    }
    if QUOTA_NARROW.is_match(&normalized) {
        return Ok(out("quota", "PROVIDER_QUOTA_OR_RATE_LIMIT", "Provider quota or rate-limit failure detected from run output.", fallback_candidates));
    }
    if AUTH.is_match(&normalized) {
        let rc = if HAS_403.is_match(&normalized) { "PROVIDER_AUTH_OR_FORBIDDEN_403" } else { "PROVIDER_AUTH_FAILURE" };
        return Ok(out("auth", rc, "Provider authentication/authorization failure detected from run output.", fallback_candidates));
    }
    if COMMAND_ERR.is_match(&normalized) {
        return Ok(out("command", "COMMAND_EXECUTION_FAILURE", "Adapter command/path/permission failure detected from run output.", fallback_candidates));
    }
    let reason_code = match input.get("errorCode") {
        None | Some(Value::Null) => "ADAPTER_RUN_FAILED".to_string(),
        Some(Value::String(s)) => {
            let t = js::js_trim(s);
            if t.is_empty() { "ADAPTER_RUN_FAILED".to_string() } else { t.to_string() }
        }
        // `input.errorCode?.trim()` throws TypeError on non-string non-null.
        Some(_) => return Err("input.errorCode?.trim is not a function".to_string()),
    };
    Ok(out("adapter", &reason_code, "Adapter run failed without a more specific local classification.", fallback_candidates))
}

/// containsToolLimitLifecycleFailure — `iu` flag: Unicode simple fold on both
/// sides, so native `(?i)` is exact; `.` is codepoint-wide in u-mode.
pub fn contains_tool_limit(input: &Value) -> bool {
    let text = ["stdoutExcerpt", "stderrExcerpt", "error"]
        .iter()
        .filter_map(|k| input.get(k))
        .filter(|v| js::js_truthy(v))
        .map(|v| js::js_to_string(Some(v)))
        .collect::<Vec<_>>()
        .join("\n");
    TOOL_LIMIT.is_match(&text)
}

/// `match(...)?[1]?.toLowerCase()` on the js_canon image, slicing the capture
/// back out of the original text so mapped chars keep their source bytes.
fn first_group_lower(re: &Regex, canon: &str, orig: &str) -> Option<String> {
    let m = re.captures(canon)?.get(1)?;
    Some(js::orig_capture(orig, canon, m.start(), m.end()).to_lowercase())
}

/// normalizeReasonCodeSegment: trim -> toUpperCase -> [^A-Z0-9]+ runs -> "_"
/// -> strip leading/trailing "_".
fn normalize_segment(value: &str) -> String {
    let up = js::js_trim(value).to_uppercase();
    NON_ALNUM
        .replace_all(&up, "_")
        .trim_matches('_')
        .to_string()
}

/// detectCodexAuthFailureForAutoBlock.
pub fn detect_codex_auth(input: &Value) -> Result<Value, String> {
    const PREFIX: &str = "codex_auth_401";
    if input.get("adapterType").and_then(Value::as_str) != Some("codex_local") {
        return Ok(Value::Null);
    }
    let normalized_error_code = match input.get("errorCode") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js::js_trim(s).to_lowercase(),
        // `(input.errorCode ?? "").trim()` throws TypeError on non-string non-null.
        Some(_) => return Err("(input.errorCode ?? \"\").trim is not a function".to_string()),
    };
    if let Some(rest) = normalized_error_code.strip_prefix(PREFIX) {
        let auth_error_code = rest.trim_start_matches('_');
        if !auth_error_code.is_empty() {
            let reason = format!("CODEX_AUTH_401_{}", normalize_segment(auth_error_code));
            return Ok(json!({ "reasonCode": reason, "authErrorCode": auth_error_code }));
        }
    }
    let haystack = js::js_trim(
        &["errorMessage", "stdoutExcerpt", "stderrExcerpt"]
            .iter()
            .map(|k| coerced(input, k))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .to_string();
    let canon = js::js_canon(&haystack);
    let detected = first_group_lower(&AUTH_ERROR_CODE, &canon, &haystack)
        .or_else(|| first_group_lower(&AUTH_CODE_WORD, &canon, &haystack));
    let has_provider_401 = detected.is_some() || AUTH_ERROR_401.is_match(&canon);
    let has_401_evidence = normalized_error_code == PREFIX
        || UNAUTH_401.is_match(&canon)
        || AUTH_ERROR_401.is_match(&canon);
    if has_provider_401 && has_401_evidence {
        let reason = detected
            .as_deref()
            .map(|c| format!("CODEX_AUTH_401_{}", normalize_segment(c)))
            .unwrap_or_else(|| "CODEX_AUTH_401".to_string());
        return Ok(json!({ "reasonCode": reason, "authErrorCode": detected }));
    }
    if detected.is_some() || CODEX_AUTH_TEXT.is_match(&canon) {
        let code = detected.unwrap_or_else(|| "reauth_required".to_string());
        let reason = format!("CODEX_AUTH_{}", normalize_segment(&code));
        return Ok(json!({ "reasonCode": reason, "authErrorCode": code }));
    }
    Ok(Value::Null)
}

#[cfg(test)]
#[rustfmt::skip]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn smoke() {
        let v = classify_run_failure(&json!({"status":"failed","errorCode":"claude_api_error_529","stderrExcerpt":"ENOENT"})).unwrap();
        assert_eq!(v["reasonCode"], "PROVIDER_OVERLOADED_529");
        let v = classify_run_failure(&json!({"status":"failed","stderrExcerpt":"step input manifest"})).unwrap();
        assert_eq!(v["reasonCode"], "STEP_INPUT_MANIFEST_GUARDRAIL");
        assert!(contains_tool_limit(&json!({"error":"tool\u{feff}call limit"})));
        assert!(!contains_tool_limit(&json!({"error":"tool\u{85}call limit"})));
        let v = detect_codex_auth(&json!({"adapterType":"codex_local","errorMessage":"auth error code: token_expired\nauth error: 401"})).unwrap();
        assert_eq!(v["reasonCode"], "CODEX_AUTH_401_TOKEN_EXPIRED");
        assert!(detect_codex_auth(&json!({"adapterType":"claude_local"})).unwrap().is_null());
    }
}

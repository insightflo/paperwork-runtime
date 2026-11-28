//! Deterministic provider failure classification and backoff arithmetic.
//!
//! Ported from `server/src/services/heartbeat-provider-backoff.ts`; provider
//! retry hints are represented directly in milliseconds as `retry_after_ms`.

use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_MS: u64 = 15_000;
pub const DEFAULT_MAX_MS: u64 = 300_000;
pub const DEFAULT_CIRCUIT_THRESHOLD: u32 = 3;

/// Closed provider failure vocabulary, serialized with the TypeScript names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorClass {
    RateLimit,
    Overloaded,
    NetworkTransient,
    AuthFatal,
    Unknown,
}

/// Failure evidence. `exit_code` is carried for callers, but classification is text-based.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFailureInput {
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub stderr: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

/// Backoff calculation input; absent `base_ms`/`max_ms` use the defaults above.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderBackoffInput {
    pub error_class: ProviderErrorClass,
    pub consecutive_failures: i64,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
    #[serde(default)]
    pub base_ms: Option<u64>,
    #[serde(default)]
    pub max_ms: Option<u64>,
}

/// Backoff calculation result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderBackoffDecision {
    pub retryable: bool,
    pub delay_ms: u64,
}

/// Circuit-breaker calculation input; absent `threshold` uses the default above.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCircuitInput {
    pub error_class: ProviderErrorClass,
    pub consecutive_failures: i64,
    #[serde(default)]
    pub threshold: Option<u32>,
}

fn failure_text(input: &ProviderFailureInput) -> String {
    let mut parts = Vec::new();
    for value in [input.error_message.as_deref(), input.stderr.as_deref()].into_iter().flatten() {
        if !value.trim().is_empty() {
            parts.push(value);
        }
    }
    parts.join("\n").to_lowercase()
}

fn status_token_byte(byte: u8) -> bool {
    byte.is_ascii_digit() || byte.is_ascii_lowercase()
}

fn has_status_code(text: &str, status_code: u16) -> bool {
    let needle = status_code.to_string();
    let needle = needle.as_bytes();
    let bytes = text.as_bytes();
    bytes.windows(needle.len()).enumerate().any(|(index, window)| {
        let prev_blocked = index > 0 && status_token_byte(bytes[index - 1]);
        let next = index + needle.len();
        let next_blocked = next < bytes.len() && status_token_byte(bytes[next]);
        window == needle && !prev_blocked && !next_blocked
    })
}

fn has_any_phrase(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| text.contains(phrase))
}

/// Classify failure text with the same precedence as the TypeScript helper.
pub fn classify_provider_failure(input: &ProviderFailureInput) -> ProviderErrorClass {
    let text = failure_text(input);
    if text.is_empty() {
        return ProviderErrorClass::Unknown;
    }
    if has_status_code(&text, 401) || has_status_code(&text, 403) || has_any_phrase(&text, &["invalid api key", "unauthorized", "authentication failed"]) {
        return ProviderErrorClass::AuthFatal;
    }
    if has_status_code(&text, 429) || has_any_phrase(&text, &["rate limit", "rate-limit", "too many requests", "quota exceeded"]) {
        return ProviderErrorClass::RateLimit;
    }
    if has_status_code(&text, 503) || has_status_code(&text, 529) || has_any_phrase(&text, &["overloaded", "capacity", "temporarily unavailable"]) {
        return ProviderErrorClass::Overloaded;
    }
    if has_status_code(&text, 502) || has_status_code(&text, 504) || has_any_phrase(&text, &["econnreset", "etimedout", "fetch failed", "socket hang up"]) {
        return ProviderErrorClass::NetworkTransient;
    }
    ProviderErrorClass::Unknown
}

fn exponential_delay_ms(base_ms: u64, max_ms: u64, consecutive_failures: i64) -> u64 {
    let mut delay = base_ms.min(max_ms);
    for _ in 0..consecutive_failures.saturating_sub(1).max(0).min(64) {
        delay = delay.saturating_mul(2).min(max_ms);
    }
    delay
}

/// Compute deterministic exponential delay; `retry_after_ms` is a floor clamped to `max_ms`.
pub fn compute_provider_backoff_ms(opts: &ProviderBackoffInput) -> ProviderBackoffDecision {
    if matches!(opts.error_class, ProviderErrorClass::AuthFatal | ProviderErrorClass::Unknown) {
        return ProviderBackoffDecision { retryable: false, delay_ms: 0 };
    }
    let base_ms = opts.base_ms.unwrap_or(DEFAULT_BASE_MS);
    let max_ms = opts.max_ms.unwrap_or(DEFAULT_MAX_MS);
    let exponential = exponential_delay_ms(base_ms, max_ms, opts.consecutive_failures);
    let delay_ms = match opts.retry_after_ms {
        Some(ms) if ms > exponential => ms.min(max_ms),
        _ => exponential,
    };
    ProviderBackoffDecision { retryable: true, delay_ms }
}

/// Retryable classes trip at `threshold`; auth failures trip once, unknown never trips.
pub fn should_trip_provider_circuit(opts: &ProviderCircuitInput) -> bool {
    let threshold = i64::from(opts.threshold.unwrap_or(DEFAULT_CIRCUIT_THRESHOLD));
    match opts.error_class {
        ProviderErrorClass::AuthFatal => opts.consecutive_failures >= 1,
        ProviderErrorClass::Unknown => false,
        _ => opts.consecutive_failures >= threshold,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ProviderErrorClass::*;

    fn failure(error_message: Option<&str>, stderr: Option<&str>) -> ProviderFailureInput {
        ProviderFailureInput { error_message: error_message.map(String::from), stderr: stderr.map(String::from), exit_code: None }
    }

    fn backoff(error_class: ProviderErrorClass, consecutive_failures: i64, retry_after_ms: Option<u64>) -> ProviderBackoffInput {
        ProviderBackoffInput { error_class, consecutive_failures, retry_after_ms, base_ms: None, max_ms: None }
    }

    #[test]
    fn classifies_status_codes_and_provider_phrases() {
        assert_eq!(classify_provider_failure(&failure(Some("HTTP 429 from provider"), None)), RateLimit);
        assert_eq!(classify_provider_failure(&failure(Some("Rate limit exceeded"), None)), RateLimit);
        assert_eq!(classify_provider_failure(&failure(None, Some("Too Many Requests"))), RateLimit);
        assert_eq!(classify_provider_failure(&failure(Some("quota exceeded for current model"), None)), RateLimit);
        assert_eq!(classify_provider_failure(&failure(Some("HTTP 503 Service Unavailable"), None)), Overloaded);
        assert_eq!(classify_provider_failure(&failure(None, Some("provider returned 529"))), Overloaded);
        assert_eq!(classify_provider_failure(&failure(Some("insufficient capacity"), None)), Overloaded);
        assert_eq!(classify_provider_failure(&failure(Some("bad gateway 502"), None)), NetworkTransient);
        assert_eq!(classify_provider_failure(&failure(Some("gateway timeout 504"), None)), NetworkTransient);
        assert_eq!(classify_provider_failure(&failure(Some("ECONNRESET"), None)), NetworkTransient);
        assert_eq!(classify_provider_failure(&failure(None, Some("socket hang up"))), NetworkTransient);
        assert_eq!(classify_provider_failure(&failure(Some("HTTP 401 Unauthorized"), None)), AuthFatal);
        assert_eq!(classify_provider_failure(&failure(Some("HTTP 403 Forbidden"), None)), AuthFatal);
        assert_eq!(classify_provider_failure(&failure(None, Some("invalid api key"))), AuthFatal);
    }

    #[test]
    fn status_codes_do_not_match_inside_alphanumeric_tokens() {
        for text in ["model glm-529x missing", "wrote 14293 bytes", "x401", "403x"] {
            assert_eq!(classify_provider_failure(&failure(Some(text), None)), Unknown, "{text}");
        }
        assert_eq!(classify_provider_failure(&failure(Some("status-429"), None)), RateLimit);
        assert_eq!(classify_provider_failure(&failure(Some("401 unauthorized; 429 too many requests"), None)), AuthFatal);
        assert_eq!(classify_provider_failure(&failure(None, None)), Unknown);
    }

    #[test]
    fn backoff_progresses_doubles_and_caps() {
        for (failures, expected) in [(1_i64, 15_000_u64), (2, 30_000), (3, 60_000), (4, 120_000), (10, 300_000)] {
            assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, failures, None)).delay_ms, expected);
        }
        assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, -5, None)).delay_ms, 15_000);
        assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, i64::MAX, None)).delay_ms, 300_000);
        let mut custom = backoff(Overloaded, 4, None);
        custom.base_ms = Some(10_000);
        custom.max_ms = Some(50_000);
        assert_eq!(compute_provider_backoff_ms(&custom).delay_ms, 50_000);
    }

    #[test]
    fn retry_after_ms_is_a_floor_clamped_to_max() {
        assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, 1, Some(45_000))).delay_ms, 45_000);
        assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, 1, Some(600_000))).delay_ms, 300_000);
        assert_eq!(compute_provider_backoff_ms(&backoff(RateLimit, 3, Some(10_000))).delay_ms, 60_000);
    }

    #[test]
    fn fatal_and_unknown_are_non_retryable() {
        assert_eq!(compute_provider_backoff_ms(&backoff(AuthFatal, 1, Some(30_000))), ProviderBackoffDecision { retryable: false, delay_ms: 0 });
        assert_eq!(compute_provider_backoff_ms(&backoff(Unknown, 5, Some(30_000))), ProviderBackoffDecision { retryable: false, delay_ms: 0 });
    }

    #[test]
    fn circuit_trips_by_class_and_threshold() {
        let circuit = |error_class, consecutive_failures, threshold| should_trip_provider_circuit(&ProviderCircuitInput { error_class, consecutive_failures, threshold });
        assert!(!circuit(RateLimit, 2, None));
        assert!(circuit(RateLimit, 3, None));
        assert!(circuit(Overloaded, 3, None));
        assert!(circuit(NetworkTransient, 4, None));
        assert!(!circuit(Overloaded, 4, Some(5)));
        assert!(circuit(Overloaded, 5, Some(5)));
        assert!(!circuit(AuthFatal, 0, None));
        assert!(circuit(AuthFatal, 1, Some(10)));
        assert!(!circuit(Unknown, 99, None));
    }
}

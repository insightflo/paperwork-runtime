//! Constant-time SHA-256 token verification and secret redaction for Paperwork bot & terminal tokens.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TERMINAL_TOKEN_PREFIX: &str = "pcp_term_";
pub const BOT_TOKEN_PREFIX: &str = "pcp_bot_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Terminal,
    Bot,
}

/// Identifies a Paperwork token by its well-known prefix.
pub fn validate_token_prefix(raw_token: &str) -> Option<TokenKind> {
    if let Some(rest) = raw_token.strip_prefix(TERMINAL_TOKEN_PREFIX) {
        if !rest.is_empty() && rest.bytes().all(is_token_byte) {
            return Some(TokenKind::Terminal);
        }
    }
    if let Some(rest) = raw_token.strip_prefix(BOT_TOKEN_PREFIX) {
        if !rest.is_empty() && rest.bytes().all(is_token_byte) {
            return Some(TokenKind::Bot);
        }
    }
    None
}

/// Computes lowercase hex SHA-256 digest of `input`.
pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Constant-time byte slice comparison (does not short-circuit on mismatch).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let len_diff = a.len() ^ b.len();
    let max_len = a.len().max(b.len());
    let mut diff: u8 = 0;
    for i in 0..max_len {
        let ba = if i < a.len() { a[i] } else { 0 };
        let bb = if i < b.len() { b[i] } else { 0 };
        diff |= ba ^ bb;
    }
    len_diff == 0 && diff == 0
}

/// Verifies `raw_token` against an expected 64-character hex SHA-256 digest in constant time.
pub fn verify_token_sha256(raw_token: &str, expected_sha256_hex: &str) -> bool {
    if raw_token.is_empty() {
        return false;
    }
    let expected = expected_sha256_hex.trim();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let expected_lower = expected.to_ascii_lowercase();
    let actual = sha256_hex(raw_token);
    constant_time_eq(actual.as_bytes(), expected_lower.as_bytes())
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b'/' | b'=')
}

/// Redacts `pcp_term_*`, `pcp_bot_*`, and `Bearer *` tokens from arbitrary log or payload text.
pub fn redact_secrets(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < bytes.len() {
        // Check `pcp_term_`
        if bytes[i..].starts_with(TERMINAL_TOKEN_PREFIX.as_bytes()) {
            out.push_str(TERMINAL_TOKEN_PREFIX);
            out.push_str("[REDACTED]");
            i += TERMINAL_TOKEN_PREFIX.len();
            while i < bytes.len() && is_token_byte(bytes[i]) {
                i += 1;
            }
            continue;
        }

        // Check `pcp_bot_`
        if bytes[i..].starts_with(BOT_TOKEN_PREFIX.as_bytes()) {
            out.push_str(BOT_TOKEN_PREFIX);
            out.push_str("[REDACTED]");
            i += BOT_TOKEN_PREFIX.len();
            while i < bytes.len() && is_token_byte(bytes[i]) {
                i += 1;
            }
            continue;
        }

        // Check case-insensitive `Bearer ` (word boundary before `Bearer`)
        if i + 7 <= bytes.len()
            && bytes[i..i + 6].eq_ignore_ascii_case(b"bearer")
            && bytes[i + 6].is_ascii_whitespace()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
        {
            out.push_str("Bearer ");
            i += 6;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start = i;
            while i < bytes.len() && is_token_byte(bytes[i]) {
                i += 1;
            }
            if i > start {
                out.push_str("[REDACTED]");
            }
            continue;
        }

        // Advance one UTF-8 scalar cleanly.
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("authorization")
        || lower.contains("api_key")
        || lower.contains("apikey")
}

/// Recursively redacts secret tokens and sensitive key values in a JSON payload.
pub fn redact_json_value(value: &mut Value) {
    match value {
        Value::String(s) => {
            *s = redact_secrets(s);
        }
        Value::Array(items) => {
            for item in items {
                redact_json_value(item);
            }
        }
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_sensitive_key(k) {
                    if let Value::String(s) = v {
                        if !s.is_empty() {
                            *s = "[REDACTED]".to_string();
                            continue;
                        }
                    }
                }
                redact_json_value(v);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn constant_time_eq_handles_equal_diff_and_length_mismatch() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"abcde"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn verify_token_sha256_validates_case_insensitively_and_rejects_bad_inputs() {
        let token = "pcp_term_live_0123456789abcdef";
        let digest = sha256_hex(token);
        assert_eq!(digest.len(), 64);
        assert!(verify_token_sha256(token, &digest));
        assert!(verify_token_sha256(token, &digest.to_ascii_uppercase()));
        assert!(!verify_token_sha256("pcp_term_wrong", &digest));
        assert!(!verify_token_sha256("", &digest));
        assert!(!verify_token_sha256(token, "not-a-sha256"));
    }

    #[test]
    fn validate_token_prefix_distinguishes_terminal_and_bot() {
        assert_eq!(
            validate_token_prefix("pcp_term_abc123"),
            Some(TokenKind::Terminal)
        );
        assert_eq!(validate_token_prefix("pcp_bot_xyz-99"), Some(TokenKind::Bot));
        assert_eq!(validate_token_prefix("pcp_term_"), None);
        assert_eq!(validate_token_prefix("other_123"), None);
    }

    #[test]
    fn redact_secrets_masks_all_token_patterns_without_leaking() {
        let raw = "Authorization: Bearer eyJhbGciOi.secret_123 | term=pcp_term_s3cr3t-99 bot=pcp_bot_top_42 ok=true";
        let redacted = redact_secrets(raw);
        assert!(!redacted.contains("eyJhbGciOi"));
        assert!(!redacted.contains("s3cr3t-99"));
        assert!(!redacted.contains("top_42"));
        assert!(redacted.contains("Bearer [REDACTED]"));
        assert!(redacted.contains("pcp_term_[REDACTED]"));
        assert!(redacted.contains("pcp_bot_[REDACTED]"));
        assert!(redacted.ends_with("ok=true"));
    }

    #[test]
    fn redact_json_value_masks_sensitive_keys_and_embedded_tokens() {
        let mut payload = json!({
            "terminalId": "term-1",
            "token": "raw-secret",
            "headers": {
                "Authorization": "Bearer abc.def.ghi"
            },
            "log": "connected with pcp_bot_secret123"
        });
        redact_json_value(&mut payload);
        assert_eq!(payload["token"], "[REDACTED]");
        assert_eq!(payload["headers"]["Authorization"], "[REDACTED]");
        assert_eq!(payload["log"], "connected with pcp_bot_[REDACTED]");
        assert_eq!(payload["terminalId"], "term-1");
    }
}

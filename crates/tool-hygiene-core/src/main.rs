//! paperclip-tool-hygiene-core — stdin/stdout JSON subcommands mirroring the pure
//! parts of server/src/services/tool-fingerprint.ts, tool-result-hygiene.ts and
//! tool-env-sensitivity.ts. Err(_) mirrors TS TypeError throws: stderr + exit 1.
use std::io::{self, Read};
use std::process;

/// JS-semantics shims shared with the mission-core port style: raw Value +
/// permissive reads preserve duck-typing parity.
#[rustfmt::skip]
mod js {
    use serde_json::Value;
    use std::cmp::Ordering;

    /// JS \s / String#trim domain: Unicode White_Space minus U+0085, plus U+FEFF.
    pub fn is_js_space(c: char) -> bool { (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}' }
    pub fn js_trim(s: &str) -> &str { s.trim_matches(is_js_space) }

    /// String#sort default: UTF-16 code unit order (differs from code-point
    /// order for U+D800..U+DFFF-adjacent ranges vs astral chars).
    pub fn utf16_cmp(a: &str, b: &str) -> Ordering { a.encode_utf16().cmp(b.encode_utf16()) }

    /// JS truthiness (serde_json::Number is finite, so `!= 0` covers -0).
    pub fn js_truthy(v: &Value) -> bool {
        match v {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64() != Some(0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }

    /// ECMA `Number::toString` for finite f64 (shortest round-trip digits via `{:e}`).
    pub fn js_num_str(f: f64) -> String {
        if f == 0.0 {
            return "0".into(); // covers -0
        }
        let neg = f.is_sign_negative();
        let a = f.abs();
        let e = format!("{a:e}");
        let (mant, exp) = e.split_once('e').unwrap_or((e.as_str(), "0"));
        let digits: String = mant.chars().filter(|c| *c != '.').collect();
        let n = exp.parse::<i32>().unwrap_or(0) + 1;
        let k = digits.len() as i32;
        let body = if (k..=21).contains(&n) {
            format!("{digits}{}", "0".repeat((n - k).max(0) as usize))
        } else if (1..=21).contains(&n) {
            format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
        } else if n > -6 && n <= 0 {
            format!("0.{}{digits}", "0".repeat((-n).max(0) as usize))
        } else if k == 1 {
            format!("{digits}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
        } else {
            let (h, t) = (&digits[..1], &digits[1..]);
            format!("{h}.{t}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
        };
        if neg {
            format!("-{body}")
        } else {
            body
        }
    }

    /// JS `ToString`; `None` models `undefined` (array elements render nullish as "").
    pub fn js_to_string(v: Option<&Value>) -> String {
        match v {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => js_num_str(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a
                .iter()
                .map(|e| {
                    if e.is_null() {
                        String::new()
                    } else {
                        js_to_string(Some(e))
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".into(),
        }
    }

    /// `JSON.stringify(v)` for JSON-representable input (integer-index keys sort
    /// numerically first, non-finite numbers become null).
    pub fn js_json_stringify(v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n
                .as_f64()
                .filter(|f| f.is_finite())
                .map_or_else(|| "null".into(), js_num_str),
            Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
            Value::Array(a) => {
                format!("[{}]", a.iter().map(js_json_stringify).collect::<Vec<_>>().join(","))
            }
            Value::Object(m) => {
                let mut e: Vec<(&String, &Value)> = m.iter().collect();
                e.sort_by_key(|(k, _)| array_index_key(k).map(|i| (0, i)).unwrap_or((1, 0)));
                let parts = e.iter().map(|(k, v)| {
                    format!("{}:{}", js_json_stringify(&Value::String((*k).clone())), js_json_stringify(v))
                });
                format!("{{{}}}", parts.collect::<Vec<_>>().join(","))
            }
        }
    }

    /// JS "integer index" key: canonical u32 decimal below 2^32 - 1.
    fn array_index_key(k: &str) -> Option<u64> {
        k.parse::<u64>()
            .ok()
            .filter(|n| *n < 4_294_967_295 && n.to_string() == *k)
    }
}

/// tool-env-sensitivity.ts port — kept in main.rs to honor the 300-line cap.
#[rustfmt::skip]
mod env_sens {
    use crate::js::js_to_string;
    use serde_json::Value;

    /// `isSensitiveToolEnvKey` — regex.test() coerces non-strings via ToString.
    /// i-flag·all-ASCII patterns only need single-char lowercase folding
    /// (multi-char folds like İ stay literal, matching JS simple case folding).
    pub fn is_sensitive_tool_env_key(key: Option<&Value>) -> bool {
        let folded: String = js_to_string(key)
            .chars()
            .map(|c| {
                let mut it = c.to_lowercase();
                match (it.next(), it.next()) {
                    (Some(l), None) => l,
                    _ => c,
                }
            })
            .collect();
        const NEEDLES: &[&str] = &[
            "apikey", "api-key", "api_key", "accesstoken", "access-token", "access_token",
            "auth", "bearer", "secret", "passwd", "password", "credential", "jwt",
            "privatekey", "private-key", "private_key", "cookie", "connectionstring",
        ];
        if NEEDLES.iter().any(|n| folded.contains(n)) {
            return true;
        }
        // /(^|[_-])tokens?([_-]|$)/i — segment-bounded token match.
        let b = folded.as_bytes();
        for i in 0..b.len() {
            if i > 0 && !matches!(b[i - 1], b'_' | b'-') {
                continue;
            }
            if let Some(rest) = b[i..].strip_prefix(b"token") {
                let j = i + 5 + usize::from(rest.first() == Some(&b's'));
                if j == b.len() || matches!(b[j], b'_' | b'-') {
                    return true;
                }
            }
        }
        false
    }
}

#[rustfmt::skip] // hand-compacted to honor the 300-line file limit
mod hygiene;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(format!(
            "usage: paperclip-tool-hygiene-core <{}>",
            hygiene::SUBCOMMANDS.join("|")
        ));
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let out = hygiene::dispatch(subcommand, &raw)?;
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

#[cfg(test)]
#[rustfmt::skip] // one-line JSON fixtures keep the parity tables diffable
mod tests {
    use super::hygiene::dispatch;
    use serde_json::{json, Value};

    fn run(sub: &str, v: Value) -> Result<Value, String> {
        dispatch(sub, serde_json::to_string(&v).unwrap().as_bytes())
    }

    #[test]
    fn sensitive_key_boundaries() {
        for (key, want) in [
            ("API_KEY", true), ("token", true), ("tokens", true), ("token-x", true),
            ("x-token", true), ("xtoken", false), ("tokenx", false), ("tokensx", false),
            ("plain", false), ("AUTH", true), ("my-jwt-v2", true),
        ] {
            assert_eq!(run("is-sensitive-tool-env-key", json!({"key": key})).unwrap(), json!(want), "{key}");
        }
    }

    #[test]
    fn normalize_and_type_errors() {
        assert_eq!(
            run("normalize-tool-error-signature", json!({"text":"  ERR 404 \t Not  Found12  "})).unwrap(),
            json!("err # not found#"),
        );
        assert!(run("compute-agent-tool-fingerprint", Value::Null).is_err());
        assert!(run("compute-agent-tool-fingerprint", json!({"adapterType":"x","allowedTools":[5]})).is_err());
        assert!(run("normalize-tool-error-signature", json!({"text":5})).is_err());
        assert!(run("is-sensitive-tool-env-key", json!({"key":null})).is_ok());
        assert!(run("compute-agent-tool-fingerprint", json!({"adapterType":"x","mcpServers":[null]})).is_err());
    }
}

//! paperclip-heartbeat-core — soft-mode port of the pure heartbeat modules:
//!   Stage 1: server/src/services/heartbeat-failure-classification.ts
//!            server/src/services/heartbeat-codex-auth-classification.ts
//!   Stage 2: server/src/services/heartbeat-stability.ts
//!            server/src/services/heartbeat-run-context.ts
//!            server/src/services/heartbeat-session-reset.ts
//!            server/src/services/heartbeat-output-validation.ts
//! stdin JSON -> stdout JSON subcommands. Err(_) mirrors TS throws (TypeError
//! etc.): the message goes to stderr and the process exits 1.
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

mod classify;
#[allow(dead_code)] mod fairness;
mod stability;

/// JS-semantics shims — same conventions as paperclip-mission-core/js and
/// paperclip-workflow-core/js_value.
#[rustfmt::skip]
mod js {
    use regex::Regex;
    use serde_json::Value;
    use std::sync::LazyLock;

    /// String#trim domain: Unicode White_Space minus U+0085 (NEL), plus U+FEFF.
    fn is_js_trim_char(c: char) -> bool { (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}' }
    pub fn js_trim(s: &str) -> &str { s.trim_matches(is_js_trim_char) }

    /// `typeof v === "string" && v.trim().length > 0` — Array#filter keeps the
    /// ORIGINAL string, so this returns `s` untrimmed.
    pub fn as_nonempty_string(v: &Value) -> Option<&str> {
        let s = v.as_str()?;
        if js_trim(s).is_empty() { None } else { Some(s) }
    }

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

    /// RegExp `i` flag WITHOUT `u` canonicalizes via single-code-unit
    /// ToUppercase AND rejects folds where the source char is >= U+0080 and the
    /// result is ASCII (the ES "code unit >= 128" rule). For the pure-ASCII
    /// patterns ported here that means no non-ASCII input char can ever match:
    /// JS is effectively ASCII-only case-insensitive. Rust `(?i)` uses Unicode
    /// simple folding, which maps exactly three extra chars into ASCII:
    /// U+017F (ſ->s), U+212A (K->k), U+037E (;->;). Neutralizing just those to a
    /// sentinel makes `(?i)` + `(?-u:\b)` exactly JS-equivalent. (`iu`-flag
    /// regexes use Unicode simple folding = native `(?i)` and must NOT go
    /// through this — there 'ſ' really does match 's'.)
    pub fn js_canon(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                '\u{17f}' | '\u{37e}' | '\u{212a}' => '\u{fffe}',
                c => c,
            })
            .collect()
    }

    /// Recover the original-text slice for a capture taken on `mapped` (the
    /// js_canon image of `orig`; the mapping is 1 char -> 1 char, so byte
    /// offsets on `mapped` translate to char indices valid on `orig`).
    pub fn orig_capture<'a>(orig: &'a str, mapped: &str, byte_start: usize, byte_end: usize) -> &'a str {
        let cs = mapped[..byte_start].chars().count();
        let ce = mapped[..byte_end].chars().count();
        let bs = orig.char_indices().nth(cs).map_or(orig.len(), |(i, _)| i);
        let be = orig.char_indices().nth(ce).map_or(orig.len(), |(i, _)| i);
        &orig[bs..be]
    }

    /// JS ToString; `None` models `undefined` (array elements render nullish as "").
    pub fn js_to_string(v: Option<&Value>) -> String {
        match v {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => js_num_str(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a
                .iter()
                .map(|e| if e.is_null() { String::new() } else { js_to_string(Some(e)) })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".into(),
        }
    }

    /// ECMA Number::toString — fixed notation inside 1e-6..1e21 (integers
    /// without a fraction), e±exp outside (mirrors workflow-core js_num_str).
    pub fn js_num_str(f: f64) -> String {
        if f.is_nan() { return "NaN".into(); }
        if f.is_infinite() { return if f > 0.0 { "Infinity" } else { "-Infinity" }.into(); }
        if f == 0.0 { return "0".into(); }
        if (1e-6..1e21).contains(&f.abs()) {
            return if f == f.trunc() { format!("{f:.0}") } else { format!("{f}") };
        }
        let s = format!("{f:e}");
        let (mant, exp) = s.split_once('e').unwrap_or((s.as_str(), "0"));
        let exp: i32 = exp.parse().unwrap_or(0);
        format!("{}e{}{}", mant, if exp >= 0 { "+" } else { "-" }, exp.abs())
    }

    static JS_DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\A[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?\z").expect("static regex")
    });

    /// JS StringToNumber: JS-WS trim; "" -> +0; exact-case "Infinity"; unsigned
    /// 0x/0o/0b literals; ASCII decimal with optional sign/exponent; else NaN.
    pub fn js_str_to_num(s: &str) -> f64 {
        let t = js_trim(s);
        if t.is_empty() { return 0.0; }
        match t {
            "Infinity" | "+Infinity" => return f64::INFINITY,
            "-Infinity" => return f64::NEG_INFINITY,
            _ => {}
        }
        for (prefix, base) in [('x', 16), ('o', 8), ('b', 2)] {
            if let Some(digits) = t
                .strip_prefix('0')
                .and_then(|r| r.strip_prefix(|c: char| c.eq_ignore_ascii_case(&prefix)))
            {
                return if digits.is_empty() || !digits.chars().all(|c| c.is_digit(base)) {
                    f64::NAN
                } else {
                    digits.chars().fold(0.0, |a, c| {
                        a * f64::from(base) + c.to_digit(base).unwrap_or(0) as f64
                    })
                };
            }
        }
        if JS_DECIMAL.is_match(t) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
    }

    /// JS ToNumber for JSON values; `None` models `undefined` -> NaN.
    pub fn js_number(v: Option<&Value>) -> f64 {
        match v {
            None | Some(Value::Object(_)) => f64::NAN,
            Some(Value::Null) => 0.0,
            Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => js_str_to_num(s),
            Some(Value::Array(_)) => js_str_to_num(&js_to_string(v)),
        }
    }

    /// Math.max propagates NaN (Rust f64::max silently drops it).
    pub fn js_max(a: f64, b: f64) -> f64 {
        if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
    }

    /// JS parseInt(s, 10): JS-WS trim, ONE optional sign, longest ASCII-digit
    /// prefix; no digits -> NaN ("1e3" -> 1, "0x10" -> 0 at radix 10).
    pub fn js_parse_int10(s: &str) -> f64 {
        let t = js_trim(s);
        let (neg, rest) = match t.as_bytes().first() {
            Some(b'-') => (true, &t[1..]),
            Some(b'+') => (false, &t[1..]),
            _ => (false, t),
        };
        let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        let v = rest[..end].parse::<f64>().unwrap_or(f64::NAN);
        if neg { -v } else { v }
    }

    /// `v?.[key]` — null/undefined and non-object primitives all read
    /// `undefined` (property access on primitives never throws).
    pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
        v.and_then(|v| v.get(key))
    }

    /// heartbeat-run-context readNonEmptyString: string + non-blank JS-trim ->
    /// Some(TRIMMED) — unlike as_nonempty_string which keeps the original.
    pub fn read_nonempty_trimmed(v: Option<&Value>) -> Option<String> {
        let t = js_trim(v?.as_str()?);
        if t.is_empty() { None } else { Some(t.to_string()) }
    }

    /// `(x ?? null) === (y ?? null)`: `undefined` maps to null; arrays/objects
    /// never compare equal (JS reference identity cannot survive JSON).
    pub fn js_nullish_eq(l: Option<&Value>, r: Option<&Value>) -> bool {
        match (l, r) {
            (None | Some(Value::Null), None | Some(Value::Null)) => true,
            (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
            (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
            (Some(Value::String(a)), Some(Value::String(b))) => a == b,
            _ => false,
        }
    }
}

const SUBCOMMANDS: [&str; 10] = [
    "classify-run-failure",
    "run-failure-text",
    "contains-tool-limit-failure",
    "detect-codex-auth-failure",
    "stability-env",
    "stability-compute",
    "run-context",
    "session-reset",
    "output-validation",
    "progress-evidence",
];

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

fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    if !SUBCOMMANDS.contains(&subcommand) {
        return Err(format!(
            "usage: paperclip-heartbeat-core <{}>",
            SUBCOMMANDS.join("|")
        ));
    }
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    if input.is_null() {
        // JS: reading a named property off null throws TypeError; non-object
        // non-null inputs just read every field as undefined.
        return Err("Cannot read properties of null".to_string());
    }
    match subcommand {
        "classify-run-failure" => classify::classify_run_failure(&input),
        "run-failure-text" => Ok(json!(classify::run_failure_text(&input))),
        "contains-tool-limit-failure" => Ok(json!(classify::contains_tool_limit(&input))),
        "detect-codex-auth-failure" => classify::detect_codex_auth(&input),
        "stability-env" => stability::stability_env(&input),
        "stability-compute" => stability::stability_compute(&input),
        "run-context" => Ok(stability::run_context(&input)),
        "session-reset" => Ok(stability::session_reset(&input)),
        "output-validation" => stability::output_validation(&input),
        _ => stability::progress_evidence(&input),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(format!(
            "usage: paperclip-heartbeat-core <{}>",
            SUBCOMMANDS.join("|")
        ));
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let out = dispatch(subcommand, &raw)?;
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

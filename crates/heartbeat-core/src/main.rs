//! paperclip-heartbeat-core — Stage 1 soft-mode port of the pure heartbeat
//! classification modules:
//!   server/src/services/heartbeat-failure-classification.ts
//!   server/src/services/heartbeat-codex-auth-classification.ts
//! stdin JSON -> stdout JSON subcommands. Err(_) mirrors TS throws (TypeError
//! etc.): the message goes to stderr and the process exits 1.
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

mod classify;

/// JS-semantics shims — same conventions as paperclip-mission-core/js and
/// paperclip-workflow-core/js_value.
#[rustfmt::skip]
mod js {
    use serde_json::Value;

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
}

const SUBCOMMANDS: [&str; 4] = [
    "classify-run-failure",
    "run-failure-text",
    "contains-tool-limit-failure",
    "detect-codex-auth-failure",
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
        _ => classify::detect_codex_auth(&input),
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

//! paperclip-verdict-core — Stage 2.1 soft-mode port of the pure verdict
//! helpers in server/src/services/validation-verdict.ts (readExplicitValidationVerdict)
//! and quality-verdict-routing.ts (resolveQualityVerdictRouting, routing.rs).
//! Contract: stdin JSON -> stdout JSON, V8 TypeError texts mirrored verbatim.
//!
//! JS regex semantics mapped onto the regex crate: `iu` -> `(?i)`; JS `\s` =
//! White_Space minus U+0085 (NEL) plus U+FEFF (explicit JS_WS class below);
//! JS `iu` `\b` -> ASCII `(?-u:\b)` once the two non-ASCII `iu` word chars
//! (U+017F -> s, U+212A -> k) are folded on the normalized line.

use regex::Regex;
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;
use std::sync::LazyLock;

mod routing;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

fn js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// JS `\s` class body: White_Space minus U+0085 (NEL), plus U+FEFF.
const JS_WS: &str = r"\t\n\x0b\x0c\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// JS `iu` counts U+017F/U+212A as word chars (they fold to s/k); folding them
/// lets ASCII `(?-u:\b)` reproduce `iu` boundary semantics.
fn fold_iu(s: &str) -> String {
    s.replace('\u{17f}', "s").replace('\u{212a}', "k")
}

/// JS truthy: null/false/±0/"" are falsy; NaN cannot arrive via JSON.
fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false))
        && v.as_f64() != Some(0.0)
        && v.as_str() != Some("")
}

/// JS property read: null/undefined receivers throw the V8 TypeError text,
/// primitives and arrays yield `undefined`, objects yield the stored value.
fn js_prop<'a>(v: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match v {
        None => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')")),
        Some(Value::Object(m)) => Ok(m.get(key)),
        Some(_) => Ok(None),
    }
}

static RE_STRIP_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[>{JS_WS}-]*#+[{JS_WS}]*")).unwrap());
static RE_STRIP_BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[>{JS_WS}-]*[-*][{JS_WS}]*")).unwrap());
static RE_TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[`*_]").unwrap());
static RE_WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{JS_WS}]+")).unwrap());
static RE_TEMPLATE_GUARD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?i)^PASS[{JS_WS}]+or[{JS_WS}]+REQUEST[_{JS_WS}-]?CHANGES(?-u:\\b)"
    ))
    .unwrap()
});
static RE_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?i)^(?:QA[{JS_WS}]+)?(?:verdict|decision|outcome|status|판정|결론)$"
    ))
    .unwrap()
});
static RE_PASS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^PASS$").unwrap());
static LINE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        format!("(?i)^(REQUEST[_{JS_WS}-]?CHANGES|PASS)(?:(?-u:\\b)|[{JS_WS}:：—–-])"),
        format!("(?i)^(?:[a-z][A-Za-z0-9_{JS_WS}-]*[{JS_WS}]+)?(?:verdict|decision|outcome|status)[{JS_WS}]*[:：=-][{JS_WS}]*(REQUEST[_{JS_WS}-]?CHANGES|PASS)(?-u:\\b)"),
        format!("(?i)^(?:verdict|decision|outcome|status|QA[{JS_WS}]+verdict|판정|결론)[{JS_WS}]*[:：=-][{JS_WS}]*(REQUEST[_{JS_WS}-]?CHANGES|PASS)(?-u:\\b)"),
        format!("(?i)^validation[{JS_WS}]+complete[{JS_WS}]*[:：=-][{JS_WS}]*(REQUEST[_{JS_WS}-]?CHANGES|PASS)(?-u:\\b)"),
        format!("(?i)^mission[{JS_WS}]+validation[{JS_WS}]+gate[{JS_WS}]*[:：=-][{JS_WS}]*(REQUEST[_{JS_WS}-]?CHANGES)(?-u:\\b)"),
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

fn is_markdown_rule(s: &str) -> bool {
    s.chars().count() >= 3 && s.chars().all(|c| matches!(c, '-' | '*' | '_'))
}

fn normalize_verdict_line(line: &str) -> String {
    let s = RE_STRIP_HEADING.replace(line, "");
    let s = RE_STRIP_BULLET.replace(&s, "");
    let s = RE_TICKS.replace_all(&s, "");
    fold_iu(js_trim(&RE_WS_RUN.replace_all(&s, " ")))
}

fn read_verdict_from_line(line: &str) -> Option<&'static str> {
    let compact = normalize_verdict_line(line);
    if compact.is_empty() || RE_TEMPLATE_GUARD.is_match(&compact) {
        return None;
    }
    for re in LINE_PATTERNS.iter() {
        if let Some(label) = re.captures(&compact).and_then(|c| c.get(1)) {
            return Some(if RE_PASS.is_match(js_trim(label.as_str())) {
                "pass"
            } else {
                "request_changes"
            });
        }
    }
    None
}

fn json_verdict(v: Option<&'static str>) -> Value {
    v.map_or(Value::Null, |s| json!(s))
}

fn read_explicit_validation_verdict(
    value: Option<&Value>,
    options: Option<&Value>,
) -> Result<Value, String> {
    // `if (!value) return null` — JS falsy set.
    let truthy_value = match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    };
    if !truthy_value {
        return Ok(Value::Null);
    }
    let Some(Value::String(text)) = value else {
        return Err("value.split is not a function".to_string());
    };
    // split(/\r?\n/), trim each, drop empty lines and markdown rules (the rule
    // test runs on the line with *all* JS whitespace removed).
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .map(js_trim)
        .filter(|l| {
            !l.is_empty()
                && !is_markdown_rule(&l.chars().filter(|c| !js_ws(*c)).collect::<String>())
        })
        .map(str::to_string)
        .collect();
    if lines.is_empty() {
        return Ok(Value::Null);
    }
    if let Some(v) = read_verdict_from_line(lines.last().unwrap()) {
        return Ok(json!(v));
    }
    // First explicit heading decides: its next non-skipped line's verdict is
    // returned even when it is null (early return, no further headings tried).
    for (i, line) in lines.iter().enumerate().take(lines.len() - 1) {
        if !RE_HEADING.is_match(&normalize_verdict_line(line)) {
            continue;
        }
        for cand in &lines[i + 1..] {
            let t = js_trim(cand);
            if t.is_empty() || is_markdown_rule(t) {
                continue;
            }
            return Ok(json_verdict(read_verdict_from_line(cand)));
        }
    }
    // options.allowLeadingVerdict is read lazily, exactly like the TS tail.
    let allow = match options {
        None => false,
        Some(Value::Null) => {
            return Err(
                "Cannot read properties of null (reading 'allowLeadingVerdict')".to_string(),
            )
        }
        Some(Value::Object(m)) => m.get("allowLeadingVerdict").is_some_and(truthy),
        Some(_) => false,
    };
    if allow {
        return Ok(json_verdict(read_verdict_from_line(&lines[0])));
    }
    Ok(Value::Null)
}

fn read_stdin_bounded(max: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    io::stdin()
        .take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > max {
        return Err(format!("stdin exceeds {max} byte limit"));
    }
    Ok(buf)
}

fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let payload: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "read-explicit-validation-verdict" => read_explicit_validation_verdict(
            js_prop(Some(&payload), "value")?,
            js_prop(Some(&payload), "options")?,
        ),
        "resolve-quality-verdict-routing" => {
            routing::resolve_quality_verdict_routing(js_prop(Some(&payload), "input")?)
        }
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first() else {
        return Err(
            "usage: paperclip-verdict-core <read-explicit-validation-verdict|resolve-quality-verdict-routing>"
                .to_string(),
        );
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

#[cfg(test)]
#[rustfmt::skip] // hand-compacted to honor the 300-line file limit
mod tests {
    use super::*;

    fn verdict(payload: Value) -> Result<Value, String> {
        dispatch("read-explicit-validation-verdict", &serde_json::to_vec(&payload).unwrap())
    }

    #[test]
    fn terminal_heading_and_leading_paths() {
        let ok = |payload: Value| verdict(payload).unwrap();
        let lead = json!({"allowLeadingVerdict": true});
        assert_eq!(ok(json!({"value": "PASS noted\nreason\nREQUEST_CHANGES: fix"})), json!("request_changes"));
        assert_eq!(ok(json!({"value": "text\n## QA verdict\n\nPASS\ntail"})), json!("pass"));
        assert_eq!(ok(json!({"value": "PASS\n- ok"})), Value::Null);
        assert_eq!(ok(json!({"value": "PASS\n- ok", "options": lead})), json!("pass"));
    }

    #[test]
    fn template_guard_and_boundaries() {
        let ok = |payload: Value| verdict(payload).unwrap();
        let lead = json!({"allowLeadingVerdict": true});
        assert_eq!(ok(json!({"value": "PASS or REQUEST_CHANGES", "options": lead})), Value::Null);
        assert_eq!(ok(json!({"value": "PASSWORD"})), Value::Null);
        assert_eq!(ok(json!({"value": "PASS."})), json!("pass"));
        assert_eq!(ok(json!({"value": "mission validation gate: PASS"})), Value::Null);
    }

    #[test]
    fn js_semantics_edges() {
        assert_eq!(
            verdict(json!({"value": "Verdict: PASS"})).unwrap(),
            json!("pass")
        );
        assert_eq!(
            verdict(json!({"value": 5})).unwrap_err(),
            "value.split is not a function"
        );
        assert_eq!(verdict(json!({"value": ""})).unwrap(), Value::Null);
        assert_eq!(
            verdict(json!({"value": "noise\nnoise", "options": null})).unwrap_err(),
            "Cannot read properties of null (reading 'allowLeadingVerdict')"
        );
        assert_eq!(verdict(json!({"value": "Pa\u{17f}\u{17f}"})).unwrap(), json!("pass"));
        assert_eq!(verdict(json!({"value": "PASS\u{212a}"})).unwrap(), Value::Null);
        assert_eq!(verdict(json!({"value": "\u{85}PASS\u{85}"})).unwrap(), Value::Null);
        assert_eq!(verdict(json!({"value": "PASS\u{85}"})).unwrap(), json!("pass"));
    }

    #[test]
    fn routing_dispatch() {
        assert_eq!(
            dispatch("resolve-quality-verdict-routing", br#"{"input":{"verdict":"needs_evidence","requiredEvidenceSurfaces":[" a ",""]}}"#).unwrap(),
            json!({"kind": "evidence", "reason": null, "requiredEvidenceSurfaces": ["a"]})
        );
        assert!(dispatch("bogus", b"{}").is_err());
    }
}

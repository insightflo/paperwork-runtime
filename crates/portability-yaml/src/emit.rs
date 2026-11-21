//! Hand-rolled YAML emitter mirroring `server/src/services/company-portability-yaml.ts`
//! byte-for-byte (parsing stays in TS; `localeCompare` + `String(number)` parity).

use icu_collator::options::CollatorOptions;
use icu_collator::CollatorBorrowed;
use icu_locale_core::{locale, Locale};
use serde_json::{Map, Number, Value};
use std::cmp::Ordering;
use std::env;
use std::sync::OnceLock;

/// Node default locale resolution: LC_ALL > LANG (empty skipped),
/// C/POSIX/unset/unparseable → en-US. Same contract as workflow-core.
fn default_locale() -> Locale {
    for key in ["LC_ALL", "LANG"] {
        let Ok(v) = env::var(key) else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        let tag = v
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .replace('_', "-");
        return match tag.as_str() {
            "" | "C" | "POSIX" => locale!("en-US"),
            _ => tag.parse().unwrap_or(locale!("en-US")),
        };
    }
    locale!("en-US")
}

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLL: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLL.get_or_init(|| {
        CollatorBorrowed::try_new(default_locale().into(), CollatorOptions::default())
            .or_else(|_| {
                CollatorBorrowed::try_new(locale!("en-US").into(), CollatorOptions::default())
            })
            .expect("icu collator compiled data unavailable")
    })
}

/// `(a, b) => a.localeCompare(b)` — real ICU collation at the Node default
/// locale, so non-ASCII keys (`é` < `z`, `Ö` < `Z`) order like V8.
fn compare_js_keys(left: &str, right: &str) -> Ordering {
    collator().compare(left, right)
}

/// ECMAScript WhiteSpace+LT — Rust `is_whitespace` minus U+0085 (NEL), plus
/// U+FEFF (BOM). JS `String#trim` keeps NEL; Rust `str::trim` strips it.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}'))
}

/// YAML key priority list from the TS emitter, comma-separated.
const YAML_KEY_PRIORITY: &str = "name,description,title,schema,kind,slug,reportsTo,skills,owner,assignee,project,schedule,version,license,authors,homepage,tags,includes,requirements,role,icon,capabilities,brandColor,logoPath,adapter,runtime,permissions,budgetMonthlyCents,metadata";

fn compare_yaml_keys(left: &str, right: &str) -> Ordering {
    let lp = YAML_KEY_PRIORITY.split(',').position(|k| k == left);
    let rp = YAML_KEY_PRIORITY.split(',').position(|k| k == right);
    match (lp, rp) {
        (Some(l), Some(r)) => l.cmp(&r),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => compare_js_keys(left, right),
    }
}

fn ordered_yaml_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<_> = object.iter().collect();
    entries.sort_by(|(l, _), (r, _)| compare_yaml_keys(l, r));
    entries
}

/// Mirrors `stripEmptyValues`: returns `None` where the TS function returns
/// `undefined` (entry dropped from the parent).
pub fn strip_empty_values(value: &Value, preserve_empty_strings: bool) -> Option<Value> {
    match value {
        Value::Array(entries) => {
            let next: Vec<Value> = entries
                .iter()
                .filter_map(|entry| strip_empty_values(entry, preserve_empty_strings))
                .collect();
            if next.is_empty() {
                None
            } else {
                Some(Value::Array(next))
            }
        }
        Value::Object(object) => {
            let mut next = Map::new();
            for (key, entry) in object {
                if let Some(cleaned) = strip_empty_values(entry, preserve_empty_strings) {
                    next.insert(key.clone(), cleaned);
                }
            }
            if next.is_empty() {
                None
            } else {
                Some(Value::Object(next))
            }
        }
        Value::Null => None,
        Value::String(s) if s.is_empty() && !preserve_empty_strings => None,
        other => Some(other.clone()),
    }
}

/// Renders numbers like JS `String(value)` (ECMA-262 `Number::toString`).
/// `JSON.parse` produces doubles for every literal — i64/u64 digits beyond
/// 2^53 must round like V8 (9007199254740993 → 9007199254740992).
fn js_number_to_string(number: &Number) -> String {
    js_f64_to_string(number.as_f64().unwrap_or_default())
}

fn js_f64_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string(); // covers -0, matching String(-0)
    }
    // Rust's LowerExp gives shortest round-tripping digits "d[.ddd]e±X".
    let rendered = format!("{:e}", value);
    let (mantissa, exponent) = rendered.split_once('e').unwrap_or((rendered.as_str(), "0"));
    let exp: i32 = exponent.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let (k, n) = (digits.len() as i32, exp + 1); // n: decimal point pos, ECMA-262 step 5
    let mut out = if negative {
        "-".to_string()
    } else {
        String::new()
    };
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.push_str(&"0".repeat((n - k) as usize));
    } else if n > 0 && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if n > -6 && n <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat((-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// Mirrors `renderYamlScalar`: strings (and the unreachable fallback) go
/// through `JSON.stringify`, which `serde_json::to_string` reproduces for
/// valid Unicode scalar input.
fn render_yaml_scalar(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n),
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The per-branch scalar test in the TS renderer: null/string/bool/number,
/// plus empty containers rendered inline (`[]`/`{}`).
fn is_scalar_like(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    ) || matches!(value, Value::Array(entries) if entries.is_empty())
        || matches!(value, Value::Object(object) if object.is_empty())
}

/// Pushes `line` plus the inline scalar or nested block (TS renderer pattern).
fn push_entry(lines: &mut Vec<String>, line: String, value: &Value, level: usize) {
    if is_scalar_like(value) {
        lines.push(format!("{line} {}", render_yaml_scalar(value)));
    } else {
        lines.push(line);
        lines.extend(render_yaml_block(value, level));
    }
}

/// Mirrors `renderYamlBlock`.
fn render_yaml_block(value: &Value, indent_level: usize) -> Vec<String> {
    let indent = "  ".repeat(indent_level);
    if let Value::Array(entries) = value {
        if entries.is_empty() {
            return vec![format!("{indent}[]")];
        }
        let mut lines = Vec::new();
        for entry in entries {
            push_entry(&mut lines, format!("{indent}-"), entry, indent_level + 1);
        }
        return lines;
    }
    if let Value::Object(object) = value {
        let entries = ordered_yaml_entries(object);
        if entries.is_empty() {
            return vec![format!("{indent}{{}}")];
        }
        let mut lines = Vec::new();
        for (key, entry) in entries {
            push_entry(
                &mut lines,
                format!("{indent}{key}:"),
                entry,
                indent_level + 1,
            );
        }
        return lines;
    }
    vec![format!("{indent}{}", render_yaml_scalar(value))]
}

/// Mirrors `renderFrontmatter`: top-level null entries are skipped entirely.
fn render_frontmatter(frontmatter: &Map<String, Value>) -> String {
    let mut lines = vec!["---".to_string()];
    for (key, value) in ordered_yaml_entries(frontmatter) {
        if value.is_null() {
            continue;
        }
        if is_scalar_like(value) {
            lines.push(format!("{key}: {}", render_yaml_scalar(value)));
        } else {
            lines.push(format!("{key}:"));
            lines.extend(render_yaml_block(value, 1));
        }
    }
    lines.push("---".to_string());
    format!("{}\n", lines.join("\n"))
}

/// Mirrors `buildMarkdown`.
pub fn build_markdown(frontmatter: &Map<String, Value>, body: &str) -> String {
    let frontmatter = render_frontmatter(frontmatter);
    let replaced = body.replace("\r\n", "\n");
    let clean_body = js_trim(&replaced);
    if clean_body.is_empty() {
        format!("{frontmatter}\n")
    } else {
        format!("{frontmatter}\n{clean_body}\n")
    }
}

/// Mirrors `buildYamlFile`.
pub fn build_yaml_file(value: &Value, preserve_empty_strings: bool) -> String {
    match strip_empty_values(value, preserve_empty_strings) {
        Some(Value::Object(object)) => {
            format!(
                "{}\n",
                render_yaml_block(&Value::Object(object), 0).join("\n")
            )
        }
        _ => "{}\n".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mirrors_ts_snapshot_and_ordering() {
        for pair in "100=100|1.5=1.5|0.1=0.1|1e20=100000000000000000000|1e21=1e+21|1e-6=0.000001|1e-7=1e-7|0=0".split('|') {
            let (raw, expected) = pair.split_once('=').unwrap();
            assert_eq!(js_f64_to_string(raw.parse().unwrap()), expected);
        }
        // ICU collation at the Node default locale: `_` < `-`, digits <
        // letters, case tiebreak; accented Latin sorts at its base letter.
        let mut keys: Vec<&str> =
            "user_role|userRole|User_Role|_id|10|b_x|b-x|a b|a-b|ab|étag|Öland"
                .split('|')
                .collect();
        keys.sort_by(|l, r| compare_js_keys(l, r));
        assert_eq!(
            keys.join("|"),
            "_id|10|a b|a-b|ab|b_x|b-x|étag|Öland|user_role|User_Role|userRole"
        );
        assert_eq!(js_trim("\u{feff}x\u{feff}"), "x");
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        let mut mixed: Vec<&str> = "zebra|name|adapter|apple".split('|').collect();
        mixed.sort_by(|l, r| compare_yaml_keys(l, r));
        assert_eq!(mixed.join("|"), "name|adapter|apple|zebra");
        let value = json!({"name": "a", "tags": [], "draft": null, "count": 3});
        assert_eq!(build_yaml_file(&value, false), "name: \"a\"\ncount: 3\n");
    }
}

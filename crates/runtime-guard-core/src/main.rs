// Stage 1.1 soft-mode Rust port of runtime-shell-command-utils.ts,
// runtime-command-extractor.ts and the pure broad-scan decision policy.
// stdin JSON -> stdout JSON subcommands; see policy.rs for the guard evaluator.
mod policy;
use policy::{find_runtime_broad_scan_command, ScanInput};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process;
use std::sync::OnceLock;
// JS \s = Unicode White_Space minus U+0085 (NEL) plus U+FEFF (ZWNBSP); Rust
// \s/is_whitespace cover White_Space only, so JS-regex whitespace points are
// spelled out with the explicit class below.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
pub(crate) const JS_WS_INNER: &str =
    r"\x09-\x0D\x20\xA0\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}
fn str_arg<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or("")
}
pub(crate) fn shell_tokenize(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match (quote, c) {
            (Some(q), ch) if ch == q => quote = None,
            (Some(_), ch) => current.push(ch),
            (None, '\'' | '"' | '`') => quote = Some(c),
            (None, ch) if is_js_space(ch) => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            (None, ch) => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}
pub(crate) fn strip_shell_comment_lines(command: &str) -> String {
    let w = JS_WS_INNER;
    let comment = re(&format!(
        r#"^([{w}]*(?:/bin/)?(?:ba)?sh[{w}]+-[a-z]*c[{w}]+['"]?)[{w}]*#"#
    ));
    let out = command
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            match comment.captures(line) {
                Some(cap) => cap.get(1).map_or("", |m| m.as_str()).to_string(),
                None if line.trim_start_matches(is_js_space).starts_with('#') => String::new(),
                None => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    js_trim(&out).to_string()
}
pub(crate) fn clean_shell_token(token: &str) -> String {
    token
        .trim_start_matches(['\'', '"', '`'])
        .trim_end_matches(['\'', '"', '`', ',', ':', ';', '!', '?'])
        .to_string()
}
#[derive(Serialize)]
pub(crate) struct ShellSegment {
    pub command: String,
    #[serde(rename = "stdinFromPipe")]
    pub stdin_from_pipe: bool,
}
// JS split-with-capture interleaves [text, separator, text, ...]; find_iter
// spans rebuild that sequence, then the same previous-operator rule applies.
pub(crate) fn split_runtime_shell_segments(command: &str) -> Vec<ShellSegment> {
    let w = JS_WS_INNER;
    let sep = re(&format!(
        r"[{w}]+&&[{w}]+|[{w}]+\|\|[{w}]+|;|[{w}]+\|[{w}]+"
    ));
    let mut parts = Vec::new();
    let mut last = 0;
    for m in sep.find_iter(command) {
        parts.push(&command[last..m.start()]);
        parts.push(m.as_str());
        last = m.end();
    }
    parts.push(&command[last..]);
    let mut segments = Vec::new();
    let mut previous: Option<&str> = None;
    for trimmed in parts.iter().map(|p| js_trim(p)).filter(|t| !t.is_empty()) {
        if matches!(trimmed, "&&" | "||" | ";" | "|") {
            previous = Some(trimmed);
            continue;
        }
        segments.push(ShellSegment {
            command: trimmed.to_string(),
            stdin_from_pipe: previous == Some("|"),
        });
        previous = None;
    }
    segments
}
pub(crate) fn extract_shell_variable_assignments(command: &str) -> HashMap<String, String> {
    let w = JS_WS_INNER;
    let assignment = re(&format!(
        r#"(?:^|[{w};])([a-z_][a-z0-9_]*)=(?:"([^"\n;]+)"|'([^'\n;]+)'|([^{w};]+))"#
    ));
    let mut vars = HashMap::new();
    for cap in assignment.captures_iter(command) {
        let name = cap.get(1).map_or("", |m| m.as_str());
        let value = cap
            .get(2)
            .or_else(|| cap.get(3))
            .or_else(|| cap.get(4))
            .map_or("", |m| m.as_str());
        if !name.is_empty() && !value.is_empty() {
            vars.insert(name.to_string(), clean_shell_token(value));
        }
    }
    vars
}
pub(crate) fn normalize_runtime_shell_command(command: &str) -> String {
    strip_shell_comment_lines(js_trim(command))
}
fn empty_map() -> &'static Map<String, Value> {
    static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
    EMPTY.get_or_init(Map::new)
}
fn pobj(v: Option<&Value>) -> &Map<String, Value> {
    match v.and_then(Value::as_object) {
        Some(m) => m,
        None => empty_map(),
    }
}
fn sf<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}
fn stf(o: &Map<String, Value>, k: &str) -> Option<String> {
    sf(o, k).map(str::to_string)
}
// Hermes TUI lines render shell invocations as "┊ 💻 $ <cmd>"; ANSI escapes and
// border glyphs are stripped before matching the "💻 $ " prompt, mirroring TS.
fn extract_hermes_shell_command(line: &str) -> Option<String> {
    const BORDERS: &str = "│┊╭╰╮╯┌└┐┘├┤─━═";
    let no_ansi = re(r"\x1b\[[0-9;?]*[ -/]*[@-~]").replace_all(line, "");
    let stripped =
        js_trim(no_ansi.trim_start_matches(|c: char| is_js_space(c) || BORDERS.contains(c)));
    let rest = stripped.strip_prefix('💻')?.trim_start_matches(is_js_space);
    let rest = rest.strip_prefix('$')?.trim_start_matches(is_js_space);
    // `.` in the JS regex cannot cross line terminators.
    if rest.is_empty() || rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let out = js_trim(rest);
    (!out.is_empty()).then(|| out.to_string())
}
fn extract_runtime_command(adapter: &str, line: &str) -> Option<String> {
    if adapter == "hermes_local" {
        return extract_hermes_shell_command(line);
    }
    let parsed_v: Value = serde_json::from_str(line).ok()?;
    let parsed = pobj(Some(&parsed_v));
    let is = |o: &Map<String, Value>, k: &str, want: &str| sf(o, k) == Some(want);
    let req = |ok: bool| ok.then_some(());
    match adapter {
        "codex_local" => {
            req(is(parsed, "type", "item.started"))?;
            let item = pobj(parsed.get("item"));
            req(is(item, "type", "command_execution"))?;
            stf(item, "command")
        }
        "claude_local" => {
            req(is(parsed, "type", "assistant"))?;
            let content = pobj(parsed.get("message"))
                .get("content")
                .and_then(Value::as_array);
            for raw in content.map_or(&[][..], Vec::as_slice) {
                let block = pobj(Some(raw));
                if is(block, "type", "tool_use")
                    && matches!(sf(block, "name"), Some("bash" | "shell"))
                {
                    return stf(pobj(block.get("input")), "command");
                }
            }
            None
        }
        "cursor" | "gemini_local" => {
            req(is(parsed, "type", "tool_call"))?;
            let subtype = sf(parsed, "subtype").unwrap_or("").to_lowercase();
            req(matches!(subtype.as_str(), "started" | "start"))?;
            let tc = match parsed.get("tool_call") {
                Some(v) if !v.is_null() => Some(v),
                _ => parsed.get("toolCall"),
            };
            let tool_call = pobj(tc);
            let tool_name = tool_call.keys().next().map_or("", String::as_str);
            req(matches!(tool_name, "shellToolCall" | "shell"))?;
            let payload = pobj(tool_call.get(tool_name));
            let direct = payload
                .get("args")
                .filter(|v| !v.is_null())
                .or_else(|| payload.get("input").filter(|v| !v.is_null()));
            stf(direct.map_or(payload, |v| pobj(Some(v))), "command")
        }
        "opencode_local" => {
            req(is(parsed, "type", "tool_use"))?;
            let part = pobj(parsed.get("part"));
            req(is(part, "tool", "bash"))?;
            stf(pobj(pobj(part.get("state")).get("input")), "command")
        }
        "pi_local" => {
            req(is(parsed, "type", "tool_execution_start"))?;
            match sf(parsed, "toolName") {
                Some("bash" | "shell") => stf(pobj(parsed.get("args")), "command"),
                _ => None,
            }
        }
        "commandcode_local" => {
            req(is(parsed, "type", "event"))?;
            let event = pobj(parsed.get("event"));
            req(is(event, "type", "tool_queued"))?;
            match sf(event, "toolName") {
                Some("shell_command" | "bash" | "shell") => {
                    stf(pobj(event.get("input")), "command")
                }
                _ => None,
            }
        }
        _ => None,
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(String::as_str).unwrap_or("");
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        process::exit(1);
    }
    let payload: Value = serde_json::from_str(&input).unwrap_or_else(|e| {
        eprintln!("bad stdin json: {e}");
        process::exit(1);
    });
    let out = match sub {
        "extract-command" => json!(extract_runtime_command(
            str_arg(&payload, "adapterType"),
            str_arg(&payload, "line")
        )),
        "clean-token" => json!(clean_shell_token(str_arg(&payload, "token"))),
        "broad-scan" => match serde_json::from_value::<ScanInput>(payload) {
            Ok(input) => json!(find_runtime_broad_scan_command(&input)),
            Err(e) => {
                eprintln!("bad input: {e}");
                process::exit(1);
            }
        },
        "tokenize" => json!(shell_tokenize(str_arg(&payload, "command"))),
        "strip-comments" => json!(strip_shell_comment_lines(str_arg(&payload, "command"))),
        "normalize" => json!(normalize_runtime_shell_command(str_arg(
            &payload, "command"
        ))),
        "segments" => json!(split_runtime_shell_segments(str_arg(&payload, "command"))),
        "variables" => json!(extract_shell_variable_assignments(str_arg(
            &payload, "command"
        ))),
        _ => {
            eprintln!("usage: paperclip-runtime-guard-core <extract-command|clean-token|broad-scan|tokenize|strip-comments|normalize|segments|variables>");
            process::exit(1);
        }
    };
    println!("{out}");
}

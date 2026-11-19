use aho_corasick::{AhoCorasick, MatchKind};
use regex::{Captures, Regex};
use serde_json::{Map, Value};
use std::{borrow::Cow, collections::HashSet, sync::LazyLock};

const MIN_REGISTERED_SECRET_LEN: usize = 8;
const MAX_EMBEDDED_SCANS: usize = 16;
const MAX_CONVERSION_DEPTH: usize = 32;
const MAX_SAFE_JS_INT: i64 = 9_007_199_254_740_991;
const UNSCANNED: &str = "[redacted-unscanned]";
const VALUE_MARKER: &str = "__paperclip_registered_value__";
const LABEL_MARKER: &str = "__paperclip_registered_secret_authorization";
macro_rules! re { ($p:expr) => { LazyLock::new(|| Regex::new($p).expect("valid static regex")) } }
static PEM_BEGIN_RE: LazyLock<Regex> = re!(r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----");
static PEM_END_RE: LazyLock<Regex> = re!(r"-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----");
static PEM_TAIL_RE: LazyLock<Regex> = re!(r"\A(?:\\[rn]|[\s\u{FEFF}])*[A-Za-z0-9+/=]{16,}"); static JWT_RE: LazyLock<Regex> = re!(r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*");
static COOKIE_PREFIX_RE: LazyLock<Regex> = re!(r#"(?i)((?-u:\b)cookie["']?[\s\u{FEFF}]*:[\s\u{FEFF}]*["']?)[^\s\u{FEFF}=;,"'\\]{1,256}="#);
static AUTH_HEADER_RE: LazyLock<Regex> = re!(r#"(?i)(authorization["']?[\s\u{FEFF}]*[=:]+[\s\u{FEFF}]*)(?:Bearer|Basic|Digest|Token)[\s\u{FEFF}]+[A-Za-z0-9._~+/=-]{8,}"#);
static BEARER_RE: LazyLock<Regex> = re!(r"(?i)Bearer[\s\u{FEFF}]+[A-Za-z0-9._~+/=-]{8,}"); static EMAIL_RE: LazyLock<Regex> = re!(r"(?i)[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}");
static CREDENTIAL_RE: LazyLock<Regex> = re!(r#"(?i)(["']?[A-Za-z0-9_.-]{0,64}(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]{0,64}["']?[\s\u{FEFF}]*[=:]+[\s\u{FEFF}]*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s\u{FEFF},;)}\]]+)"#);
static JSON_BARE_KEY_RE: LazyLock<Regex> = re!(r#"(?i)("keys?"[\s\u{FEFF}]*:[\s\u{FEFF}]*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s\u{FEFF},;)}\]]+)"#); static HEADER_KEY_RE: LazyLock<Regex> = re!(r"(?i)\Aheaders\z");
static QUERY_PREFIX_RE: LazyLock<Regex> = re!(r#"(?i)([?&](?:key|code|ticket|sig)=)([^&#\s\u{FEFF}"'<>)\]]{8,})"#);
static KNOWN_PREFIX_RE: LazyLock<Regex> = re!(r"(?:(?:sk-ant|sk-|sk_|xai-|ghp_|gho_|ghu_|ghr_|ghs_|github_pat_|AKIA|xox[abeoprs]-|xapp-|glpat-|rk_live_|rk_test_)[A-Za-z0-9._-]{8,}|whsec_[A-Za-z0-9+/=._-]{8,}|AIza[A-Za-z0-9_-]{30,}|(?:npm|hf|gsk)_[A-Za-z0-9]{30,}|ASIA[A-Z0-9]{16})");
static SECRET_KEY_RE: LazyLock<Regex> = re!(r"(?i)\A(?:[A-Za-z0-9_.-]{0,64}(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]{0,64}|keys?)\z");
static RULE_WORD_RE: LazyLock<Regex> = re!(r"(?i)password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key|bearer|basic|digest|headers|keys?"); static URL_HOST_RE: LazyLock<Regex> = re!(r"(?i)(https?://(?:[^\s\u{FEFF}/?#@]*@)?)([\p{L}\p{N}.-]+)");

#[derive(Default)]
pub struct SecretRegistry { literals: HashSet<String>, ac: Option<AhoCorasick> }

impl SecretRegistry {
    pub fn register_secrets(&mut self, values: &[&str], allow_short: bool) {
        let before = self.literals.len();
        for &val in values {
            if val.is_empty() || (!allow_short && val.encode_utf16().count() < MIN_REGISTERED_SECRET_LEN) { continue; }
            self.literals.insert(val.to_string());
            if let Ok(esc) = serde_json::to_string(val) { if esc.len() > 2 { self.literals.insert(esc[1..esc.len() - 1].to_string()); } }
            let enc = encode_uri_component(val); if !enc.is_empty() { self.literals.insert(enc); }
        }
        if self.literals.len() != before { self.rebuild(); }
    }
    pub fn set_literal_secrets(&mut self, literals: &[&str]) {
        let next: HashSet<String> = literals.iter().filter(|s| !s.is_empty()).map(|s| (*s).to_string()).collect();
        if next != self.literals { self.literals = next; self.rebuild(); }
    }
    pub fn clear(&mut self) { self.literals.clear(); self.ac = None; }
    fn rebuild(&mut self) {
        self.ac = (!self.literals.is_empty()).then(|| AhoCorasick::builder().match_kind(MatchKind::LeftmostLongest).build(&self.literals).ok()).flatten();
    }
    /// Returns `None` when JS parsing/serialization parity requires the TS fallback.
    pub fn redact_sensitive_text(&self, value: &str, emails: bool, keep_unscanned: bool) -> Option<String> {
        let (marked, did_mark) = self.mark_registered_secrets(value);
        let trimmed = marked.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
        let whole = if trimmed.starts_with('{') || trimmed.starts_with('[') { self.parse_redacted_json(trimmed, emails).ok()? } else { None };
        let redacted = match whole { Some(s) => s, None => apply_text_rules(&self.redact_embedded_json(&marked, emails, keep_unscanned)?, emails) };
        Some(if did_mark { redacted.replace(VALUE_MARKER, "[redacted]").replace(LABEL_MARKER, "[redacted]") } else { redacted })
    }
    pub fn redact_embedded_json(&self, value: &str, emails: bool, keep_unscanned: bool) -> Option<String> {
        let (bytes, mut out, mut index, mut scans) = (value.as_bytes(), String::with_capacity(value.len()), 0usize, 0usize);
        while index < bytes.len() {
            let Some(rel) = bytes[index..].iter().position(|&b| b == b'{' || b == b'[') else { break };
            let start = index + rel;
            if !starts_like_json(value, start) {
                let mut next = start + 1;
                while next < bytes.len() && matches!(bytes[next], b'{' | b'[') { next += 1; }
                out.push_str(&value[index..next]); index = next; continue;
            }
            if scans >= MAX_EMBEDDED_SCANS {
                if keep_unscanned { out.push_str(&value[index..]); } else { out.push_str(&value[index..start]); out.push_str(UNSCANNED); }
                return Some(out);
            }
            scans += 1; let Some(end) = find_balanced_end(bytes, start) else { out.push_str(&value[index..start]); out.push_str(UNSCANNED); return Some(out); };
            out.push_str(&value[index..start]);
            match self.parse_redacted_json(&value[start..end], emails) {
                Ok(Some(s)) => out.push_str(&s), Ok(None) => out.push_str(UNSCANNED),
                Err(()) => return None,
            }
            index = end;
        }
        out.push_str(&value[index..]); Some(out)
    }
    fn parse_redacted_json(&self, candidate: &str, emails: bool) -> Result<Option<String>, ()> {
        let parsed: Value = match serde_json::from_str(candidate) {
            Ok(v) => v,
            Err(e) => return if candidate.contains("\\u") || e.is_data() { Err(()) } else { Ok(None) },
        };
        let mut converted = self.convert_json_value(&parsed, emails, 0).ok_or(())?;
        if unchanged_key_count(&parsed, &converted) == written_key_count(candidate) { return Ok(Some(candidate.to_string())); }
        if !prepare_for_stringify(&mut converted) { return Err(()); }
        serde_json::to_string(&converted).map(Some).map_err(|_| ())
    }
    fn convert_json_value(&self, value: &Value, emails: bool, depth: usize) -> Option<Value> {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Some(value.clone()),
            Value::String(s) => Some(Value::String(self.redact_sensitive_text(s, emails, false)?)),
            Value::Array(arr) => if depth >= MAX_CONVERSION_DEPTH { Some(Value::String("[too deep]".into())) } else { arr.iter().map(|v| self.convert_json_value(v, emails, depth + 1)).collect::<Option<Vec<_>>>().map(Value::Array) },
            Value::Object(map) => if depth >= MAX_CONVERSION_DEPTH { Some(Value::String("[too deep]".into())) } else {
                let mut out = Map::with_capacity(map.len());
                for (k, entry) in map {
                    let safe_key = self.redact_sensitive_text(k, emails, false)?;
                    if SECRET_KEY_RE.is_match(k) { out.insert(safe_key, Value::String("[redacted]".into())); continue; }
                    let conv = self.convert_json_value(entry, emails, depth + 1)?;
                    out.insert(safe_key, if (entry.is_array() || entry.is_object()) && HEADER_KEY_RE.is_match(k) { redact_header_strings(conv) } else { conv });
                }
                Some(Value::Object(out))
            },
        }
    }
    fn mark_registered_secrets<'a>(&self, value: &'a str) -> (Cow<'a, str>, bool) {
        let Some(ac) = &self.ac else { return (Cow::Borrowed(value), false); };
        let (bytes, mut ranges, mut hosts) = (value.as_bytes(), Vec::<(usize, usize)>::new(), None::<Option<Vec<bool>>>);
        for m in ac.find_iter(value) {
            let (mut start, mut end) = (m.start(), m.end());
            let mask = hosts.get_or_insert_with(|| value.contains("://").then(|| url_hosts(value))).as_deref();
            if mask.is_some_and(|h| h[start..end].iter().all(|&f| f)) { continue; }
            while start > ranges.last().map_or(0, |r| r.1) && !mask.is_some_and(|h| h[start - 1]) && is_token_byte(bytes[start - 1]) { start -= 1; } if ranges.last().is_some_and(|r| end <= r.1) { continue; }
            while end < bytes.len() && !mask.is_some_and(|h| h[end]) && is_token_byte(bytes[end]) { end += 1; }
            if let Some(prev) = ranges.last_mut() { if start <= prev.1 { prev.1 = end; continue; } } ranges.push((start, end));
        }
        if ranges.is_empty() { return (Cow::Borrowed(value), false); }
        let (mut out, mut cursor) = (String::with_capacity(value.len()), 0usize);
        for (start, end) in ranges {
            out.push_str(&value[cursor..start]);
            out.push_str(if RULE_WORD_RE.is_match(&value[start..end]) { LABEL_MARKER } else { VALUE_MARKER });
            cursor = end;
        }
        out.push_str(&value[cursor..]); (Cow::Owned(out), true)
    }
}

fn encode_uri_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' | b'-') { out.push(b as char); } else { out.extend(['%', HEX[(b >> 4) as usize] as char, HEX[(b & 0x0F) as usize] as char]); }
    }
    out
}
fn is_token_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'@' | b'%' | b'-') }
fn no_prefix_word(text: &str, idx: usize) -> bool { text[..idx].chars().next_back().is_none_or(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))) }
fn url_hosts(value: &str) -> Vec<bool> {
    let (mut flags, mut cursor) = (vec![false; value.len()], 0usize);
    while let Some(caps) = URL_HOST_RE.captures_at(value, cursor) {
        let Some(full) = caps.get(0) else { break };
        if value[..full.start()].chars().next_back().is_some_and(|c| matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '.' | '-')) { cursor = full.start() + 1; continue; }
        if let Some(host) = caps.get(2) { flags[host.start()..host.end()].fill(true); }
        cursor = full.end();
    }
    flags
}
fn redact_assigned_value(caps: &Captures<'_>) -> String {
    let (label, val) = (caps.get(1).map_or("", |m| m.as_str()), caps.get(2).map_or("", |m| m.as_str()));
    let quote = if val.starts_with('"') { "\"" } else if val.starts_with('\'') { "'" } else { "" }; format!("{label}{quote}[redacted]{quote}")
}
fn apply_text_rules(value: &str, emails: bool) -> String {
    let s = replace_caps_loop(value, &PEM_BEGIN_RE, |text, caps| {
        let bm = caps.get(0)?; let rest = &text[bm.end()..];
        let end = match PEM_END_RE.find(rest) {
            Some(em) if utf16_len_within(&rest[..em.start()], 16_384) => bm.end() + em.end(),
            _ if PEM_TAIL_RE.is_match(rest) => text.len(),
            _ => return None,
        };
        Some((bm.start(), end))
    });
    let s = replace_caps_loop(&s, &COOKIE_PREFIX_RE, |text, caps| Some((caps.get(1)?.end(), caps.get(0)?.end() + scan_cookie_tail(&text[caps.get(0)?.end()..]))));
    let s = JSON_BARE_KEY_RE.replace_all(&CREDENTIAL_RE.replace_all(&BEARER_RE.replace_all(&AUTH_HEADER_RE.replace_all(&s, "${1}[redacted]"), "[redacted]"), redact_assigned_value), redact_assigned_value).into_owned();
    let s = replace_caps_loop(&s, &QUERY_PREFIX_RE, |_text, caps| {
        let (full, pfx, val) = (caps.get(0)?, caps.get(1)?, caps.get(2)?.as_str()); (!val.as_bytes().get(..10).is_some_and(|b| b.eq_ignore_ascii_case(b"[redacted]")) && has_digit_within_256(val)).then_some((pfx.end(), full.end()))
    });
    let s = replace_caps_loop(&s, &KNOWN_PREFIX_RE, |text, caps| {
        let m = caps.get(0)?; let next_ok = !m.as_str().starts_with("ASIA") || text[m.end()..].chars().next().is_none_or(|c| !c.is_ascii_alphanumeric());
        (no_prefix_word(text, m.start()) && next_ok).then_some((m.start(), m.end()))
    });
    let s = replace_caps_loop(&s, &JWT_RE, |text, caps| { let m = caps.get(0)?; no_prefix_word(text, m.start()).then_some((m.start(), m.end())) });
    if emails { EMAIL_RE.replace_all(&s, "[redacted-email]").into_owned() } else { s.into_owned() }
}
fn replace_caps_loop<'a>(text: &'a str, re: &Regex, mut accept: impl FnMut(&'a str, &Captures<'a>) -> Option<(usize, usize)>) -> Cow<'a, str> {
    let (mut out, mut last, mut cursor) = (None::<String>, 0usize, 0usize);
    while let Some(caps) = re.captures_at(text, cursor) {
        let Some(full) = caps.get(0) else { break };
        if let Some((keep_end, skip_end)) = accept(text, &caps) {
            let buf = out.get_or_insert_with(|| String::with_capacity(text.len()));
            buf.push_str(&text[last..keep_end]); buf.push_str("[redacted]");
            last = skip_end; cursor = skip_end;
        } else {
            cursor = full.start() + text[full.start()..].chars().next().map_or(1, char::len_utf8);
        }
    }
    match out { Some(mut buf) => { buf.push_str(&text[last..]); Cow::Owned(buf) } None => Cow::Borrowed(text) }
}
fn utf16_len_within(s: &str, max: usize) -> bool {
    s.len() <= max || s.chars().scan(0usize, |n, ch| { *n += ch.len_utf16(); Some(*n) }).all(|n| n <= max)
}
fn has_digit_within_256(s: &str) -> bool {
    let mut utf16 = 0usize;
    for ch in s.chars() {
        if ch.is_ascii_digit() { return true; }
        utf16 += ch.len_utf16(); if utf16 > 256 { break; }
    }
    false
}
fn scan_cookie_tail(rest: &str) -> usize {
    let mut pos = 0usize;
    while let Some(ch) = rest[pos..].chars().next() {
        if ch == '\\' {
            let Some(next) = rest[pos + 1..].chars().next() else { break };
            if matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}') { break; } pos += 1 + next.len_utf8();
        } else if ch == '"' {
            let Some(end) = scan_cookie_quoted(&rest[pos..]) else { break }; pos += end;
        } else if matches!(ch, '\r' | '\n' | '\'') { break; } else { pos += ch.len_utf8(); }
    }
    pos
}
fn scan_cookie_quoted(slice: &str) -> Option<usize> {
    let (mut utf16, mut idx) = (0usize, 1usize);
    for ch in slice[1..].chars() {
        if ch == '"' {
            let after = &slice[idx + 1..]; let trimmed = after.trim_start_matches([' ', '\t']);
            return (after.starts_with(';') || trimmed.is_empty() || trimmed.starts_with(['\r', '\n'])).then_some(idx + 1);
        }
        if matches!(ch, '\r' | '\n' | '\\') { return None; }
        utf16 += ch.len_utf16(); if utf16 > 4096 { return None; } idx += ch.len_utf8();
    }
    None
}
fn starts_like_json(value: &str, start: usize) -> bool {
    let mut utf16 = 1usize;
    for ch in value[start + 1..].chars() {
        if utf16 >= 128 { return false; } else if matches!(ch, ' ' | '\t' | '\n' | '\r' | '{' | '[') { utf16 += 1; continue; }
        return ch == '"';
    }
    false
}
fn find_balanced_end(bytes: &[u8], start: usize) -> Option<usize> {
    let (mut depth, mut in_str, mut esc) = (0isize, false, false);
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str { if esc { esc = false; } else if b == b'\\' { esc = true; } else if b == b'"' { in_str = false; } continue; }
        match b {
            b'"' => in_str = true, b'{' | b'[' => depth += 1,
            b'}' | b']' => { depth -= 1; if depth == 0 { return Some(i + 1); } else if depth < 0 { return None; } }
            _ => {}
        }
    }
    None
}
fn redact_header_strings(value: Value) -> Value {
    match value {
        Value::String(_) => Value::String("[redacted]".into()),
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_header_strings).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, redact_header_strings(v))).collect()),
        other => other,
    }
}
fn unchanged_key_count(parsed: &Value, converted: &Value) -> isize {
    match (parsed, converted) {
        (Value::Null, Value::Null) => 0, (Value::Bool(a), Value::Bool(b)) if a == b => 0,
        (Value::Number(a), Value::Number(b)) if a == b => 0, (Value::String(a), Value::String(b)) if a == b => 0,
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a.iter().zip(b).try_fold(0isize, |acc, (x, y)| {
            let n = unchanged_key_count(x, y); (n >= 0).then_some(acc + n)
        }).unwrap_or(-1),
        (Value::Object(a), Value::Object(b)) if a.len() == b.len() => a.iter().zip(b).try_fold(a.len() as isize, |acc, ((k, v), (ck, cv))| {
            let n = if k == ck { unchanged_key_count(v, cv) } else { -1 }; (n >= 0).then_some(acc + n)
        }).unwrap_or(-1),
        _ => -1,
    }
}
fn written_key_count(text: &str) -> isize {
    let (bytes, mut count, mut i) = (text.as_bytes(), 0isize, 0usize);
    while i < bytes.len() {
        if bytes[i] != b'"' { i += 1; continue; } i += 1;
        while i < bytes.len() && bytes[i] != b'"' { i += if bytes[i] == b'\\' { 2 } else { 1 }; }
        let mut next = i + 1;
        while next < bytes.len() && matches!(bytes[next], b' ' | b'\t' | b'\n' | b'\r') { next += 1; }
        if next < bytes.len() && bytes[next] == b':' { count += 1; } i += 1;
    }
    count
}
fn prepare_for_stringify(val: &mut Value) -> bool {
    match val {
        Value::Number(n) => n.as_i64().is_some_and(|i| (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(&i)) || n.as_u64().is_some_and(|u| u <= MAX_SAFE_JS_INT as u64),
        Value::Array(arr) => arr.iter_mut().all(prepare_for_stringify),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
            let array_index = |k: &str| if k == "0" { Some(0) } else if !k.is_empty() && !k.starts_with('0') && k.bytes().all(|b| b.is_ascii_digit()) { k.parse::<u32>().ok().filter(|&n| n < u32::MAX) } else { None };
            entries.sort_by_key(|(k, _)| array_index(k).map_or((1u8, 0u32), |n| (0u8, n)));
            for (k, mut v) in entries { if !prepare_for_stringify(&mut v) { return false; } map.insert(k, v); }
            true
        }
        _ => true,
    }
}

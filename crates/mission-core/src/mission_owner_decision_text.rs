//! Manual-scanner port of the extractMissionOwnerDecisionFromText slice that
//! operator-card-summary.ts consumes: heading/marker detection, Decision field
//! capture, MISSION_OWNER_DECISION_OPTIONS validation, and the Reason /
//! Next action / Evidence fields. JS regex lookarounds, \s/\w classes, and
//! UTF-16 index semantics are reproduced on Vec<u16>; lowercased-text offsets
//! are applied to the original text exactly like the TS code (so a case
//! expansion like İ -> i̇ misaligns blockStart the same way).

const HEADINGS: [&str; 2] = [
    "### Mission owner decision",
    "## Mission-owner adjudication recorded",
];
const MARKER: &str = "Mission-owner decision recorded";
const DECISION_OPTIONS: [&str; 9] = [
    "request_input",
    "retry_source_issue",
    "reassign_source_issue",
    "replan_mission",
    "restart_from_start",
    "escalate",
    "report_impossible",
    "recover_artifact",
    "no_action_waiting",
];

/// Fields a caller may reuse when the parsed decision is a valid option.
pub struct OwnerDecisionFields {
    pub reason: Option<Vec<u16>>,
    pub next_action: Option<Vec<u16>>,
    pub evidence: Option<Vec<u16>>,
}

pub(crate) fn units(s: &str) -> Vec<u16> { s.encode_utf16().collect() }

/// JS \s / trim domain: Unicode White_Space minus U+0085 (NEL), plus U+FEFF.
pub(crate) fn is_js_ws(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
/// JS \w: [A-Za-z0-9_].
pub(crate) fn is_word(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x5F | 0x61..=0x7A)
}
/// JS multiline `^` anchor: position 0 or after a LineTerminator.
pub(crate) fn is_line_start(t: &[u16], i: usize) -> bool {
    i == 0 || matches!(t[i - 1], 0x0A | 0x0D | 0x2028 | 0x2029)
}
/// JS non-unicode i-flag equality vs an (already lowercased) ASCII pattern
/// char: Canonicalize never folds a char >= 128 to ASCII, so Kelvin U+212A,
/// long-s U+017F, and multi-char İ all fail to match — exactly ASCII
/// case-insensitive equality.
fn ci_eq(u: u16, pat: u16) -> bool {
    u == pat || (u < 128 && pat < 128 && (u as u8).eq_ignore_ascii_case(&(pat as u8)))
}
pub(crate) fn ci_starts_with(t: &[u16], i: usize, pat_lower: &[u16]) -> bool {
    i + pat_lower.len() <= t.len() && t[i..i + pat_lower.len()].iter().zip(pat_lower).all(|(&a, &b)| ci_eq(a, b))
}
/// Case-sensitive ASCII literal probe.
pub(crate) fn ascii_starts(t: &[u16], i: usize, s: &str) -> bool {
    s.bytes().enumerate().all(|(k, b)| t.get(i + k) == Some(&(b as u16)))
}
/// JS String#toLowerCase per code point. Context-free: sigma never affects
/// the ASCII patterns searched here; U+0130 expands to two units, which is
/// the only length drift reachable by lastIndexOf offsets.
fn js_lower(t: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        let (c, n) = decode(t, i);
        match c {
            Some(c) => {
                let mut buf = [0u16; 2];
                for lc in c.to_lowercase() {
                    out.extend_from_slice(lc.encode_utf16(&mut buf));
                }
            }
            None => out.push(t[i]),
        }
        i += n;
    }
    out
}
fn decode(t: &[u16], i: usize) -> (Option<char>, usize) {
    if (0xD800..0xDC00).contains(&t[i]) && t.get(i + 1).is_some_and(|&u| (0xDC00..0xE000).contains(&u)) {
        let cp = 0x10000 + (((t[i] - 0xD800) as u32) << 10 | (t[i + 1] - 0xDC00) as u32);
        (char::from_u32(cp), 2)
    } else {
        (char::from_u32(t[i] as u32), 1)
    }
}
pub(crate) fn trim_units(t: &[u16]) -> &[u16] {
    let (mut a, mut b) = (0, t.len());
    while a < b && is_js_ws(t[a]) { a += 1; }
    while b > a && is_js_ws(t[b - 1]) { b -= 1; }
    &t[a..b]
}
fn last_index_of(hay: &[u16], pat: &[u16]) -> Option<usize> {
    if pat.is_empty() || hay.len() < pat.len() { return None; }
    (0..=hay.len() - pat.len()).rev().find(|&i| hay[i..i + pat.len()] == *pat)
}
/// `value?.trim()` then split on /\r?\n/ (a lone \r never splits) and take the
/// first segment that trims non-empty.
fn first_non_empty_line(cap: &[u16]) -> Option<Vec<u16>> {
    let n = trim_units(cap);
    if n.is_empty() { return None; }
    let mut start = 0;
    for i in 0..n.len() {
        if n[i] == 0x0A {
            let end = if i > start && n[i - 1] == 0x0D { i - 1 } else { i };
            let seg = trim_units(&n[start..end]);
            if !seg.is_empty() { return Some(seg.to_vec()); }
            start = i + 1;
        }
    }
    let seg = trim_units(&n[start..]);
    (!seg.is_empty()).then(|| seg.to_vec())
}
/// Lookahead tail of the field pattern: `^\w[\w ]*\s*:` or `^###\s+` or
/// `(?![\s\S])` (end of input, handled by the caller at e == len).
fn lookahead_boundary(b: &[u16], e: usize) -> bool {
    if !is_line_start(b, e) { return false; }
    if b[e..].starts_with(&[0x23, 0x23, 0x23]) && b.get(e + 3).is_some_and(|&u| is_js_ws(u)) {
        return true;
    }
    if !is_word(b[e]) { return false; }
    let mut k = e + 1;
    while k < b.len() && (is_word(b[k]) || b[k] == 0x20) { k += 1; }
    while k < b.len() && is_js_ws(b[k]) { k += 1; }
    b.get(k) == Some(&0x3A)
}
/// readDecisionField: `^FIELD\s*:\s*([\s\S]*?)(?=label-line|###|end)` im.
fn read_field(block: &[u16], field_lower: &[u16]) -> Option<Vec<u16>> {
    for p in 0..=block.len() {
        if !is_line_start(block, p) || !ci_starts_with(block, p, field_lower) { continue; }
        let mut q = p + field_lower.len();
        while block.get(q).is_some_and(|&u| is_js_ws(u)) { q += 1; }
        if block.get(q) != Some(&0x3A) { continue; }
        q += 1;
        while block.get(q).is_some_and(|&u| is_js_ws(u)) { q += 1; }
        let mut e = q;
        while e < block.len() && !lookahead_boundary(block, e) { e += 1; }
        return first_non_empty_line(&block[q..e]);
    }
    None
}
/// rest.search(/^#{1,6}\s+/m): a line start whose # run is 1-6 long and
/// immediately followed by JS whitespace.
fn next_heading_pos(rest: &[u16]) -> Option<usize> {
    for p in 0..rest.len() {
        if !is_line_start(rest, p) { continue; }
        let mut k = p;
        while k < rest.len() && rest[k] == 0x23 { k += 1; }
        if (1..=6).contains(&(k - p)) && rest.get(k).is_some_and(|&u| is_js_ws(u)) {
            return Some(p);
        }
    }
    None
}
/// text.matchAll(/Mission-owner decision recorded\s*:\s*([a-z_]+)/gi).
/// With the i flag the capture class is effectively [A-Za-z_].
fn find_markers(t: &[u16], pat: &[u16]) -> Vec<(usize, usize, Vec<u16>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if !ci_starts_with(t, i, pat) {
            i += 1;
            continue;
        }
        let mut q = i + pat.len();
        while t.get(q).is_some_and(|&u| is_js_ws(u)) { q += 1; }
        if t.get(q) == Some(&0x3A) {
            q += 1;
            while t.get(q).is_some_and(|&u| is_js_ws(u)) { q += 1; }
            let s = q;
            while t.get(q).is_some_and(|&u| matches!(u, 0x41..=0x5A | 0x5F | 0x61..=0x7A)) { q += 1; }
            if q > s {
                out.push((i, q, t[s..q].to_vec()));
                i = q;
                continue;
            }
        }
        i += 1;
    }
    out
}
/// extractMissionOwnerDecisionFromText restricted to the operator-card path:
/// returns the reusable fields iff the parsed decision is a valid option;
/// `null`/`decision: null` results collapse to None (same downstream effect).
pub fn extract_decision_fields(text: &str) -> Option<OwnerDecisionFields> {
    let t = units(text);
    let lower = js_lower(&t);
    let mut latest: Option<(usize, usize, Option<Vec<u16>>)> = None;
    for h in HEADINGS {
        if let Some(idx) = last_index_of(&lower, &js_lower(&units(h))) {
            if latest.as_ref().is_none_or(|l| idx > l.0) {
                latest = Some((idx, idx + units(h).len(), None));
            }
        }
    }
    for (idx, end, cap) in find_markers(&t, &js_lower(&units(MARKER))) {
        if latest.as_ref().is_none_or(|l| idx > l.0) {
            latest = Some((idx, end, Some(js_lower(&cap))));
        }
    }
    let (_, bs, marker_raw) = latest?;
    let rest = &t[bs.min(t.len())..];
    let block = next_heading_pos(rest).map_or(rest, |p| &rest[..p]);
    let raw = marker_raw
        .or_else(|| read_field(block, &js_lower(&units("Decision"))).map(|v| js_lower(&v)))
        .filter(|v| !v.is_empty())?;
    if !DECISION_OPTIONS.iter().any(|o| units(o) == raw) {
        return None;
    }
    Some(OwnerDecisionFields {
        reason: read_field(block, &js_lower(&units("Reason"))),
        next_action: read_field(block, &js_lower(&units("Next action"))),
        evidence: read_field(block, &js_lower(&units("Evidence"))),
    })
}
/// Hand-rolled JSON.stringify-equivalent for UTF-16 unit strings: valid pairs
/// emit the real char, lone surrogates emit \uXXXX escapes so JSON.parse
/// reproduces them exactly.
pub fn json_quote(t: &[u16]) -> String {
    let mut out = String::with_capacity(t.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < t.len() {
        match t[i] {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            u if u < 0x20 => out.push_str(&format!("\\u{u:04x}")),
            u @ 0xD800..0xDC00 => {
                if let Some(&l @ 0xDC00..0xE000) = t.get(i + 1) {
                    let cp = 0x10000 + (((u - 0xD800) as u32) << 10 | (l - 0xDC00) as u32);
                    out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                    i += 1;
                } else {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
            u @ 0xDC00..0xE000 => out.push_str(&format!("\\u{u:04x}")),
            u => out.push(char::from_u32(u as u32).unwrap_or('\u{fffd}')),
        }
        i += 1;
    }
    out.push('"');
    out
}

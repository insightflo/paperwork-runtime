//! Pure port of server/src/services/missions/operator-card-summary.ts:
//! formatOperatorDecisionSummary, a display-only owner-decision card.
//! The whole pipeline runs on UTF-16 code units so String.length/slice
//! budgets, \s/\w classes, \b boundaries, and manual lookaround scans match
//! JS exactly — including the lone surrogate a budget cut can leave behind.
use crate::js::js_truthy;
use crate::mission_owner_decision_text as md;
use serde_json::Value;
use std::collections::HashSet;

pub const SUBCOMMANDS: &[&str] = &["format-operator-decision-summary"];

const SYMPTOM_BUDGET: usize = 200;
const OPTION_BUDGET: usize = 140;
const INTERPRETATION_BUDGET: usize = 120;
const EVIDENCE_BUDGET: usize = 160;
const EVIDENCE_LINKS_BUDGET: usize = 240;
const MISSION_TITLE_BUDGET: usize = 80;
const ISSUE_TITLE_BUDGET: usize = 140;
const MAX_EVIDENCE_LINKS: usize = 5;

fn is_alnum(u: u16) -> bool { matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A) }
fn is_hex(u: u16) -> bool { matches!(u, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66) }
fn is_url_stop(u: u16) -> bool { md::is_js_ws(u) || matches!(u, 0x29 | 0x3C | 0x3E | 0x22 | 0x27) } // [^\s)<>"']
fn is_ref_prev(u: u16) -> bool { md::is_js_ws(u) || matches!(u, 0x28 | 0x5B | 0x3C | 0x22 | 0x27) } // [\s(\[<"']
fn is_ref_tail(u: u16) -> bool { is_alnum(u) || matches!(u, 0x2E | 0x2D | 0x5F) } // [A-Za-z0-9._-]
fn cat(parts: &[Vec<u16>]) -> Vec<u16> { parts.concat() }
fn join(parts: &[Vec<u16>], sep: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 { out.extend_from_slice(sep); }
        out.extend_from_slice(p);
    }
    out
}
fn ws_skip(t: &[u16], mut q: usize) -> usize {
    while t.get(q).is_some_and(|&u| md::is_js_ws(u)) { q += 1; }
    q
}

/// text.replace(UUID_PATTERN, m => m.slice(0,8)) — \b-guarded 8-4-4-4-12 hex.
fn shorten_uuids(t: &[u16]) -> Vec<u16> {
    const SEG: [usize; 5] = [8, 4, 4, 4, 12];
    let mut out = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        let (mut p, mut ok) = (i, !(i > 0 && md::is_word(t[i - 1])));
        for (g, &n) in SEG.iter().enumerate() {
            if !ok { break; }
            if g > 0 && t.get(p) != Some(&0x2D) { ok = false; break; }
            if g > 0 { p += 1; }
            for _ in 0..n {
                if !t.get(p).is_some_and(|&u| is_hex(u)) { ok = false; break; }
                p += 1;
            }
        }
        if ok && p < t.len() && md::is_word(t[p]) { ok = false; }
        if ok {
            out.extend_from_slice(&t[i..i + 8]);
            i = p;
        } else {
            out.push(t[i]);
            i += 1;
        }
    }
    out
}
/// One pass of JS \s-run rewriting: fold_nl picks runs containing \n, else len>=2.
fn fold_runs(a: &[u16], fold_nl: bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(a.len());
    let mut i = 0;
    while i < a.len() {
        if !md::is_js_ws(a[i]) { out.push(a[i]); i += 1; continue; }
        let mut j = i;
        while j < a.len() && md::is_js_ws(a[j]) { j += 1; }
        if (fold_nl && a[i..j].contains(&0x0A)) || (!fold_nl && j - i >= 2) { out.push(0x20); }
        else if fold_nl { out.extend_from_slice(&a[i..j]); }
        else { out.push(a[i]); }
        i = j;
    }
    out
}
/// cleanProse: ^#{1,6}\s+ (m) strip, fold runs containing \n, \s{2,} → " ", trim.
/// Positions stay on the original array like the chained JS replaces.
fn clean_prose(t: &[u16]) -> Vec<u16> {
    let mut a = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        if md::is_line_start(t, i) && t[i] == 0x23 {
            let mut k = i;
            while k < t.len() && t[k] == 0x23 { k += 1; }
            if (1..=6).contains(&(k - i)) && t.get(k).is_some_and(|&u| md::is_js_ws(u)) {
                i = ws_skip(t, k);
                continue;
            }
        }
        a.push(t[i]);
        i += 1;
    }
    md::trim_units(&fold_runs(&fold_runs(&a, true), false)).to_vec()
}

/// stripTitleLabel: sequential anchored strips; only `human\s*operator\s*:`
/// requires the colon.
fn strip_title_label(t: &[u16]) -> Vec<u16> {
    let mut out = t.to_vec();
    for label in ["mission blocker escalated", "human/operator input requested"] {
        let pat = md::units(label);
        if md::ci_starts_with(&out, 0, &pat) {
            let mut q = ws_skip(&out, pat.len());
            if out.get(q) == Some(&0x3A) { q += 1; }
            out = out[ws_skip(&out, q)..].to_vec();
        }
    }
    if md::ci_starts_with(&out, 0, &md::units("human")) {
        let q = ws_skip(&out, 5);
        if md::ci_starts_with(&out, q, &md::units("operator")) {
            let q = ws_skip(&out, q + 8);
            if out.get(q) == Some(&0x3A) {
                out = out[ws_skip(&out, q + 1)..].to_vec();
            }
        }
    }
    md::trim_units(&out).to_vec()
}

/// truncateAtSentenceBoundary: head = first `budget` units; last [.!?] before
/// JS-ws-or-head-end wins; else last literal space; else head + " …".
fn truncate_sentence(t: &[u16], budget: usize) -> Vec<u16> {
    if t.len() <= budget { return t.to_vec(); }
    let head = &t[..budget];
    let mut last = None;
    for (i, &u) in head.iter().enumerate() {
        if matches!(u, 0x2E | 0x21 | 0x3F) && (i + 1 == head.len() || md::is_js_ws(head[i + 1])) {
            last = Some(i);
        }
    }
    if let Some(i) = last {
        if i > 0 { return head[..i + 1].to_vec(); }
    }
    match head.iter().rposition(|&u| u == 0x20) {
        Some(s) if s > 0 => cat(&[head[..s].to_vec(), md::units(" …")]),
        _ => cat(&[head.to_vec(), md::units(" …")]),
    }
}
/// truncateAtWordBoundary: head up to last literal space, no ellipsis.
fn truncate_word(t: &[u16], budget: usize) -> Vec<u16> {
    if t.len() <= budget { return t.to_vec(); }
    let head = &t[..budget];
    match head.iter().rposition(|&u| u == 0x20) {
        Some(s) if s > 0 => head[..s].to_vec(),
        _ => head.to_vec(),
    }
}

/// TRAILING_PUNCTUATION /[.,;:!?]+$/ strip + Set-order dedup insert.
fn push_link(links: &mut Vec<Vec<u16>>, seen: &mut HashSet<Vec<u16>>, raw: &[u16]) {
    let mut end = raw.len();
    while end > 0 && matches!(raw[end - 1], 0x2E | 0x2C | 0x3B | 0x3A | 0x21 | 0x3F) {
        end -= 1;
    }
    if end > 0 && seen.insert(raw[..end].to_vec()) { links.push(raw[..end].to_vec()); }
}
/// extractEvidenceLinks: URLs first then /issues/ refs (each in match order),
/// trailing [.,;:!?]+ stripped, order-preserving Set dedup, cap 5.
fn extract_links(ev: &[u16]) -> Vec<Vec<u16>> {
    let (mut links, mut seen): (Vec<Vec<u16>>, HashSet<Vec<u16>>) = (Vec::new(), HashSet::new());
    let mut i = 0;
    while i < ev.len() {
        let scheme = if md::ascii_starts(ev, i, "https://") { 8 } else if md::ascii_starts(ev, i, "http://") { 7 } else { 0 };
        if scheme == 0 { i += 1; continue; }
        let mut j = i + scheme;
        while j < ev.len() && !is_url_stop(ev[j]) { j += 1; }
        if j > i + scheme { push_link(&mut links, &mut seen, &ev[i..j]); }
        i = j;
    }
    let mut i = 0;
    while i < ev.len() {
        let ok = (i == 0 || is_ref_prev(ev[i - 1])) && md::ascii_starts(ev, i, "/issues/") && ev.get(i + 8).is_some_and(|&u| is_alnum(u));
        if !ok { i += 1; continue; }
        let mut j = i + 9;
        while j < ev.len() && is_ref_tail(ev[j]) { j += 1; }
        push_link(&mut links, &mut seen, &ev[i..j]);
        i = j;
    }
    links.truncate(MAX_EVIDENCE_LINKS);
    links
}
/// fitLinks: keep links front-to-back while joined length stays <= budget.
fn fit_links(links: &[Vec<u16>], budget: usize) -> Vec<u16> {
    let mut kept: Vec<Vec<u16>> = Vec::new();
    let mut total = 0;
    for l in links {
        let add = if kept.is_empty() { l.len() } else { l.len() + 3 };
        if total + add > budget { break; }
        kept.push(l.clone());
        total += add;
    }
    join(&kept, &md::units(" · "))
}

/// `input.<key>?.trim()` — non-nullish non-string raises the V8 TypeError.
fn trimmed_field(input: &Value, key: &str, expr: &str) -> Result<Option<Vec<u16>>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok({ let t = md::trim_units(&md::units(s)).to_vec(); (!t.is_empty()).then_some(t) }),
        Some(_) => Err(format!("{expr}?.trim is not a function")),
    }
}
/// A raw card field: `unpacked ?? input`, non-empty UTF-16 or absent;
/// truthy non-strings raise `err` on use.
fn raw_field(unpacked: Option<Vec<u16>>, input_v: Option<&Value>, err: &str) -> Result<Option<Vec<u16>>, String> {
    if unpacked.is_some() { return Ok(unpacked.filter(|v| !v.is_empty())); }
    Ok(match input_v {
        Some(v) if js_truthy(v) => Some(md::units(v.as_str().ok_or_else(|| err.to_string())?)),
        _ => None,
    }
    .filter(|v| !v.is_empty()))
}
/// symptomContextLine — title/identifier/issueTitle trimmed; issueId raw inside shortenUuids.
fn context_line(input: &Value) -> Result<Vec<u16>, String> {
    let mut parts: Vec<Vec<u16>> = Vec::new();
    if let Some(t) = trimmed_field(input, "missionTitle", "input.missionTitle")? {
        parts.push(cat(&[md::units("미션 "), truncate_word(&t, MISSION_TITLE_BUDGET)]));
    }
    let ident = trimmed_field(input, "issueIdentifier", "input.issueIdentifier")?;
    let title = trimmed_field(input, "issueTitle", "input.issueTitle")?;
    if let (Some(i), Some(t)) = (&ident, &title) {
        parts.push(cat(&[md::units("이슈 "), i.clone(), md::units(" — "), truncate_word(t, ISSUE_TITLE_BUDGET)]));
    } else if let Some(t) = title { parts.push(cat(&[md::units("이슈 "), truncate_word(&t, ISSUE_TITLE_BUDGET)]));
    } else if let Some(id) = ident { parts.push(cat(&[md::units("이슈 "), id]));
    } else if let Some(v) = input.get("issueId").filter(|v| js_truthy(v)) {
        let s = v.as_str().ok_or("text.replace is not a function")?;
        parts.push(cat(&[md::units("이슈 ("), shorten_uuids(&md::units(s)), md::units(")")]));
    }
    if parts.is_empty() { parts.push(md::units("미션 진행이 중단되었습니다")); }
    Ok(join(&parts, &md::units(" · ")))
}

const OPT_DEFAULTS: [&str; 2] = [
    "운영자 판단이나 입력이 필요합니다.",
    "운영자가 복구 경로를 선택해야 합니다(입력 수정 후 재시도, 재계획, 담당 재배정, 취소 중 하나).",
];
const INTERPRETATIONS: [&str; 2] = [
    "운영자의 입력이 있어야 미션을 계속 진행할 수 있습니다.",
    "자동 진행이 막혀서 운영자가 복구 방향을 정해야 미션을 계속할 수 있습니다.",
];

/// formatOperatorDecisionSummary. Err strings mirror V8 TypeError texts for
/// the non-string property reads the TS code performs.
pub fn format(input: &Value) -> Result<Vec<u16>, String> {
    if input.is_null() { return Err("Cannot read properties of null (reading 'reason')".into()); }
    let escalate = input.get("decision").and_then(Value::as_str) == Some("escalate");
    let reason_v = input.get("reason");
    let unpacked = if reason_v.is_some_and(js_truthy) {
        match reason_v.and_then(Value::as_str) {
            Some(s) => md::extract_decision_fields(s),
            None => return Err("text.toLowerCase is not a function".into()),
        }
    } else { None };
    let pick = |f: fn(&md::OwnerDecisionFields) -> &Option<Vec<u16>>| unpacked.as_ref().and_then(|u| f(u).clone());
    let raw_reason = raw_field(pick(|u| &u.reason), reason_v, "value.replace is not a function")?;
    let symptom = match raw_reason {
        Some(t) => truncate_sentence(&shorten_uuids(&strip_title_label(&clean_prose(&t))), SYMPTOM_BUDGET),
        None => md::units("(사유 기록 없음)"),
    };
    let raw_next = raw_field(pick(|u| &u.next_action), input.get("nextAction"), "value.replace is not a function")?;
    let option = match raw_next {
        Some(t) => truncate_sentence(&shorten_uuids(&strip_title_label(&clean_prose(&t))), OPTION_BUDGET),
        None => md::units(OPT_DEFAULTS[escalate as usize]),
    };
    let interpretation = md::units(INTERPRETATIONS[escalate as usize]);
    let mut lines = vec![
        cat(&[md::units("증상: "), context_line(input)?]),
        symptom,
        cat(&[md::units("선택지: "), option]),
        cat(&[md::units("쉬운 해석: "), truncate_sentence(&interpretation, INTERPRETATION_BUDGET)]),
    ];
    let raw_ev = raw_field(pick(|u| &u.evidence), input.get("evidence"), "evidence.matchAll is not a function or its return value is not iterable")?;
    if let Some(ev) = raw_ev {
        let links = extract_links(&ev);
        let body = if links.is_empty() {
            truncate_sentence(&shorten_uuids(&clean_prose(&ev)), EVIDENCE_BUDGET)
        } else { fit_links(&links, EVIDENCE_LINKS_BUDGET) };
        lines.push(cat(&[md::units("근거: "), body]));
    }
    Ok(join(&lines, &md::units("\n")))
}

/// Returns serialized JSON text (not a Value): a lone surrogate left by a
/// mid-pair budget cut cannot fit a Rust String — hand-quoted, printed verbatim.
pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<String, String> {
    if subcommand != "format-operator-decision-summary" {
        return Err(format!("unknown subcommand: {subcommand}"));
    }
    // Known limitation: lone-surrogate input is rejected (exit 1); the bridge must route abnormal exits to the TS fallback.
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    format(&input).map(|u| md::json_quote(&u))
}

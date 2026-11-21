//! [파일 목적] shared workflowConditionGroupSchema(zod 3.25) 의 Rust 포트 — control-node
//!   validation 이 `safeParse(...).success` bool 만 소비하므로 판정만 재현한다.
//! [parity] strict 키 집합·source discriminatedUnion(kind)·trim/UTF-16 길이·path 문법 +
//!   prototype 세그먼트·parameters plain-object·superRefine(op∈dataType, rightValue)·
//!   zod datetime({offset:true}) regex(윤년 인식, ss 선택, `±hh:?mm` 콜론 선택·범위 무검사).

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

const IF_MAX_CONDITIONS: usize = 20;
const STRING_OPS: &str =
    "equals not_equals contains not_contains starts_with ends_with is_empty is_not_empty";
const NUMBER_OPS: &str =
    "equals not_equals greater_than greater_than_or_equal less_than less_than_or_equal";
/// 우항을 받지 않는 연산자 — zod superRefine 에서 rightValue 존재 자체가 이슈.
const UNARY_OPS: &[&str] = &["is_empty", "is_not_empty", "is_true", "is_false"];

fn operators_for(data_type: &str) -> &'static str {
    match data_type {
        "string" => STRING_OPS,
        "number" => NUMBER_OPS,
        "boolean" => "is_true is_false",
        "date_time" => "equals not_equals after after_or_equal before before_or_equal",
        "array" => "is_empty is_not_empty contains",
        "object" => "is_empty is_not_empty has_key",
        _ => "",
    }
}

/// ECMAScript WhiteSpace+LT — structural_gate.rs js_trim(bin 전용)과 동일 규칙의 lib 사본.
///   Rust `str::trim` 이 빼는 U+0085(NEL)를 JS trim 은 유지하므로 agent/tool 문자열 판정에서도
///   이 헬퍼를 써야 한다(control_nodes.rs has_agent_or_tool_assignment).
pub(super) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}'))
}

/// JS string.length — UTF-16 코드 유닛 수(비BMP 는 2).
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// z.string().trim().min(1).max(max) — 트림본 UTF-16 길이가 1..=max.
fn bounded_trimmed(v: Option<&Value>, max: usize) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| (1..=max).contains(&utf16_len(js_trim(s))))
}

/// zod .strict() — 키 집합이 전부 알려진 키에 포함.
fn strict(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}

/// WORKFLOW_IF_JSON_PATH_PATTERN — `$` + (`.ident` | `[index]`)*;
///   ident 는 [A-Za-z_][A-Za-z0-9_]*, index 는 `0` 또는 비선행-0 숫자.
fn json_path(p: &str) -> bool {
    let b = p.as_bytes();
    if b.first() != Some(&b'$') {
        return false;
    }
    let mut i = 1;
    while i < b.len() {
        if b[i] == b'.' {
            i += 1;
            if i >= b.len() || !(b[i].is_ascii_alphabetic() || b[i] == b'_') {
                return false;
            }
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
        } else if b[i] == b'[' {
            i += 1;
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let digits = &b[start..i];
            if digits.is_empty()
                || (digits.len() > 1 && digits[0] == b'0')
                || i >= b.len()
                || b[i] != b']'
            {
                return false;
            }
            i += 1;
        } else {
            return false;
        }
    }
    true
}

/// pathReferencesPrototypeKey — `.`/`[`/`]` 분리 세그먼트에 금지 키가 있으면 참.
fn proto_segment(path: &str) -> bool {
    path.split(['.', '[', ']'])
        .any(|seg| matches!(seg, "__proto__" | "prototype" | "constructor"))
}

/// zod 3.25.76 datetime({offset:true}) regex — \d 는 ASCII(→[0-9]).
fn datetime_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|",
            r"[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-",
            r"(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|",
            r"(02)-(0[1-9]|1[0-9]|2[0-8])))",
            r"T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?",
            r"(Z|[+-][0-9]{2}:?[0-9]{2})$"
        ))
        .unwrap()
    })
}

/// workflowConditionSourceSchema — discriminatedUnion("kind") 두 분기의 strict shape +
///   공통 stepId/path 제약 + source/condition 양쪽 superRefine 의 prototype 세그먼트.
///   parameters(z.record(unknown).default({}))는 부재 또는 plain object 여야 한다.
fn source_valid(v: Option<&Value>) -> bool {
    let Some(o) = v.and_then(Value::as_object) else {
        return false;
    };
    let Some(path) = o.get("path").and_then(Value::as_str) else {
        return false;
    };
    if !(1..=1024).contains(&utf16_len(path)) || !json_path(path) || proto_segment(path) {
        return false;
    }
    match o.get("kind").and_then(Value::as_str) {
        Some("work_product_json") => {
            strict(o, &["kind", "stepId", "path", "title"])
                && bounded_trimmed(o.get("stepId"), 120)
                && bounded_trimmed(o.get("title"), 255)
        }
        Some("tool_json") => {
            strict(o, &["kind", "stepId", "path", "toolName", "parameters"])
                && bounded_trimmed(o.get("stepId"), 120)
                && bounded_trimmed(o.get("toolName"), 120)
                && o.get("parameters").is_none_or(Value::is_object)
        }
        _ => false,
    }
}

/// validateRightValue — binary op 의 우항을 dataType 별로 판정.
fn right_value_ok(dt: &str, v: &Value) -> bool {
    match dt {
        "string" => v.is_string(),
        "number" => v.as_f64().is_some_and(|f| f.is_finite()),
        "date_time" => v.as_str().is_some_and(|s| datetime_re().is_match(s)),
        "array" => match v {
            Value::Number(n) => n.as_f64().is_some_and(|f| f.is_finite()),
            Value::String(_) | Value::Bool(_) => true,
            _ => false,
        },
        "object" => v
            .as_str()
            .is_some_and(|s| (1..=120).contains(&utf16_len(js_trim(s)))),
        _ => false,
    }
}

/// workflowConditionSchema — strict 4키 + source union + superRefine. zod 의 dataType/
///   operator enum·op∈family 검사는 `operators_for(dt)` 비공백 + 소속 확인으로 함축된다
///   (family ⊆ 연산자 union, 미지원 dataType 은 빈 family).
fn condition_valid(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if !strict(o, &["source", "dataType", "operator", "rightValue"]) {
        return false;
    }
    if !source_valid(o.get("source")) {
        return false;
    }
    let Some(dt) = o.get("dataType").and_then(Value::as_str) else {
        return false;
    };
    let Some(op) = o.get("operator").and_then(Value::as_str) else {
        return false;
    };
    let family = operators_for(dt);
    if family.is_empty() || !family.split(' ').any(|known| known == op) {
        return false;
    }
    let has_right = o.contains_key("rightValue");
    if UNARY_OPS.contains(&op) {
        return !has_right;
    }
    match o.get("rightValue") {
        None | Some(Value::Null) => false,
        Some(rv) => right_value_ok(dt, rv),
    }
}

/// workflowConditionGroupSchema.safeParse(group).success — strict {combinator,conditions},
///   combinator all|any, conditions 1..=20 전부 유효 조건.
pub(super) fn valid(group: Option<&Value>) -> bool {
    let Some(o) = group.and_then(Value::as_object) else {
        return false;
    };
    if o.len() != 2
        || !matches!(
            o.get("combinator").and_then(Value::as_str),
            Some("all" | "any")
        )
    {
        return false;
    }
    let Some(conds) = o.get("conditions").and_then(Value::as_array) else {
        return false;
    };
    (1..=IF_MAX_CONDITIONS).contains(&conds.len()) && conds.iter().all(condition_valid)
}

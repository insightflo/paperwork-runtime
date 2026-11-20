//! [파일 목적] JS 값 의미론 헬퍼 — bin 모듈 전용(lib 미공개). evaluate-conditions 등
//!   TS 순수 포트가 필요로 하는 String()/ToNumber()/=== 강제 규칙과 STRICT ISO-8601 +
//!   Date.parse 도메인을 한 곳에 모은다.
//! [parity] String(undefined)="undefined", String(null)="null", 배열 toString 은
//!   요소별 null→"" join, 숫자 표기는 고정/지수 경계(1e-6 미만·1e21 이상만 e±exp),
//!   === 는 무강제 + 객체/배열 참조 비교(별도 JSON 트리에서 항상 false).
//!   strict_iso_epoch 는 V8 Date.parse 도메인: 월 1-12, 일 1-31(월말 초과분은
//!   rollover — 2025-02-29 → 03-01), T24:00:00 유효, 오프셋 ±23:59.
//! [외부 연결] consumer: condition_eval.rs 등 main.rs 하위 bin 모듈.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// JS String(v) — absent(=undefined) 는 "undefined". 비교 강제·템플릿 삽입 공용.
pub fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num_str(n.as_f64().unwrap_or(0.0)),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|e| match e {
                Value::Null => String::new(),
                other => js_str(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// JS String(number) — 1e-6..1e21 구간은 고정 표기(정수값은 소수점 없음), 그 밖 e±exp.
fn js_num_str(f: f64) -> String {
    if f.is_nan() {
        return "NaN".to_string();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if f == 0.0 {
        return "0".to_string();
    }
    if (1e-6..1e21).contains(&f.abs()) {
        return if f == f.trunc() {
            format!("{f:.0}")
        } else {
            format!("{f}")
        };
    }
    let s = format!("{f:e}");
    let (mant, exp) = s.split_once('e').unwrap_or((s.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    format!("{}e{}{}", mant, if exp >= 0 { "+" } else { "-" }, exp.abs())
}

/// JS Number(str) — trim/빈→0/부호/Infinity/0x·0o·0b. "inf"·"infinity"(소문자)·"NaN"
///   문자열은 JS 가 NaN(Rust 파서는 통과)이라 먼저 걸러 둘의 도메인을 맞춘다.
fn js_num_from_str(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => match t.strip_prefix('+') {
            Some(r) => (1.0, r),
            None => (1.0, t),
        },
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    for w in ["inf", "infinity", "nan"] {
        if rest.eq_ignore_ascii_case(w) {
            return f64::NAN;
        }
    }
    if rest == t {
        for (p, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
            if let Some(d) = rest
                .strip_prefix(p)
                .or_else(|| rest.strip_prefix(&p.to_uppercase()))
            {
                return u64::from_str_radix(d, radix)
                    .map(|v| v as f64)
                    .unwrap_or(f64::NAN);
            }
        }
    }
    rest.parse::<f64>().map(|v| v * sign).unwrap_or(f64::NAN)
}

/// JS ToNumber(v) — bool→0/1, null→0, 문자열 파스, 그 외(array/object)는 toString 경유.
pub fn js_num(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(*b as u8),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_num_from_str(s),
        other => js_num_from_str(&js_str(other)),
    }
}

/// JS === — 타입 다르면 false. 객체/배열은 참조 동등이라 별도 JSON 트리에선 항상 false.
///   SameValueZero(array includes)와 JSON 도메인에서 동치다.
pub fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

fn strict_iso_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$").unwrap()
    })
}

/// condition-evaluator STRICT_ISO_8601_PATTERN 선검사 — 미달이면 "not an ISO-8601".
pub fn is_strict_iso_shape(s: &str) -> bool {
    strict_iso_re().is_match(s)
}

/// V8 Date.parse: 월 1-12 엄격, 일 1-31 허용 — 월말 초과분은 다음 달로 넘어간다
///   (2025-02-29 → 2025-03-01). days_from_civil 은 범위 밖 일자를 자연 rollover 한다.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// STRICT 통과 문자열의 Date.parse — V8 과 같은 도메인만 Some: 월 1-12, 일 1-31
///   (월말 초과분 rollover — 2025-02-29 → 2025-03-01), h 0-24(24 는 나머지 0 일 때만),
///   m/s 0-59, 오프셋 ±23:59.
pub fn strict_iso_epoch(s: &str) -> Option<i64> {
    let (y, mo, d): (i64, i64, i64) = (
        s[0..4].parse().ok()?,
        s[5..7].parse().ok()?,
        s[8..10].parse().ok()?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let t = &s[11..];
    let (h, mi, sec): (i64, i64, i64) = (
        t[0..2].parse().ok()?,
        t[3..5].parse().ok()?,
        t[6..8].parse().ok()?,
    );
    let (frac_ms, tail) = match t[8..].strip_prefix('.') {
        Some(f) => {
            let digits = f.len() - f.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            let d3: String = f.chars().take(3).collect();
            (format!("{d3:0<3}").parse::<i64>().ok()?, &t[9 + digits..])
        }
        None => (0, &t[8..]),
    };
    let off_ms = if tail == "Z" {
        0
    } else {
        let sign: i64 = if tail.starts_with('+') { -1 } else { 1 };
        let (oh, om): (i64, i64) = (tail[1..3].parse().ok()?, tail[4..6].parse().ok()?);
        if !(0..=23).contains(&oh) || !(0..=59).contains(&om) {
            return None;
        }
        sign * (oh * 3_600 + om * 60) * 1_000
    };
    if !(0..=59).contains(&mi)
        || !(0..=59).contains(&sec)
        || h > 24
        || (h == 24 && (mi != 0 || sec != 0 || frac_ms != 0))
    {
        return None;
    }
    days_from_civil(y, mo, d)
        .checked_mul(86_400)?
        .checked_add(h * 3_600 + mi * 60 + sec)?
        .checked_mul(1_000)?
        .checked_add(frac_ms)?
        .checked_add(off_ms)
}

#[cfg(test)]
#[rustfmt::skip]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_str_matches_string_coercion_domain() {
        assert_eq!(js_str(None), "undefined");
        assert_eq!(js_str(Some(&json!(null))), "null");
        assert_eq!(js_str(Some(&json!([1, null, "x"]))), "1,,x");
        assert_eq!(js_str(Some(&json!({"a":1}))), "[object Object]");
        assert_eq!(js_str(Some(&json!(1e21))), "1e+21");
        assert_eq!(js_str(Some(&json!(0.000001))), "0.000001");
        assert_eq!(js_str(Some(&json!(1e-7))), "1e-7");
        assert_eq!(js_str(Some(&json!(-0.0))), "0");
    }

    #[test]
    fn js_num_matches_to_number_domain() {
        assert_eq!(js_num(Some(&json!(" 5 "))), 5.0);
        assert_eq!(js_num(Some(&json!(""))), 0.0);
        assert_eq!(js_num(Some(&json!("0x10"))), 16.0);
        assert_eq!(js_num(Some(&json!("Infinity"))), f64::INFINITY);
        assert!(js_num(Some(&json!("inf"))).is_nan());
        assert!(js_num(Some(&json!("infinity"))).is_nan());
        assert_eq!(js_num(Some(&json!([5]))), 5.0);
        assert!(js_num(Some(&json!([1, 2]))).is_nan());
        assert_eq!(js_num(Some(&json!([]))), 0.0);
    }

    #[test]
    fn strict_iso_epoch_matches_date_parse_domain() {
        assert_eq!(strict_iso_epoch("2026-01-01T24:00:00Z"), strict_iso_epoch("2026-01-02T00:00:00Z"));
        assert_eq!(strict_iso_epoch("2026-07-20T10:00:00+09:00"), strict_iso_epoch("2026-07-20T01:00:00Z"));
        // V8: 월말 초과 일자는 다음 달로 rollover.
        assert_eq!(strict_iso_epoch("2025-02-29T00:00:00Z"), strict_iso_epoch("2025-03-01T00:00:00Z"));
        assert_eq!(strict_iso_epoch("2026-04-31T00:00:00Z"), strict_iso_epoch("2026-05-01T00:00:00Z"));
        assert!(strict_iso_epoch("2026-01-32T00:00:00Z").is_none()); // 일 32 는 거부
        assert!(strict_iso_epoch("2026-13-01T00:00:00Z").is_none()); // 월 13 거부
        assert!(strict_iso_epoch("2026-01-01T24:00:01Z").is_none()); // 24:00 은 나머지 0 만
        assert!(strict_iso_epoch("2026-01-01T00:00:00+24:00").is_none()); // 오프셋 범위 밖
        assert!(is_strict_iso_shape("2026-11-20T00:00:00.5Z"));
        assert!(!is_strict_iso_shape("07/20/2026"));
    }
}

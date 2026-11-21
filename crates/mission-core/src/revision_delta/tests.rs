//! num_str 의 JS `Number::toString` 패리티 검증 — JS JSON.parse 는 JSON 숫자를
//!   전부 IEEE-754 f64 로 읽으므로 큰 정수도 f64 반올림·최단 왕복 자리로 출력되어야
//!   한다(|x|>=1e21·|x|<1e-6 지수 표기 포함). 기대값은 모두 Node v24.22.1
//!   `String(JSON.parse(...))` 실측값이며 js_str(Value::Number) 경유로 실제
//!   소비 경로를 함께 친다.
use super::js_str;
use serde_json::json;

#[test]
fn integers_follow_js_f64_view() {
    assert_eq!(js_str(&json!(42)), "42");
    assert_eq!(js_str(&json!(-7)), "-7");
    // 2^53+1 은 f64 에서 2^53 과 같은 값 — JSON.parse 도 같은 자리를 만든다.
    assert_eq!(
        js_str(&json!(9_007_199_254_740_993_i64)),
        "9007199254740992"
    );
    // 2^63·i64::MIN·u64::MAX·2^64: i64/u64 로 정확해도 JS 시선은 f64 최단 왕복 자리다.
    assert_eq!(
        js_str(&json!(9_223_372_036_854_775_808_u64)),
        "9223372036854776000"
    );
    assert_eq!(js_str(&json!(i64::MIN)), "-9223372036854776000");
    assert_eq!(js_str(&json!(u64::MAX)), "18446744073709552000");
    assert_eq!(
        js_str(&json!(18_446_744_073_709_551_616_f64)),
        "18446744073709552000"
    );
}

#[test]
fn large_magnitudes_use_js_exponential_form() {
    assert_eq!(js_str(&json!(1e21)), "1e+21");
    assert_eq!(js_str(&json!(1.5e21)), "1.5e+21");
    assert_eq!(js_str(&json!(-1e21)), "-1e+21");
    assert_eq!(js_str(&json!(1.5e22)), "1.5e+22");
    assert_eq!(js_str(&json!(1e100)), "1e+100");
    // 1e21 바로 아래 정수는 지수가 아니라 자리 확장이다.
    assert_eq!(js_str(&json!(1e20)), "100000000000000000000");
}

#[test]
fn small_magnitudes_use_js_exponential_form() {
    assert_eq!(js_str(&json!(1e-7)), "1e-7");
    assert_eq!(js_str(&json!(-2.5e-7)), "-2.5e-7");
    assert_eq!(js_str(&json!(5e-324)), "5e-324"); // 최소 비정규(subnormal) 수
                                                  // -6 < n <= 0 경계에서는 고정 소수 표기를 유지한다.
    assert_eq!(js_str(&json!(1e-6)), "0.000001");
}

#[test]
fn zero_and_fractionals_match_js() {
    assert_eq!(js_str(&json!(0)), "0");
    assert_eq!(js_str(&json!(-0.0)), "0"); // JS: String(-0) === "0"
    assert_eq!(js_str(&json!(0.5)), "0.5");
    assert_eq!(js_str(&json!(0.1)), "0.1"); // 이진 근사여도 최단 왕복 자리만 출력
    assert_eq!(js_str(&json!(f64::MAX)), "1.7976931348623157e+308");
}

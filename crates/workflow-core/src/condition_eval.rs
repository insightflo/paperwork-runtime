//! [파일 목적] condition-evaluator.ts evaluateCondition 의 Rust 포트(Stage 4A).
//!   evaluate-conditions: condition 마다 TS 가 미리 해소한 `left` 를 받아 타입 검사·
//!   연산자 평가·all/any 환산만 한다 — resolveSource/readRestrictedJsonPath 는 TS 책임.
//! [parity] JS 강제 규칙(String/ToNumber/===/SameValueZero/ToPropertyKey)과 STRICT
//!   ISO-8601 + Date.parse 도메인은 js_value.rs 에 위임. 전건 평가 후 combinator 환산 —
//!   첫 fail 이 TS throw 와 같은 순서로 나간다. 에러 봉투 {error:{code,message}}:
//!   work_product_json 의 string/number/boolean 타입 불일치만 waitable_type_mismatch
//!   (date_time/array/object/operator/dataType fail 은 TS 도 일반 Error).
//! [외부 연결] consumer: main.rs CLI. 소스 해소·경로 문법 검사·grace-wait 판정은 TS 책임.

use crate::js_value::{is_strict_iso_shape, js_num, js_str, strict_eq, strict_iso_epoch};
use serde::Deserialize;
use serde_json::{json, Map, Value};

const ERROR_PREFIX: &str = "Workflow IF condition failed:";

#[derive(Deserialize)]
struct EvalInput {
    combinator: Option<Value>,
    #[serde(default)]
    conditions: Vec<Value>,
}

/// TS 의 throw 를 옮긴 내부 에러 — source 는 waitable 재구성용 (sourceStepId, sourceTitle).
struct CondErr {
    code: &'static str,
    message: String,
    source: Option<(Value, Value)>,
}

fn fail(msg: String) -> Box<CondErr> {
    Box::new(CondErr {
        code: "evaluation_failed",
        message: format!("{ERROR_PREFIX} {msg}"),
        source: None,
    })
}

/// failTypeMismatch — work_product_json 만 WorkProductConditionWaitableError 대응.
fn fail_type_mismatch(cond: &Map<String, Value>, msg: String) -> Box<CondErr> {
    let source = cond.get("source").and_then(Value::as_object);
    if source.and_then(|s| s.get("kind")).and_then(Value::as_str) == Some("work_product_json") {
        let src = source.map(|s| {
            (
                s.get("stepId").cloned().unwrap_or(Value::Null),
                s.get("title").cloned().unwrap_or(Value::Null),
            )
        });
        Box::new(CondErr {
            code: "waitable_type_mismatch",
            message: format!("{ERROR_PREFIX} {msg}"),
            source: src,
        })
    } else {
        fail(msg)
    }
}

/// describeSource — `path "p" (source step "s", tool "t"|work product "t")`.
fn describe_source(source: &Map<String, Value>) -> String {
    let ref_ = if source.get("kind").and_then(Value::as_str) == Some("tool_json") {
        format!("tool \"{}\"", js_str(source.get("toolName")))
    } else {
        format!("work product \"{}\"", js_str(source.get("title")))
    };
    format!(
        "path \"{}\" (source step \"{}\", {ref_})",
        js_str(source.get("path")),
        js_str(source.get("stepId"))
    )
}

/// toEpochMillis — 비문자열/STRICT 미달은 "is not an ISO-8601 …", 형태 ok·달력 무효는
///   "is not a valid ISO-8601 …" (둘 다 일반 fail — date_time 은 waitable 이 아니다).
fn to_epoch_millis(v: Option<&Value>, source: &Map<String, Value>) -> Result<i64, Box<CondErr>> {
    let Some(s) = v.and_then(Value::as_str).filter(|s| is_strict_iso_shape(s)) else {
        return Err(fail(format!(
            "value at {} is not an ISO-8601 date/time string",
            describe_source(source)
        )));
    };
    strict_iso_epoch(s).ok_or_else(|| {
        fail(format!(
            "value at {} is not a valid ISO-8601 date/time string",
            describe_source(source)
        ))
    })
}

fn unsupported_op(family: &str, operator: &str, source: &Map<String, Value>) -> Box<CondErr> {
    fail(format!(
        "unsupported {family} operator \"{operator}\" at {}",
        describe_source(source)
    ))
}

/// evaluateCondition — assertLeftType(타입 검사) 후 연산자 평가. left absent 는 JS
///   undefined 와 동일하게 모든 타입 검사에서 불일치로 흐른다.
fn evaluate_condition(
    cond: &Map<String, Value>,
    left: Option<&Value>,
) -> Result<bool, Box<CondErr>> {
    let data_type = js_str(cond.get("dataType"));
    let operator = js_str(cond.get("operator"));
    let source = cond
        .get("source")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let rv = cond.get("rightValue");
    // assertLeftType — string/number/boolean 만 failTypeMismatch, 나머지는 일반 fail.
    let type_ok = match data_type.as_str() {
        "string" => left.and_then(Value::as_str).is_some(),
        "number" => left.and_then(Value::as_f64).is_some_and(|f| f.is_finite()),
        "boolean" => left.and_then(Value::as_bool).is_some(),
        "date_time" => {
            to_epoch_millis(left, &source)?;
            true
        }
        "array" => left.and_then(Value::as_array).is_some(),
        "object" => left.and_then(Value::as_object).is_some(),
        _ => return Err(fail(format!("unsupported dataType \"{data_type}\""))),
    };
    if !type_ok {
        let kind = match data_type.as_str() {
            "string" => "a string",
            "number" => "a finite number",
            "boolean" => "a boolean",
            "array" => "an array",
            _ => "an object",
        };
        let msg = format!("value at {} is not {kind}", describe_source(&source));
        return Err(match data_type.as_str() {
            "string" | "number" | "boolean" => fail_type_mismatch(cond, msg),
            _ => fail(msg),
        });
    }
    match data_type.as_str() {
        "string" => {
            let l = left.and_then(Value::as_str).unwrap_or_default();
            Ok(match operator.as_str() {
                "equals" => rv.and_then(Value::as_str) == Some(l),
                "not_equals" => rv.and_then(Value::as_str) != Some(l),
                "contains" => l.contains(&js_str(rv)),
                "not_contains" => !l.contains(&js_str(rv)),
                "starts_with" => l.starts_with(&js_str(rv)),
                "ends_with" => l.ends_with(&js_str(rv)),
                "is_empty" => l.is_empty(),
                "is_not_empty" => !l.is_empty(),
                _ => return Err(unsupported_op("string", &operator, &source)),
            })
        }
        "number" => {
            let l = left.and_then(Value::as_f64).unwrap_or(0.0);
            Ok(match operator.as_str() {
                "equals" => rv.and_then(Value::as_f64).is_some_and(|r| l == r),
                "not_equals" => !rv.and_then(Value::as_f64).is_some_and(|r| l == r),
                "greater_than" => l > js_num(rv),
                "greater_than_or_equal" => l >= js_num(rv),
                "less_than" => l < js_num(rv),
                "less_than_or_equal" => l <= js_num(rv),
                _ => return Err(unsupported_op("number", &operator, &source)),
            })
        }
        "boolean" => match operator.as_str() {
            "is_true" => Ok(left.and_then(Value::as_bool) == Some(true)),
            "is_false" => Ok(left.and_then(Value::as_bool) == Some(false)),
            _ => Err(unsupported_op("boolean", &operator, &source)),
        },
        "date_time" => {
            let (l, r) = (
                to_epoch_millis(left, &source)?,
                to_epoch_millis(rv, &source)?,
            );
            Ok(match operator.as_str() {
                "equals" => l == r,
                "not_equals" => l != r,
                "after" => l > r,
                "after_or_equal" => l >= r,
                "before" => l < r,
                "before_or_equal" => l <= r,
                _ => return Err(unsupported_op("date_time", &operator, &source)),
            })
        }
        "array" => {
            let l = left.and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(match operator.as_str() {
                "is_empty" => l.is_empty(),
                "is_not_empty" => !l.is_empty(),
                "contains" => rv.is_some_and(|r| l.iter().any(|e| strict_eq(e, r))),
                _ => return Err(unsupported_op("array", &operator, &source)),
            })
        }
        "object" => {
            let l = left.and_then(Value::as_object).cloned().unwrap_or_default();
            Ok(match operator.as_str() {
                "is_empty" => l.is_empty(),
                "is_not_empty" => !l.is_empty(),
                "has_key" => l.contains_key(&js_str(rv)),
                _ => return Err(unsupported_op("object", &operator, &source)),
            })
        }
        _ => Err(fail(format!("unsupported dataType \"{data_type}\""))),
    }
}

/// evaluate-conditions 서브커맨드 — 전건 평가 후 all/any 환산, 첫 fail 은 봉투로 반환.
pub fn evaluate_conditions(raw: &[u8]) -> Result<Value, String> {
    let input: EvalInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(input.conditions.len());
    for cond in &input.conditions {
        let obj = cond.as_object().cloned().unwrap_or_default();
        match evaluate_condition(&obj, obj.get("left")) {
            Ok(b) => results.push(b),
            Err(e) => {
                let mut err = json!({ "code": e.code, "message": e.message });
                if let Some((step_id, title)) = e.source {
                    err["sourceStepId"] = step_id;
                    err["sourceTitle"] = title;
                }
                return Ok(json!({ "error": err }));
            }
        }
    }
    // TS: combinator === "all" ? every : some — 비-"all"(absent 포함)은 some 환산.
    let outcome = if input
        .combinator
        .and_then(|c| c.as_str().map(str::to_string))
        .as_deref()
        == Some("all")
    {
        results.iter().all(|b| *b)
    } else {
        results.iter().any(|b| *b)
    };
    Ok(json!({ "outcome": outcome, "results": results }))
}

#[cfg(test)]
#[rustfmt::skip] // fixture/기대값을 한 줄 raw-string JSON 으로 유지 — 읽기 표이 compact 해진다.
mod tests {
    use super::*;

    fn run(payload: &str) -> Value {
        evaluate_conditions(payload.as_bytes()).unwrap()
    }

    #[test]
    fn operators_and_combinator_contract() {
        let src = r#"{"kind":"work_product_json","stepId":"p","path":"$","title":"t.json"}"#;
        let out = run(&format!(r#"{{"combinator":"all","conditions":[
            {{"source":{src},"dataType":"string","operator":"starts_with","rightValue":"sel","left":"selected"}},
            {{"source":{src},"dataType":"number","operator":"greater_than","rightValue":4,"left":5}},
            {{"source":{src},"dataType":"array","operator":"contains","rightValue":2,"left":[1,2,3]}},
            {{"source":{src},"dataType":"object","operator":"has_key","rightValue":"a","left":{{"a":1}}}},
            {{"source":{src},"dataType":"date_time","operator":"equals","rightValue":"2026-07-20T01:00:00Z","left":"2026-07-20T10:00:00+09:00"}}
        ]}}"#));
        assert_eq!(out, json!({"outcome":true,"results":[true,true,true,true,true]}));
        // 비-"all" combinator 는 some 환산(TS `=== "all"` 삼항과 동일).
        let out = run(&format!(r#"{{"combinator":"odd","conditions":[{{"source":{src},"dataType":"string","operator":"equals","rightValue":"x","left":"y"}}]}}"#));
        assert_eq!(out["outcome"], json!(false));
    }

    #[test]
    fn waitable_only_for_work_product_type_mismatch() {
        let wp = r#"{"kind":"work_product_json","stepId":"p","path":"$.n","title":"t"}"#;
        let tool = r#"{"kind":"tool_json","stepId":"p","path":"$.n","toolName":"m"}"#;
        let mk = |s: &str, dt: &str, left: &str| format!(r#"{{"combinator":"all","conditions":[{{"source":{s},"dataType":"{dt}","operator":"equals","rightValue":1,"left":{left}}}]}}"#);
        let out = run(&mk(wp, "number", "\"x\""));
        assert_eq!(out["error"]["code"], json!("waitable_type_mismatch"));
        assert_eq!(out["error"]["sourceStepId"], json!("p"));
        assert_eq!(out["error"]["message"], json!("Workflow IF condition failed: value at path \"$.n\" (source step \"p\", work product \"t\") is not a finite number"));
        let out = run(&mk(tool, "number", "\"x\""));
        assert_eq!(out["error"]["code"], json!("evaluation_failed"));
        assert_eq!(out["error"]["message"], json!("Workflow IF condition failed: value at path \"$.n\" (source step \"p\", tool \"m\") is not a finite number"));
        // date_time/array 불일치는 work_product 여도 일반 Error(TS fail 직행).
        for dt in ["date_time", "array"] {
            assert_eq!(run(&mk(wp, dt, "\"x\""))["error"]["code"], json!("evaluation_failed"));
        }
        let out = run(&format!(r#"{{"combinator":"all","conditions":[{{"source":{wp},"dataType":"weird","operator":"equals","left":1}}]}}"#));
        assert_eq!(out["error"]["message"], json!("Workflow IF condition failed: unsupported dataType \"weird\""));
        let out = run(&format!(r#"{{"combinator":"all","conditions":[{{"source":{wp},"dataType":"boolean","operator":"equals","left":true}}]}}"#));
        assert_eq!(out["error"]["message"], json!("Workflow IF condition failed: unsupported boolean operator \"equals\" at path \"$.n\" (source step \"p\", work product \"t\")"));
    }

    #[test]
    fn evaluates_all_conditions_before_reduction() {
        let src = r#"{"kind":"work_product_json","stepId":"p","path":"$","title":"t"}"#;
        // 첫 조건이 AND 를 이미 false 로 결정해도 둘째의 타입 불일치가 throw 되어야 한다.
        let out = run(&format!(r#"{{"combinator":"all","conditions":[
            {{"source":{src},"dataType":"string","operator":"equals","rightValue":"nope","left":"x"}},
            {{"source":{src},"dataType":"string","operator":"equals","rightValue":"y","left":5}}
        ]}}"#));
        assert_eq!(out["error"]["code"], json!("waitable_type_mismatch"));
    }
}

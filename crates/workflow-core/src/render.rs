//! [파일 목적] tool-step 인자 템플릿 렌더의 Rust 포트(tool-step-template-render.ts, Stage 3).
//!   순수 렌더 엔진: 토큰 치환(runDate→date→workflowRunId→runMonth→steps→runMetadata→
//!   childInputs) → bash `$`-residue 정화 → 미해결 {$childInputs.*} fail-closed 검출.
//! [parity] 치환 순서·own-property 규칙·JSON.stringify 숫자 포맷·객체 키 순서(serde_json
//!   preserve_order, F3)·Node path.dirname/join(separator 페이로드, F5 — render_path.rs)을
//!   TS 에 정렬한다. 비문자열 workProductPath 는 keep-token 근사(TS 는 dirname 에서 TypeError 붕괴).
//! [외부 연결] consumer: main.rs CLI(render-tool-args). DB 조회·pin 기록은 TS 책임(미포트).

use crate::render_path::{dirname, join_assets};
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

macro_rules! token_re {
    ($name:ident, $pat:literal) => {
        fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pat).unwrap())
        }
    };
}
token_re!(
    steps_token_re,
    r"\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}"
);
token_re!(run_meta_re, r"\{\$runMetadata\.([A-Za-z0-9_]+)\}");
token_re!(child_inputs_re, r"\{\$childInputs\.([A-Za-z0-9_]+)\}");
token_re!(unresolved_child_re, r"\{\$childInputs\.[^}]*\}");
token_re!(run_month_re, r"^([0-9]{4})-([0-9]{2})");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderInput {
    args: Value,
    run_date: String,
    run_id: String,
    #[serde(default)]
    paths_by_step_id: Map<String, Value>,
    #[serde(default)]
    run_metadata: Map<String, Value>,
    separator: String,
}

struct Ctx<'a> {
    run_date: &'a str,
    run_id: &'a str,
    paths: &'a Map<String, Value>,
    run_meta: &'a Map<String, Value>,
    sep: char,
}

/// render-tool-args 서브커맨드 진입점 — 성공 {args}, 미해결 childInputs 는 구조화 error(종료 0).
pub fn render_tool_args(raw: &[u8]) -> Result<Value, String> {
    let input: RenderInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let ctx = Ctx {
        run_date: &input.run_date,
        run_id: &input.run_id,
        paths: &input.paths_by_step_id,
        run_meta: &input.run_metadata,
        sep: input.separator.chars().next().unwrap_or('/'),
    };
    let rendered = render_templates(&input.args, &ctx);
    // TS: JSON.stringify(rendered ?? "") — null args 도 문자열 "" 로 직렬화 후 잔존 토큰 검출.
    let serialized = if rendered.is_null() {
        "\"\"".to_string()
    } else {
        js_stringify(&rendered)
    };
    if let Some(m) = unresolved_child_re().find(&serialized) {
        let token = m.as_str();
        return Ok(json!({
            "error": {
                "code": "unresolved_child_inputs",
                "token": token,
                "message": format!("Unresolved {{$childInputs}} token in tool args: {token} (child input keys must be declared on the parent workflow step inputs)"),
            }
        }));
    }
    Ok(json!({ "args": rendered }))
}

fn render_templates(v: &Value, ctx: &Ctx) -> Value {
    match v {
        Value::String(s) => Value::String(strip_residue(&substitute(s, ctx))),
        Value::Array(a) => Value::Array(a.iter().map(|x| render_templates(x, ctx)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), render_templates(x, ctx)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn substitute(s: &str, ctx: &Ctx) -> String {
    let s = s
        .replace("{$runDate}", ctx.run_date)
        .replace("{$date}", ctx.run_date)
        .replace("{$workflowRunId}", ctx.run_id);
    let s = match run_month(ctx.run_date) {
        Some(m) => s.replace("{$runMonth}", &m),
        None => s, // TS: 파싱 실패 시 리터럴 토큰 유지.
    };
    let s = steps_token_re().replace_all(&s, |caps: &Captures| {
        let p = ctx
            .paths
            .get(&caps[1])
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        let Some(p) = p else {
            return caps[0].to_string(); // unknown/빈 경로 → 토큰 유지.
        };
        match &caps[2] {
            "workProductPath" => p.to_string(),
            "siblingAssetsDir" => join_assets(&dirname(p, ctx.sep), ctx.sep),
            _ => dirname(p, ctx.sep),
        }
    });
    let s = run_meta_re().replace_all(&s, |caps: &Captures| {
        ctx.run_meta
            .get(&caps[1])
            .map_or_else(|| caps[0].to_string(), meta_str)
    });
    // childInputs bag: runMetadata.workflowChildInputs 가 비배열 객체일 때만 own-key 조회.
    let bag = ctx
        .run_meta
        .get("workflowChildInputs")
        .and_then(Value::as_object);
    child_inputs_re()
        .replace_all(&s, |caps: &Captures| {
            bag.and_then(|b| b.get(&caps[1]))
                .map_or_else(|| caps[0].to_string(), meta_str)
        })
        .into_owned()
}

/// stringifyWorkflowRunMetadataValue — 문자열 그대로, 그 외 JSON.stringify 직렬화.
fn meta_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => js_stringify(other),
    }
}

fn strip_residue(s: &str) -> String {
    let drop = s.starts_with("$/") || s.starts_with("$'");
    s[usize::from(drop)..].to_string()
}

fn run_month(run_date: &str) -> Option<String> {
    let caps = run_month_re().captures(run_date)?;
    Some(format!("{}{}", &caps[1], &caps[2]))
}

/// JSON.stringify — 모든 숫자는 f64(JS 도메인), 객체 키 순서는 preserve_order 삽입 순서.
fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(js_stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(m) => {
            let items: Vec<String> = m
                .iter()
                .map(|(k, x)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        js_stringify(x)
                    )
                })
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

/// ECMAScript Number→String — shortest-round-trip 자릿수(format {:e})에 JS 자릿수 배치 규칙 적용.
///   비유한 값(NaN/±∞, 예: 1e999)은 JSON.stringify 관습으로 "null", -0 은 "0".
fn js_number(f: f64) -> String {
    if !f.is_finite() {
        return "null".to_string();
    }
    if f == 0.0 {
        return "0".to_string();
    }
    let sci = format!("{:e}", f.abs()); // "d.ddde<exp>" (shortest)
    let (mant, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let (k, n) = (digits.len() as i64, exp.parse::<i64>().unwrap_or(0) + 1);
    let body = if n > 21 || n <= -6 {
        let mut s = digits[0..1].to_string();
        if k > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        format!("{s}e{}{}", if n > 1 { "+" } else { "" }, n - 1)
    } else if n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else if k <= n {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    };
    if f < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

#[cfg(test)]
#[rustfmt::skip] // fixture/기대값을 한 줄 raw-string JSON 으로 유지 — 읽기 표이 compact 해진다.
mod tests {
    use super::*;

    fn render(payload: &str) -> Value {
        render_tool_args(payload.as_bytes()).unwrap()
    }

    #[test]
    fn token_chain_order_and_month_fallback() {
        assert_eq!(render(r#"{"args":"{$runDate}|{$date}|{$workflowRunId}|{$runMonth}","runDate":"2026-11-20","runId":"r1","pathsByStepId":{},"runMetadata":{},"separator":"/"}"#)["args"], json!("2026-11-20|2026-11-20|r1|202611"));
        assert_eq!(render(r#"{"args":"{$runMonth}","runDate":"2026-13-01","runId":"r","pathsByStepId":{},"runMetadata":{},"separator":"/"}"#)["args"], json!("202613")); // 월 범위 검사 없음.
        assert_eq!(render(r#"{"args":"{$runMonth}","runDate":"nope","runId":"r","pathsByStepId":{},"runMetadata":{},"separator":"/"}"#)["args"], json!("{$runMonth}"));
    }

    #[test]
    fn steps_tokens_metadata_and_child_inputs() {
        assert_eq!(render(r#"{"args":"{$steps.s1.workProductPath}|{$steps.s1.workProductDir}|{$steps.s1.siblingAssetsDir}|{$steps.x.workProductPath}","runDate":"d","runId":"r","pathsByStepId":{"s1":"/w/out/f.json"},"runMetadata":{},"separator":"/"}"#)["args"], json!("/w/out/f.json|/w/out|/w/out/assets|{$steps.x.workProductPath}"));
        let out = render(r#"{"args":["{$runMetadata.s}","{$runMetadata.n}","{$runMetadata.o}","{$runMetadata.missing}","{$childInputs.c}"],"runDate":"d","runId":"r","pathsByStepId":{},"runMetadata":{"s":"txt","n":1.5,"o":{"b":1,"a":2},"workflowChildInputs":{"c":"v"}},"separator":"/"}"#);
        assert_eq!(out["args"], json!(["txt","1.5","{\"b\":1,\"a\":2}","{$runMetadata.missing}","v"]));
        assert!(out["error"].is_null());
    }

    #[test]
    fn residue_strip_and_fail_closed() {
        assert_eq!(render(r#"{"args":{"a":"$/srv/x","b":"$'/y'","c":"$$","d":"$HOME"},"runDate":"d","runId":"r","pathsByStepId":{},"runMetadata":{},"separator":"/"}"#)["args"], json!({"a":"/srv/x","b":"'/y'","c":"$$","d":"$HOME"}));
        let out = render(r#"{"args":"{$childInputs.bad-key}","runDate":"d","runId":"r","pathsByStepId":{},"runMetadata":{"workflowChildInputs":{"a":1}},"separator":"/"}"#);
        assert_eq!(out["error"]["code"], json!("unresolved_child_inputs"));
        assert_eq!(out["error"]["token"], json!("{$childInputs.bad-key}"));
    }

    #[test]
    fn js_number_edge_cases() {
        assert_eq!(js_number(1e30), "1e+30");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(f64::INFINITY), "null");
        assert_eq!(js_number(3.0), "3");
    }
}

use crate::structural_gate::js_trim;
use paperclip_workflow_core::control_flow::{EdgeBearingStep, PredFacts};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::env;
use std::io::{self, Read};
use std::process;

/// Stage 서브커맨드 bin 모듈(lib 미공개) — js_value: JS 의미론, condition_eval:
///   IF 조건 평가, retry_batch: 재시도 배치 판정·패치, render: tool-arg, readiness: 게이트,
///   dispatch: 서브커맨드 테이블, artifact_refs/structural_gate: Stage 7A 포트,
///   resume_eligibility: Stage 7C 포트, resume_graph: Stage 8A 포트,
///   definition_step_validation/run_input_derivations: Stage 8C 포트.
mod artifact_refs;
mod condition_eval;
mod definition_step_validation;
mod dispatch;
mod js_value;
mod qa_defect_card;
mod readiness;
mod render;
mod render_path;
mod resume_eligibility;
mod resume_graph;
mod retry_batch;
mod run_input_derivations;
mod structural_gate;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

/// EdgeBearingStep 의 JS-permissive 구성: 문자열 id 만 채택, deps/conditional 는 raw 보존.
fn edge_step(v: &Value) -> EdgeBearingStep {
    EdgeBearingStep {
        id: v
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        dependencies: v.get("dependencies").cloned(),
        conditional_dependencies: v.get("conditionalDependencies").cloned(),
    }
}

fn pred_facts_map(preds: HashMap<String, Value>) -> HashMap<String, PredFacts> {
    preds
        .into_iter()
        .map(|(k, v)| (k, PredFacts::from_value(&v)))
        .collect()
}

// ── Stage 8C 공용 술어 — definition_step_validation·run_input_derivations 가 공유하는
//   JS 의미론. 300줄 상한·파일 수 제한 때문에 bin 루트에 둔다(edge_step/pred_facts_map 과
//   같은 패턴). js_array_index 는 artifact_refs 비공개 사본과 동일 규칙을 재구현한다.

/// JS truthy — null/false/±0/"" 만 거짓 (빈 배열·객체는 참).
pub(crate) fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false))
        && v.as_f64() != Some(0.0)
        && v.as_str() != Some("")
}
/// zod .strict() — 키 집합이 전부 알려진 키에 포함되어야 한다.
pub(crate) fn strict(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}
/// JS canonical array index — 선행 0·u32::MAX·10자리 초과는 문자열 키.
pub(crate) fn js_array_index(k: &str) -> Option<u32> {
    if k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) || k.starts_with('0') && k.len() > 1 {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}
/// zod optional 필드 — 부재 또는 문자열이어야 통과.
pub(crate) fn opt_str(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).is_none_or(Value::is_string)
}
/// zod optional 필드 — 부재 또는 불이어야 통과.
pub(crate) fn opt_bool(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).is_none_or(Value::is_boolean)
}
/// 문자열이고 js_trim 후 비지 않을 때만 Some(트림본) — provided/source 게이트 전용.
pub(crate) fn nonempty_str(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s)),
        _ => None,
    }
}
/// runInputs keySchema 문자 클래스 `[A-Za-z0-9_]` — youtube id 와 달리 하이픈 불가.
pub(crate) fn key_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
/// youtube id 문자 클래스 `[A-Za-z0-9_-]`.
fn id_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}
fn take_id(rest: &[u8]) -> Option<String> {
    if rest.len() < 11
        || !rest[..11].iter().all(|&b| id_char(b))
        || rest.get(11).is_some_and(|&b| id_char(b))
    {
        return None;
    }
    String::from_utf8(rest[..11].to_vec()).ok()
}
fn prefix_ends(value: &str, p: u8) -> Vec<usize> {
    let b = value.as_bytes();
    match p {
        0 => value
            .match_indices("youtu.be/")
            .map(|(i, _)| i + 9)
            .collect(),
        1 => (1..b.len().saturating_sub(1))
            .filter(|&i| matches!(b[i - 1], b'?' | b'&') && b[i] == b'v' && b[i + 1] == b'=')
            .map(|i| i + 2)
            .collect(),
        _ => value
            .match_indices("youtube.com/shorts/")
            .map(|(i, _)| i + 19)
            .collect(),
    }
}
/// extractYoutubeVideoId — 패턴 순서(youtu.be → [?&]v= → shorts)로 첫 유효 11자 ID.
pub(crate) fn youtube_id(value: &str) -> Option<String> {
    (0..3).find_map(|p| {
        prefix_ends(value, p)
            .into_iter()
            .find_map(|i| take_id(&value.as_bytes()[i..]))
    })
}

/// `in` 연산자가 보는 Object.prototype·Array.prototype 이름들.
pub(crate) const OBJ_PROTO: &[&str] = &[
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];
pub(crate) const ARR_PROTO: &[&str] = &[
    "at",
    "concat",
    "copyWithin",
    "entries",
    "every",
    "fill",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "forEach",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "length",
    "map",
    "pop",
    "push",
    "reduce",
    "reduceRight",
    "reverse",
    "shift",
    "slice",
    "some",
    "sort",
    "splice",
    "toReversed",
    "toSorted",
    "toSpliced",
    "unshift",
    "values",
    "with",
];
/// JS `k in v` — 객체는 own 키+Object.prototype, 배열은 canonical index+Array.prototype,
///   그 외(비객체 selectors 는 {} 취급)는 Object.prototype 이름만.
pub(crate) fn js_in(k: &str, v: Option<&Value>) -> bool {
    match v {
        Some(Value::Object(o)) => o.contains_key(k) || OBJ_PROTO.contains(&k),
        Some(Value::Array(a)) => {
            js_array_index(k).is_some_and(|n| (n as usize) < a.len())
                || OBJ_PROTO.contains(&k)
                || ARR_PROTO.contains(&k)
        }
        _ => OBJ_PROTO.contains(&k),
    }
}

/// zod unrecognized_keys 메시지 — 키는 입력 삽입 순으로 'a', 'b' 조인.
pub(crate) fn unrecognized(keys: &[&String]) -> String {
    let ks = keys
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Unrecognized key(s) in object: {ks}")
}
/// zod min(1) too_small 기본 메시지 — deriveFrom.input/option.value 공용.
pub(crate) const TOO_SMALL: &str = "String must contain at least 1 character(s)";
/// zod union 분기/필드 스캔 — Abort=이슈 폐기(타입·필수부재·literal/enum/never 불일치),
///   Dirty=첫 이슈 보존(regex/min·strict extras·superRefine), Clean.
pub(crate) enum Br {
    Abort,
    Dirty(String, String),
    Clean,
}
impl Br {
    /// shape 순 병합 — 어느 쪽이든 Abort 면 Abort, 아니면 첫 Dirty.
    pub(crate) fn then(self, b: Br) -> Br {
        match (self, b) {
            (Br::Abort, _) | (_, Br::Abort) => Br::Abort,
            (s @ Br::Dirty(..), _) | (_, s @ Br::Dirty(..)) => s,
            _ => Br::Clean,
        }
    }
}
/// abort 전용 스캔 — cond 가 참이면 Abort, 아니면 Clean.
pub(crate) fn ab(cond: bool) -> Br {
    if cond {
        Br::Abort
    } else {
        Br::Clean
    }
}
/// strict extras — keys 밖 키가 있으면 path 위치의 unrecognized_keys Dirty.
pub(crate) fn extras_at(o: &Map<String, Value>, keys: &[&str], path: String) -> Br {
    let extra: Vec<_> = o.keys().filter(|k| !keys.contains(&k.as_str())).collect();
    if extra.is_empty() {
        Br::Clean
    } else {
        Br::Dirty(path, unrecognized(&extra))
    }
}
/// runInputs option 요소 {value:min1,label:string}.strict() — 이슈는 options.{j} 스코프.
pub(crate) fn opt_item_scan(j: usize, e: &Value) -> Br {
    let Some(io) = e.as_object() else {
        return Br::Abort;
    };
    let s = match io.get("value") {
        Some(Value::String(v)) if v.is_empty() => {
            Br::Dirty(format!("options.{j}.value"), TOO_SMALL.into())
        }
        Some(Value::String(_)) => Br::Clean,
        _ => return Br::Abort,
    };
    s.then(ab(!matches!(io.get("label"), Some(Value::String(_)))))
        .then(extras_at(io, &["value", "label"], format!("options.{j}")))
}

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

/// qa-defect-card-historical 은 lone surrogate 문자열을 낼 수 있어 Value 직렬화를 우회해
///   직접 JSON 텍스트를 받는다; 나머지 서브커맨드는 dispatch::dispatch 의 Value 경로.
fn dispatch_text(subcommand: &str, raw: &[u8]) -> Result<String, String> {
    if subcommand == "qa-defect-card-historical" {
        return qa_defect_card::historical_card(raw);
    }
    dispatch::dispatch(subcommand, raw)
        .and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(
            "usage: paperclip-workflow-core <normalize-policy|calculate-delay|classify-retry|classify-retry-batch|sanitize-error|append-attempt|read-metadata|is-due|validate-dag|has-disallowed-cycle|classify-activation|find-skippable|runnable-steps|skippable-steps|activate|render-tool-args|evaluate-conditions|qa-defect-card-historical|artifact-references|ancestor-step-ids|tool-reference-errors|gate-producer-token|same-producer-token|is-structural-gate|structural-topology-errors|check-step-eligibility|sort-steps-by-priority|forward-reachable|normalize-step-contract|normalize-step-machine-checks|validate-definition-steps|definition-step-warnings|summarize-step-warnings|extract-youtube-video-id|validate-run-input-declarations|apply-run-input-derivations>"
                .to_string(),
        );
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    println!("{}", dispatch_text(subcommand, &raw)?);
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

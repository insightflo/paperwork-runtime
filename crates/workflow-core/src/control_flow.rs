//! [파일 목적] 워크플로 IF(조건부 edge) 활성화 평가의 Rust 포트(edge-condition.ts, Stage 2). 순수 함수만 제공한다.
//! [parity 주의] TS duck-typing 관대성과 정렬: 잘못된 edge/필드는 drop 하고 hard-fail 하지 않는다.
//!   edge 는 stepId 가 문자열이어야 하고, when 의 unknown 문자열은 Other(절대 발화하지 않는 edge)로 보존한다.
//!   isBackEdge===true / dispatchReady===false / maxIterations typeof number 는 정확히 일치할 때만 적용.
//! [외부 연결] consumer: main.rs CLI(classify-activation/find-skippable), dag.rs(edge 해석 재사용).

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// failed-선행 회복 채널 판정 + 기계 QA 반려 서명(edge-condition.ts 의 recovery/QA 절 포트).
pub mod recovery;

/// 조건부 edge 발화 조건. 선행 step 종료 상태에 대한 한정(unknown 문자열 = Other).
#[derive(Clone, Debug, PartialEq)]
pub enum When {
    Success,
    Failure,
    Always,
    QaRequestChanges,
    ConditionTrue,
    ConditionFalse,
    Other(String),
}

impl When {
    /// TS `when ?? "success"`: null/absent → None(=success 기본), unknown/비문자열 → Other.
    pub fn parse(v: Option<&Value>) -> Option<When> {
        match v {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(match s.as_str() {
                "success" => When::Success,
                "failure" => When::Failure,
                "always" => When::Always,
                "qa_request_changes" => When::QaRequestChanges,
                "condition_true" => When::ConditionTrue,
                "condition_false" => When::ConditionFalse,
                _ => When::Other(s.clone()),
            }),
            Some(other) => Some(When::Other(other.to_string())),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            When::Success => "success",
            When::Failure => "failure",
            When::Always => "always",
            When::QaRequestChanges => "qa_request_changes",
            When::ConditionTrue => "condition_true",
            When::ConditionFalse => "condition_false",
            When::Other(s) => s,
        }
    }
}

/// 풍부한 edge: 대상 step + 발화 조건(when) + loop annotation. is_back_edge 는 JSON true 일 때만.
#[derive(Clone, Debug, PartialEq)]
pub struct ConditionalEdge {
    pub step_id: String,
    pub when: Option<When>,
    pub is_back_edge: bool,
    /// TS `typeof maxIterations === "number"` — JSON number 만 Some.
    pub max_iterations: Option<f64>,
}

impl ConditionalEdge {
    /// object 가 아니거나 stepId 가 문자열이 아니면 None(TS resolveEdges 의 edge drop 와 동일).
    /// 빈 stepId 도 보존한다 — validate_dag 의 orphan 검사는 빈 참조도 오류로 보고하기 때문.
    pub fn from_value(v: &Value) -> Option<ConditionalEdge> {
        let obj = v.as_object()?;
        Some(ConditionalEdge {
            step_id: obj.get("stepId").and_then(Value::as_str)?.to_string(),
            when: When::parse(obj.get("when")),
            is_back_edge: matches!(obj.get("isBackEdge"), Some(Value::Bool(true))),
            max_iterations: obj.get("maxIterations").and_then(Value::as_f64),
        })
    }
}

/// legacy dependencies[] + conditionalDependencies[] 를 그대로 담는 step(edge 평가 입력).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeBearingStep {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub dependencies: Option<Value>,
    #[serde(default)]
    pub conditional_dependencies: Option<Value>,
}

/// 배열 원소 중 문자열만 있는 그대로(빈 문자열/중복 포함, 비문자열 drop).
pub fn string_elements(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

impl EdgeBearingStep {
    /// 조건부 edge 전체(빈 stepId 포함) — dag.rs 의 raw 접근용.
    pub fn conditional_edges_raw(&self) -> Vec<ConditionalEdge> {
        self.conditional_dependencies
            .as_ref()
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(ConditionalEdge::from_value).collect())
            .unwrap_or_default()
    }
}

/// legacy deps(빈 문자열 drop, 중복 유지)를 when:"success" edge 로, conditional edge 는 stepId 빈
/// 문자열만 drop 해 병합 — TS resolveEdges 와 동일.
pub fn resolve_edges(step: &EdgeBearingStep) -> Vec<ConditionalEdge> {
    let mut edges: Vec<ConditionalEdge> = string_elements(step.dependencies.as_ref())
        .into_iter()
        .filter(|dep| !dep.is_empty())
        .map(|step_id| ConditionalEdge {
            step_id,
            when: Some(When::Success),
            is_back_edge: false,
            max_iterations: None,
        })
        .collect();
    edges.extend(
        step.conditional_edges_raw()
            .into_iter()
            .filter(|edge| !edge.step_id.is_empty()),
    );
    edges
}

/// 선행 step 종료 사실(edge 평가에 필요한 최소 사실망).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredFacts {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub is_qa_gate: bool,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub verdict_checked: bool,
    #[serde(default)]
    pub control_outcome: Option<String>,
    /// `dispatchReady === false` 인 경우에만 대기 규칙 적용(None/true/비bool → 미적용).
    #[serde(default)]
    pub dispatch_ready: Option<bool>,
    #[serde(default)]
    pub failure_recovery_channel: Option<String>,
}

/// JS truthiness(JSON 값 기준) — TS `if (pred.isQaGate)` / `if (pred.verdictChecked)` 정렬.
pub fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

impl PredFacts {
    pub fn from_value(v: &Value) -> PredFacts {
        let obj = v.as_object();
        let get = |key: &str| obj.and_then(|o| o.get(key));
        let str_field = |key: &str| get(key).and_then(Value::as_str).map(str::to_string);
        PredFacts {
            status: str_field("status").unwrap_or_default(),
            is_qa_gate: js_truthy(get("isQaGate")),
            verdict: str_field("verdict"),
            verdict_checked: js_truthy(get("verdictChecked")),
            control_outcome: str_field("controlOutcome"),
            dispatch_ready: match get("dispatchReady") {
                Some(Value::Bool(b)) => Some(*b),
                Some(_) => Some(true),
                None => None,
            },
            failure_recovery_channel: str_field("failureRecoveryChannel"),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "skipped")
    }
}

/// 단일 edge 의 when 이 (terminal) 선행 facts 에 대해 성립하는지. non-terminal 이면 방어적으로 false.
fn edge_holds(when: Option<&When>, pred: &PredFacts) -> bool {
    if !pred.is_terminal() {
        return false;
    }
    match when.cloned().unwrap_or(When::Success) {
        When::Success => pred.status == "completed",
        When::Failure => pred.status == "failed" || pred.status == "skipped",
        When::Always => true,
        When::QaRequestChanges => {
            if pred.verdict.as_deref() == Some("request_changes") {
                return true;
            }
            if pred.verdict.as_deref() == Some("pass") {
                return false;
            }
            if pred.verdict_checked {
                return false;
            }
            pred.is_qa_gate && pred.status == "failed"
        }
        When::ConditionTrue => {
            pred.status == "completed" && pred.control_outcome.as_deref() == Some("condition_true")
        }
        When::ConditionFalse => {
            pred.status == "completed" && pred.control_outcome.as_deref() == Some("condition_false")
        }
        When::Other(_) => false,
    }
}

/// 대상 step 활성화 3분류(runnable/skippable/waiting).
#[derive(Debug, PartialEq, Serialize)]
pub struct StepActivation {
    pub runnable: bool,
    pub skippable: bool,
    pub waiting: bool,
}

fn activation(runnable: bool, skippable: bool, waiting: bool) -> StepActivation {
    StepActivation {
        runnable,
        skippable,
        waiting,
    }
}

/// back-edge 는 forward 활성화 게이트가 아니다(오직 loop-driver 가 발화). hard-required(success)
/// 선행이 terminal 인데 completed 가 아니면 전체 runnable 거부. 대기 불가(all terminal && !runnable)=skippable.
pub fn classify_step_activation(
    step: &EdgeBearingStep,
    preds_by_step_id: &HashMap<String, PredFacts>,
) -> StepActivation {
    let edges: Vec<ConditionalEdge> = resolve_edges(step)
        .into_iter()
        .filter(|e| !e.is_back_edge)
        .collect();
    if edges.is_empty() {
        return activation(true, false, false);
    }
    let mut waiting = false;
    let mut satisfied = false;
    let mut hard_required_failed = false;
    for edge in edges {
        let Some(pred) = preds_by_step_id.get(&edge.step_id) else {
            waiting = true;
            continue;
        };
        if !pred.is_terminal() {
            waiting = true;
            continue;
        }
        // [B2 좁은 회복 채널] dispatch_ready=false 대기는 failed 선행 + closed 채널에서만 즉시 하드 실패.
        if pred.dispatch_ready == Some(false)
            && (pred.status != "failed"
                || pred.failure_recovery_channel.as_deref() != Some("closed"))
        {
            waiting = true;
            continue;
        }
        if edge_holds(edge.when.as_ref(), pred) {
            satisfied = true;
        } else if matches!(edge.when, None | Some(When::Success)) {
            hard_required_failed = true;
        }
    }
    if waiting {
        return activation(false, false, true);
    }
    let runnable = satisfied && !hard_required_failed;
    activation(runnable, !runnable, false)
}

/// skip-propagation 이 한 번에 마감할 step 들(launched 제한 있는 경우 그 안에서만).
pub fn find_skippable_steps(
    steps: &[EdgeBearingStep],
    preds_by_step_id: &HashMap<String, PredFacts>,
    launched_step_ids: Option<&HashSet<String>>,
) -> Vec<String> {
    steps
        .iter()
        .filter(|step| launched_step_ids.is_none_or(|launched| launched.contains(&step.id)))
        .filter(|step| classify_step_activation(step, preds_by_step_id).skippable)
        .map(|step| step.id.clone())
        .collect()
}

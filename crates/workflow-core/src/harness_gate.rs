//! [파일 목적] dgate 실행 하네스 원시 요소의 Paperwork 포트(Stage S22-1). 확률 게이트 라우팅,
//!   온디맨드 자문 3관문(G1·G2·G3) 체크포인트 계약, 검증 결과 역귀속(backprop) — 순수 함수만
//!   제공한다(DB·시계·난수 미사용 → 같은 입력은 같은 출력).
//! [dgate 대응] engine.rs §4.2~§4.4: EWMA γ=0.92·가상 표본 M0=6·measured n≥5·연속 오류 2회 강제,
//!   θ_sharp 기본 0.70, verifier fail 페널티 w=2.0·rework/stall w=1.0·환경류 원인 격리.
//!   차이: dgate 는 강제 split+escalate_carbon 플래그로 내보내지만 여기선 `EscalateAdvisor`
//!   (G2 자문 관문)로 승격한다. 자문 판정은 자연어 마커가 아니라 스키마 검증 JSON 만 받는다.
//! [구조] 본 파일=라우팅+자문 관문, attribution.rs=역귀속, cli.rs=stdin 핸들러, tests.rs.
//! [외부 연결] consumer: dispatch.rs CLI(evaluate-dispatch-route/advisor-required-gate/
//!   advisor-checkpoint/apply-step-attribution). lib 공개 — 다른 crate 재사용 가능.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 검증 결과 → EWMA 사전 역귀속(300줄 상한 분리).
pub mod attribution;
/// stdin JSON 핸들러 — dispatch.rs 가 매칭한다.
pub mod cli;

#[cfg(test)]
mod tests;

pub use attribution::{
    apply_step_attribution, AttributionKind, AttributionUpdate, Posterior, StepVerdictAttribution,
    SuccessRatePrior,
};

/// EWMA 감쇠율 (유효 윈도우 ≈12.5건, 반감기 ≈8.3건)
pub const GAMMA: f64 = 0.92;
/// 가상 사전표본 크기
pub const M0: f64 = 6.0;
/// `raw_samples >= N_MIN` → measured 표지
pub const N_MIN: u64 = 5;
/// sharp 패스트패스 확신 기준 (동적 임계치 미지정 시)
pub const DEFAULT_SHARP_THRESHOLD: f64 = 0.70;
/// 연속 오류 강제 승격 임계
pub const FORCED_SPLIT_ERRORS: u32 = 2;
/// verifier fail 역귀속 가중(실패 1건보다 무겁게)
pub const VERDICT_FAIL_PENALTY: f64 = 2.0;
/// 자문 체크포인트 문서 스키마 버전
pub const ADVISOR_CHECKPOINT_SCHEMA_VERSION: u64 = 1;

// ── 1. 확률 게이트 라우팅 ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

impl RiskLevel {
    pub fn rank(self) -> u8 {
        match self {
            RiskLevel::Low => 0,
            RiskLevel::Medium => 1,
            RiskLevel::High => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchRoute {
    Sharp,
    Split,
    EscalateAdvisor,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRouteInput {
    /// 비용 인식 동적 임계치. None·비유한·(0,1] 밖이면 기본값으로 폴백.
    pub sharp_threshold: Option<f64>,
    /// Beta 사후평균(또는 사전 p0). 비유한·[0,1] 밖이면 sharp 불가(fail-closed).
    pub success_probability: f64,
    pub risk_level: RiskLevel,
    pub consecutive_errors: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRouteDecision {
    pub route: DispatchRoute,
    pub sharp_threshold: f64,
    pub forced_reason: Option<&'static str>,
}

/// dgate `evaluate_route` 포트 — 연속 오류 ≥2 는 p 와 무관하게 `EscalateAdvisor`(G2 관문),
///   아니면 `risk == Low && p >= θ` → Sharp, 그 외 Split.
pub fn evaluate_dispatch_route(input: &DispatchRouteInput) -> DispatchRouteDecision {
    let theta = input
        .sharp_threshold
        .filter(|t| t.is_finite() && *t > 0.0 && *t <= 1.0)
        .unwrap_or(DEFAULT_SHARP_THRESHOLD);
    let forced_reason =
        (input.consecutive_errors >= FORCED_SPLIT_ERRORS).then_some("consecutive_errors>=2");
    let p_ok =
        input.success_probability.is_finite() && (0.0..=1.0).contains(&input.success_probability);
    let route = if forced_reason.is_some() {
        DispatchRoute::EscalateAdvisor
    } else if input.risk_level == RiskLevel::Low && p_ok && input.success_probability >= theta {
        DispatchRoute::Sharp
    } else {
        DispatchRoute::Split
    };
    DispatchRouteDecision {
        route,
        sharp_threshold: theta,
        forced_reason,
    }
}

// ── 2. 자문 3관문 ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorGate {
    G1PrePlan,
    G2SecondError,
    G3PreCloseout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum AdvisorVerdict {
    Pass,
    Challenge { reason: String },
}

impl AdvisorVerdict {
    /// 공백 reason 은 `unspecified` 로 정규화 — 근거 없는 반려를 남기지 않는다.
    pub fn challenge(reason: impl Into<String>) -> Self {
        let reason = reason.into().trim().to_string();
        AdvisorVerdict::Challenge {
            reason: if reason.is_empty() {
                "unspecified".to_string()
            } else {
                reason
            },
        }
    }
    pub fn allows_progress(&self) -> bool {
        matches!(self, AdvisorVerdict::Pass)
    }
    /// fail-closed 구조 분석 — `{decision:"pass"}` 또는 `{decision:"challenge",reason}` 만 통과.
    pub fn parse(v: &Value) -> Result<Self, String> {
        if v.get("decision").and_then(Value::as_str) == Some("pass") {
            return Ok(AdvisorVerdict::Pass);
        }
        match (v.get("decision").and_then(Value::as_str), v.get("reason")) {
            (Some("challenge"), Some(Value::String(r))) => Ok(Self::challenge(r.clone())),
            _ => Err("invalid_advisor_verdict".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorTriggerInput {
    pub plan_pending_approval: bool,
    pub consecutive_errors: u32,
    pub verifier_passed: bool,
}

/// 결정론 트리거 — 급성 회귀(G2) > 계획 검토(G1) > 머지 전(G3). 해당 없음 None.
pub fn required_advisor_gate(input: &AdvisorTriggerInput) -> Option<AdvisorGate> {
    if input.consecutive_errors >= FORCED_SPLIT_ERRORS {
        Some(AdvisorGate::G2SecondError)
    } else if input.plan_pending_approval {
        Some(AdvisorGate::G1PrePlan)
    } else if input.verifier_passed {
        Some(AdvisorGate::G3PreCloseout)
    } else {
        None
    }
}

/// 자문 체크포인트 계약 — run 귀속·관문·판정을 한 문서로 고정한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorCheckpoint {
    pub schema_version: u64,
    pub run_id: String,
    pub gate: AdvisorGate,
    pub verdict: AdvisorVerdict,
}

impl AdvisorCheckpoint {
    /// 스키마 위반·빈 runId·unknown gate·불일치 키는 전부 Err(fail-closed).
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let obj = v.as_object().ok_or_else(|| "not_an_object".to_string())?;
        let known = ["schemaVersion", "runId", "gate", "decision", "reason"];
        if !obj.keys().all(|k| known.contains(&k.as_str())) {
            return Err("unrecognized_key".to_string());
        }
        let version = v.get("schemaVersion").and_then(Value::as_u64);
        if version != Some(ADVISOR_CHECKPOINT_SCHEMA_VERSION) {
            return Err("unsupported_schema_version".to_string());
        }
        let run_id = v
            .get("runId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing_run_id".to_string())?;
        let gate: AdvisorGate = v
            .get("gate")
            .map(|g| serde_json::from_value(g.clone()).map_err(|_| "unknown_gate".to_string()))
            .transpose()?
            .ok_or_else(|| "unknown_gate".to_string())?;
        let verdict = AdvisorVerdict::parse(v)?;
        Ok(AdvisorCheckpoint {
            schema_version: ADVISOR_CHECKPOINT_SCHEMA_VERSION,
            run_id: run_id.to_string(),
            gate,
            verdict,
        })
    }
}

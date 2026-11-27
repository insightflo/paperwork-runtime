//! [파일 목적] 검증 결과 역귀속(backprop attribution) — StepVerdictAttribution 을 EWMA Beta
//!   사전(success-rate prior)에 결정론으로 반영한다. 300줄 상한 때문에 harness_gate 에서 분리.
//! [dgate 대응] engine.rs 표본 기록: γ 감쇠, verifier fail w=2.0, rework/stall w=1.0,
//!   config_error/interrupted/rerouted 는 EWMA·카운터 격리(감시 로그만 해당).
//! [외부 연결] consumer: harness_gate/cli.rs(apply-step-attribution), tests.rs.

use super::{GAMMA, M0, N_MIN, VERDICT_FAIL_PENALTY};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepVerdictAttribution {
    pub run_id: String,
    pub step_run_id: String,
    /// ok | fail | rework | config_error | interrupted | rerouted | skipped
    pub outcome: String,
    /// None = verifier 미개입, Some(false) = verifier 반려
    pub verdict_pass: Option<bool>,
    pub stall_detected: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionKind {
    Success,
    Failed,
    Rework,
    Stalled,
    Isolated,
    Unrecognized,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessRatePrior {
    pub ewma_success: f64,
    pub ewma_fail: f64,
    pub raw_samples: u64,
    pub consecutive_errors: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Posterior {
    pub p: f64,
    pub measured: bool,
    pub samples: u64,
}

impl SuccessRatePrior {
    /// dgate `get_posterior` 의 국소 성분 — `(M0·p0 + s) / (M0 + s + f)`.
    pub fn posterior(&self, p0: f64) -> Posterior {
        let alpha = M0 * p0;
        let p = (alpha + self.ewma_success) / (M0 + self.ewma_success + self.ewma_fail);
        Posterior {
            p,
            measured: self.raw_samples >= N_MIN,
            samples: self.raw_samples,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionUpdate {
    pub run_id: String,
    pub step_run_id: String,
    pub kind: AttributionKind,
    /// false 면 prior 불변(격리·미인식·귀속 누락) — 호출자는 bounded retry/재배차 경로로.
    pub recorded: bool,
    pub weight: f64,
    pub prior: SuccessRatePrior,
}

/// dgate 표본 기록 포트 — stall > verifier 반려(w=2) > outcome 문자열. 환경류 원인은 격리.
pub fn apply_step_attribution(
    prior: &SuccessRatePrior,
    attr: &StepVerdictAttribution,
) -> AttributionUpdate {
    let mut out = AttributionUpdate {
        run_id: attr.run_id.clone(),
        step_run_id: attr.step_run_id.clone(),
        kind: AttributionKind::Unrecognized,
        recorded: false,
        weight: 0.0,
        prior: *prior,
    };
    let bound = !attr.run_id.trim().is_empty() && !attr.step_run_id.trim().is_empty();
    let kind = if attr.stall_detected {
        Some(AttributionKind::Stalled)
    } else {
        match (
            attr.outcome.trim().to_ascii_lowercase().as_str(),
            attr.verdict_pass,
        ) {
            ("ok" | "completed" | "success", Some(false)) => Some(AttributionKind::Failed),
            ("ok" | "completed" | "success", _) => Some(AttributionKind::Success),
            ("fail" | "failed" | "error", _) => Some(AttributionKind::Failed),
            ("rework", _) => Some(AttributionKind::Rework),
            ("config_error" | "interrupted" | "rerouted" | "skipped", _) => {
                Some(AttributionKind::Isolated)
            }
            _ => None,
        }
    };
    let Some(kind) = kind else {
        return out;
    };
    out.kind = kind;
    if !bound || kind == AttributionKind::Isolated {
        return out;
    }
    let ok = kind == AttributionKind::Success;
    out.weight = match kind {
        AttributionKind::Failed if attr.verdict_pass == Some(false) => VERDICT_FAIL_PENALTY,
        AttributionKind::Failed => 1.0,
        AttributionKind::Success => 1.0,
        _ => 1.0,
    };
    out.prior.ewma_success = prior.ewma_success * GAMMA + if ok { out.weight } else { 0.0 };
    out.prior.ewma_fail = prior.ewma_fail * GAMMA + if ok { 0.0 } else { out.weight };
    out.prior.raw_samples = prior.raw_samples.saturating_add(1);
    out.prior.consecutive_errors = if ok {
        0
    } else {
        prior.consecutive_errors.saturating_add(1)
    };
    out.recorded = true;
    out
}

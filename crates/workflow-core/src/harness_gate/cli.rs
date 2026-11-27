//! [파일 목적] harness_gate CLI 핸들러 — stdin JSON → Value. dispatch.rs 가 서브커맨드를 매칭한다.
//! [외부 연결] consumer: dispatch.rs. 상수·타입은 harness_gate·attribution 공개 항목만 쓴다.

use super::attribution::{apply_step_attribution, StepVerdictAttribution, SuccessRatePrior};
use super::{
    evaluate_dispatch_route, required_advisor_gate, AdvisorCheckpoint, AdvisorTriggerInput,
    DispatchRouteInput,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn evaluate_dispatch_route_cli(raw: &[u8]) -> Result<Value, String> {
    let input: DispatchRouteInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    serde_json::to_value(evaluate_dispatch_route(&input)).map_err(|e| e.to_string())
}

pub fn advisor_required_gate_cli(raw: &[u8]) -> Result<Value, String> {
    let input: AdvisorTriggerInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(json!({ "gate": required_advisor_gate(&input) }))
}

/// fail-closed: 무효 문서도 Err 이 아니라 `valid:false, allowsProgress:false` 로 응답해
///   호출자가 절대 pass 로 해석하지 못하게 한다.
pub fn advisor_checkpoint_cli(raw: &[u8]) -> Result<Value, String> {
    let doc: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    Ok(match AdvisorCheckpoint::from_value(&doc) {
        Ok(cp) => {
            json!({ "valid": true, "allowsProgress": cp.verdict.allows_progress(), "checkpoint": cp })
        }
        Err(e) => json!({ "valid": false, "allowsProgress": false, "error": e }),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyAttributionInput {
    prior: SuccessRatePrior,
    attribution: StepVerdictAttribution,
}

pub fn apply_step_attribution_cli(raw: &[u8]) -> Result<Value, String> {
    let input: ApplyAttributionInput = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    serde_json::to_value(apply_step_attribution(&input.prior, &input.attribution))
        .map_err(|e| e.to_string())
}

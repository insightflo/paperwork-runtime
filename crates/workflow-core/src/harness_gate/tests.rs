//! harness_gate 단위 테스트 — 라우팅·자문 관문·역귀속·CLI 핸들러. 기대값은 harness_gate 공개 상수
//!   (GAMMA=0.92, M0=6, N_MIN=5, θ=0.70, VERDICT_FAIL_PENALTY=2.0)에서 손계산한 값이다.

use super::attribution::{apply_step_attribution, SuccessRatePrior};
use super::cli::{
    advisor_checkpoint_cli, advisor_required_gate_cli, apply_step_attribution_cli,
    evaluate_dispatch_route_cli,
};
use super::*;

mod advisor;
mod attribution;

fn route(p: f64, risk: RiskLevel, errors: u32) -> DispatchRouteDecision {
    evaluate_dispatch_route(&DispatchRouteInput {
        sharp_threshold: None,
        success_probability: p,
        risk_level: risk,
        consecutive_errors: errors,
    })
}

fn attr(outcome: &str, verdict_pass: Option<bool>) -> StepVerdictAttribution {
    StepVerdictAttribution {
        run_id: "run-1".into(),
        step_run_id: "step-1".into(),
        outcome: outcome.into(),
        verdict_pass,
        stall_detected: false,
        duration_ms: 1_234,
    }
}

fn prior(s: f64, f: f64, n: u64, err: u32) -> SuccessRatePrior {
    SuccessRatePrior {
        ewma_success: s,
        ewma_fail: f,
        raw_samples: n,
        consecutive_errors: err,
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-12
}

// ── 1. 확률 게이트 라우팅 ──

#[test]
fn route_sharp_only_when_low_risk_and_p_at_or_above_threshold() {
    let d = route(0.94, RiskLevel::Low, 0);
    assert_eq!(d.route, DispatchRoute::Sharp);
    assert_eq!(d.sharp_threshold, 0.70);
    assert_eq!(d.forced_reason, None);
    // 경계: p == θ 는 sharp(비교는 `p >= θ` — 경계 포함), 바로 아래는 split.
    assert_eq!(route(0.70, RiskLevel::Low, 0).route, DispatchRoute::Sharp);
    assert_eq!(route(0.6999, RiskLevel::Low, 0).route, DispatchRoute::Split);
}

#[test]
fn route_split_for_elevated_risk_or_low_probability() {
    for risk in [RiskLevel::Medium, RiskLevel::High] {
        assert_eq!(route(1.0, risk, 0).route, DispatchRoute::Split, "{risk:?}");
    }
    assert_eq!(route(0.5, RiskLevel::Low, 0).route, DispatchRoute::Split);
    assert_eq!(route(0.0, RiskLevel::Low, 0).route, DispatchRoute::Split);
    // 연속 오류 1회는 강제 아님 — 확률로 판정.
    assert_eq!(route(0.9, RiskLevel::Low, 1).route, DispatchRoute::Sharp);
}

#[test]
fn route_escalates_advisor_on_second_consecutive_error_regardless_of_probability() {
    for (p, risk) in [(1.0, RiskLevel::Low), (0.0, RiskLevel::High)] {
        let d = route(p, risk, 2);
        assert_eq!(d.route, DispatchRoute::EscalateAdvisor);
        assert_eq!(d.forced_reason, Some("consecutive_errors>=2"));
    }
    assert_eq!(
        route(1.0, RiskLevel::Low, 3).route,
        DispatchRoute::EscalateAdvisor
    );
}

#[test]
fn route_honors_dynamic_threshold_and_falls_back_on_invalid_values() {
    let with = |t: f64| {
        evaluate_dispatch_route(&DispatchRouteInput {
            sharp_threshold: Some(t),
            success_probability: 0.94,
            risk_level: RiskLevel::Low,
            consecutive_errors: 0,
        })
    };
    let d = with(0.95);
    assert_eq!((d.route, d.sharp_threshold), (DispatchRoute::Split, 0.95));
    assert_eq!(with(0.5).route, DispatchRoute::Sharp);
    for bad in [f64::NAN, f64::INFINITY, 0.0, -0.1, 1.5] {
        let d = with(bad);
        assert_eq!(
            (d.route, d.sharp_threshold),
            (DispatchRoute::Sharp, 0.70),
            "{bad}"
        );
    }
}

#[test]
fn route_fail_closed_on_invalid_probability() {
    for p in [f64::NAN, f64::INFINITY, -0.01, 1.01] {
        let d = route(p, RiskLevel::Low, 0);
        assert_eq!(d.route, DispatchRoute::Split, "{p}");
        assert_eq!(d.forced_reason, None);
        // 강제 승격은 확률 불량보다 우선한다.
        assert_eq!(
            route(p, RiskLevel::Low, 2).route,
            DispatchRoute::EscalateAdvisor
        );
    }
}

#[test]
fn route_is_deterministic_and_serializes_snake_case() {
    let input = DispatchRouteInput {
        sharp_threshold: Some(0.7),
        success_probability: 0.9,
        risk_level: RiskLevel::Low,
        consecutive_errors: 0,
    };
    assert_eq!(
        evaluate_dispatch_route(&input),
        evaluate_dispatch_route(&input)
    );
    assert_eq!(
        serde_json::to_value(DispatchRoute::EscalateAdvisor).unwrap(),
        serde_json::json!("escalate_advisor")
    );
    assert_eq!(
        serde_json::to_value(route(0.9, RiskLevel::Low, 2)).unwrap(),
        serde_json::json!({"route":"escalate_advisor","sharpThreshold":0.7,"forcedReason":"consecutive_errors>=2"})
    );
}

#[test]
fn risk_level_parses_lowercase_and_ranks_monotonically() {
    for (s, r) in [
        ("low", RiskLevel::Low),
        ("medium", RiskLevel::Medium),
        ("high", RiskLevel::High),
    ] {
        assert_eq!(
            serde_json::from_value::<RiskLevel>(Value::String(s.into())).unwrap(),
            r
        );
    }
    assert!(serde_json::from_value::<RiskLevel>(Value::String("LOW".into())).is_err());
    assert!(serde_json::from_value::<RiskLevel>(Value::String("critical".into())).is_err());
    assert!(
        RiskLevel::Low.rank() < RiskLevel::Medium.rank()
            && RiskLevel::Medium.rank() < RiskLevel::High.rank()
    );
}

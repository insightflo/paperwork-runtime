//! 검증 역귀속(EWMA 사전 갱신)·사후확률·CLI 핸들러 테스트 — tests.rs 의 헬퍼를 공유한다.

use super::*;

// ── 3. 검증 역귀속 ──

#[test]
fn attribution_success_resets_consecutive_errors_and_decays_ewma() {
    let u = apply_step_attribution(&prior(1.0, 1.0, 3, 1), &attr("ok", None));
    assert_eq!(u.kind, AttributionKind::Success);
    assert!(u.recorded);
    assert_eq!(u.weight, 1.0);
    assert!(close(u.prior.ewma_success, 1.0 * GAMMA + 1.0));
    assert!(close(u.prior.ewma_fail, 1.0 * GAMMA));
    assert_eq!((u.prior.raw_samples, u.prior.consecutive_errors), (4, 0));
    assert_eq!(
        (u.run_id.as_str(), u.step_run_id.as_str()),
        ("run-1", "step-1")
    );
    // verifier 통과도 동일 가중.
    let u2 = apply_step_attribution(&prior(1.0, 1.0, 3, 0), &attr("completed", Some(true)));
    assert_eq!((u2.kind, u2.weight), (AttributionKind::Success, 1.0));
    // 대소문자·공백 관대.
    assert_eq!(
        apply_step_attribution(&prior(0.0, 0.0, 0, 0), &attr(" OK ", None)).kind,
        AttributionKind::Success
    );
}

#[test]
fn attribution_verifier_rejection_applies_double_penalty() {
    let u = apply_step_attribution(&prior(2.0, 1.0, 4, 0), &attr("ok", Some(false)));
    assert_eq!(u.kind, AttributionKind::Failed);
    assert_eq!(u.weight, VERDICT_FAIL_PENALTY);
    assert!(close(u.prior.ewma_success, 2.0 * GAMMA));
    assert!(close(u.prior.ewma_fail, 1.0 * GAMMA + 2.0));
    assert_eq!(u.prior.consecutive_errors, 1);
    // 명시 실패 + verifier 반려도 2.0, verifier 미개입 실패는 1.0.
    assert_eq!(
        apply_step_attribution(&prior(0.0, 0.0, 0, 0), &attr("fail", Some(false))).weight,
        2.0
    );
    let u1 = apply_step_attribution(&prior(0.0, 0.0, 0, 0), &attr("fail", None));
    assert_eq!((u1.kind, u1.weight), (AttributionKind::Failed, 1.0));
    assert_eq!(
        apply_step_attribution(&prior(0.0, 0.0, 0, 0), &attr("error", Some(true))).weight,
        1.0,
        "outcome 이 우선"
    );
}

#[test]
fn attribution_rework_and_stall_count_as_single_failures() {
    let u = apply_step_attribution(&prior(1.0, 0.0, 1, 1), &attr("rework", None));
    assert_eq!(
        (u.kind, u.weight, u.prior.consecutive_errors),
        (AttributionKind::Rework, 1.0, 2)
    );
    // stall 은 outcome 보다 우선 — ok 를 내도 실패 표본(가중 w=1.0, 연속 오류 +1).
    let mut stalled = attr("ok", Some(true));
    stalled.stall_detected = true;
    let s = apply_step_attribution(&prior(1.0, 0.0, 1, 0), &stalled);
    assert_eq!(
        (s.kind, s.weight, s.recorded),
        (AttributionKind::Stalled, 1.0, true)
    );
    assert!(close(s.prior.ewma_fail, 1.0));
    assert_eq!(s.prior.consecutive_errors, 1);
}

#[test]
fn attribution_isolates_environmental_and_unrecognized_outcomes() {
    let before = prior(1.0, 1.0, 3, 2);
    for outcome in ["config_error", "interrupted", "rerouted", "skipped"] {
        let u = apply_step_attribution(&before, &attr(outcome, Some(false)));
        assert_eq!(u.kind, AttributionKind::Isolated, "{outcome}");
        assert!(!u.recorded);
        assert_eq!(u.weight, 0.0);
        assert_eq!(u.prior, before, "{outcome}: EWMA·카운터 불변");
    }
    let u = apply_step_attribution(&before, &attr("weird", None));
    assert_eq!((u.kind, u.recorded), (AttributionKind::Unrecognized, false));
    assert_eq!(u.prior, before);
}

#[test]
fn attribution_without_run_or_step_binding_is_not_recorded() {
    for (run, step) in [("", "s"), ("   ", "s"), ("r", ""), ("r", " ")] {
        let mut a = attr("fail", None);
        a.run_id = run.into();
        a.step_run_id = step.into();
        let u = apply_step_attribution(&prior(1.0, 1.0, 1, 0), &a);
        assert!(!u.recorded, "{run:?}/{step:?}");
        assert_eq!(u.prior, prior(1.0, 1.0, 1, 0));
    }
}

#[test]
fn attribution_sequence_matches_manual_ewma_and_is_deterministic() {
    let start = prior(0.0, 0.0, 0, 0);
    let mut p = start;
    for (outcome, v) in [
        ("ok", None),
        ("ok", None),
        ("fail", None),
        ("ok", Some(false)),
    ] {
        p = apply_step_attribution(&p, &attr(outcome, v)).prior;
    }
    // ok: s=1,f=0 → ok: s=γ+1,f=0 → fail(w=1): s=γ²+γ,f=1 → verifier 반려(w=2): s=γ³+γ², f=γ+2
    assert!(
        close(p.ewma_success, GAMMA.powi(2) + GAMMA.powi(3)),
        "{}",
        p.ewma_success
    );
    assert!(close(p.ewma_fail, GAMMA + 2.0), "{}", p.ewma_fail);
    assert_eq!((p.raw_samples, p.consecutive_errors), (4, 2));
    let q = apply_step_attribution(&start, &attr("ok", None));
    assert_eq!(
        apply_step_attribution(&start, &attr("ok", None)),
        q,
        "같은 입력 → 같은 출력"
    );
}

#[test]
fn attribution_saturates_counters() {
    let u = apply_step_attribution(&prior(0.0, 0.0, u64::MAX, u32::MAX), &attr("fail", None));
    assert_eq!(u.prior.raw_samples, u64::MAX);
    assert_eq!(u.prior.consecutive_errors, u32::MAX);
}

#[test]
fn posterior_uses_beta_mean_with_prior_mass_and_switches_to_measured() {
    let empty = SuccessRatePrior::default();
    let post = empty.posterior(0.88);
    assert!(close(post.p, 0.88));
    assert_eq!((post.measured, post.samples), (false, 0));
    // (M0·p0 + s) / (M0 + s + f) = (6·0.88 + 2) / (6 + 2 + 1)
    let post = prior(2.0, 1.0, 5, 0).posterior(0.88);
    assert!(close(post.p, (6.0 * 0.88 + 2.0) / 9.0));
    assert!(post.measured, "n=5 ≥ N_MIN");
    assert!(!prior(2.0, 1.0, 4, 0).posterior(0.88).measured);
    // 표본이 쌓이면 사전 p0 의 영향은 감소한다: p = (n/(M0+n))·x̄ + (M0/(M0+n))·p0, x̄=0.9
    let heavy = prior(90.0, 10.0, 100, 0);
    assert!(close(heavy.posterior(0.88).p, (6.0 * 0.88 + 90.0) / 106.0));
    assert!(close(heavy.posterior(0.1).p, (6.0 * 0.1 + 90.0) / 106.0));
    assert!(heavy.posterior(0.1).p > 0.85 && heavy.posterior(0.1).p < 0.9);
}

#[test]
fn attribution_types_serde_round_trip_camel_case() {
    let p = prior(1.5, 0.25, 7, 2);
    let v = serde_json::to_value(p).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"ewmaSuccess":1.5,"ewmaFail":0.25,"rawSamples":7,"consecutiveErrors":2})
    );
    assert_eq!(serde_json::from_value::<SuccessRatePrior>(v).unwrap(), p);
    let u = apply_step_attribution(&p, &attr("ok", Some(false)));
    let uv = serde_json::to_value(&u).unwrap();
    assert_eq!(uv["kind"], serde_json::json!("failed"));
    assert_eq!(uv["weight"], serde_json::json!(2.0));
    assert_eq!(uv["recorded"], serde_json::json!(true));
    assert_eq!(uv["stepRunId"], serde_json::json!("step-1"));
    assert_eq!(
        serde_json::to_value(AttributionKind::Stalled).unwrap(),
        serde_json::json!("stalled")
    );
    // 결측 필드는 serde 실패(fail-closed) — 기본값으로 추정하지 않는다.
    assert!(serde_json::from_value::<StepVerdictAttribution>(
        serde_json::json!({"runId":"r","stepRunId":"s","outcome":"ok"})
    )
    .is_err());
}

// ── CLI 핸들러 ──

#[test]
fn cli_handlers_map_stdin_json_to_responses() {
    let r = evaluate_dispatch_route_cli(br#"{"sharpThreshold":null,"successProbability":0.94,"riskLevel":"low","consecutiveErrors":0}"#).unwrap();
    assert_eq!(
        r,
        serde_json::json!({"route":"sharp","sharpThreshold":0.7,"forcedReason":null})
    );
    let r = evaluate_dispatch_route_cli(
        br#"{"successProbability":1,"riskLevel":"high","consecutiveErrors":2}"#,
    )
    .unwrap();
    assert_eq!(r["route"], serde_json::json!("escalate_advisor"));
    assert!(evaluate_dispatch_route_cli(br#"{"successProbability":"high"}"#).is_err());
    assert!(evaluate_dispatch_route_cli(
        br#"{"successProbability":0.9,"riskLevel":"low","consecutiveErrors":-1}"#
    )
    .is_err());

    let g = advisor_required_gate_cli(
        br#"{"planPendingApproval":false,"consecutiveErrors":2,"verifierPassed":true}"#,
    )
    .unwrap();
    assert_eq!(g, serde_json::json!({"gate":"g2_second_error"}));
    assert_eq!(
        advisor_required_gate_cli(
            br#"{"planPendingApproval":false,"consecutiveErrors":0,"verifierPassed":false}"#
        )
        .unwrap(),
        serde_json::json!({"gate":null})
    );

    let a = apply_step_attribution_cli(br#"{"prior":{"ewmaSuccess":1,"ewmaFail":1,"rawSamples":3,"consecutiveErrors":1},"attribution":{"runId":"r","stepRunId":"s","outcome":"ok","verdictPass":false,"stallDetected":false,"durationMs":10}}"#).unwrap();
    assert_eq!(a["kind"], serde_json::json!("failed"));
    assert_eq!(a["prior"]["consecutiveErrors"], serde_json::json!(2));
    assert_eq!(a["prior"]["ewmaFail"], serde_json::json!(1.0 * GAMMA + 2.0));
    assert!(apply_step_attribution_cli(br#"{"prior":{},"attribution":{}}"#).is_err());
}

#[test]
fn cli_checkpoint_is_fail_closed_on_invalid_documents() {
    let ok = advisor_checkpoint_cli(
        br#"{"schemaVersion":1,"runId":"r","gate":"g1_pre_plan","decision":"pass"}"#,
    )
    .unwrap();
    assert_eq!(ok["valid"], serde_json::json!(true));
    assert_eq!(ok["allowsProgress"], serde_json::json!(true));
    assert_eq!(ok["checkpoint"]["gate"], serde_json::json!("g1_pre_plan"));
    let ch = advisor_checkpoint_cli(br#"{"schemaVersion":1,"runId":"r","gate":"g3_pre_closeout","decision":"challenge","reason":"P1"}"#).unwrap();
    assert_eq!(
        (ch["valid"].clone(), ch["allowsProgress"].clone()),
        (serde_json::json!(true), serde_json::json!(false))
    );
    let bad = advisor_checkpoint_cli(
        br#"{"schemaVersion":1,"runId":"r","gate":"g3_pre_closeout","decision":"human"}"#,
    )
    .unwrap();
    assert_eq!(bad["valid"], serde_json::json!(false));
    assert_eq!(bad["allowsProgress"], serde_json::json!(false));
    assert_eq!(bad["error"], serde_json::json!("invalid_advisor_verdict"));
    assert!(advisor_checkpoint_cli(b"not json").is_err());
}

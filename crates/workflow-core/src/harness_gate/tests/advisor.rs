//! 자문 3관문(G1·G2·G3) 트리거·판정·체크포인트 계약 테스트 — tests.rs 의 헬퍼를 공유한다.

use super::*;

// ── 2. 자문 3관문 ──

fn trigger(plan: bool, errors: u32, verifier: bool) -> Option<AdvisorGate> {
    required_advisor_gate(&AdvisorTriggerInput {
        plan_pending_approval: plan,
        consecutive_errors: errors,
        verifier_passed: verifier,
    })
}

#[test]
fn advisor_gate_triggers_each_gate_and_none() {
    assert_eq!(trigger(false, 0, false), None);
    assert_eq!(trigger(true, 0, false), Some(AdvisorGate::G1PrePlan));
    assert_eq!(trigger(false, 2, false), Some(AdvisorGate::G2SecondError));
    assert_eq!(trigger(false, 0, true), Some(AdvisorGate::G3PreCloseout));
    assert_eq!(trigger(false, 1, false), None, "오류 1회는 관문 아님");
}

#[test]
fn advisor_gate_precedence_is_g2_then_g1_then_g3() {
    assert_eq!(trigger(true, 2, true), Some(AdvisorGate::G2SecondError));
    assert_eq!(trigger(false, 2, true), Some(AdvisorGate::G2SecondError));
    assert_eq!(trigger(true, 0, true), Some(AdvisorGate::G1PrePlan));
    assert_eq!(trigger(true, 1, true), Some(AdvisorGate::G1PrePlan));
}

#[test]
fn advisor_gate_agrees_with_route_escalation() {
    // 라우팅 EscalateAdvisor ⇔ G2 트리거 — 두 판정이 같은 사실(연속 오류 ≥2)을 본다.
    for errors in [0, 1, 2, 5] {
        let escalated = route(1.0, RiskLevel::Low, errors).route == DispatchRoute::EscalateAdvisor;
        assert_eq!(
            trigger(false, errors, false) == Some(AdvisorGate::G2SecondError),
            escalated
        );
    }
}

#[test]
fn advisor_gate_serializes_snake_case_and_rejects_unknown() {
    for (g, s) in [
        (AdvisorGate::G1PrePlan, "g1_pre_plan"),
        (AdvisorGate::G2SecondError, "g2_second_error"),
        (AdvisorGate::G3PreCloseout, "g3_pre_closeout"),
    ] {
        assert_eq!(serde_json::to_value(g).unwrap(), Value::String(s.into()));
        assert_eq!(
            serde_json::from_value::<AdvisorGate>(Value::String(s.into())).unwrap(),
            g
        );
    }
    assert!(serde_json::from_value::<AdvisorGate>(Value::String("g4".into())).is_err());
}

#[test]
fn advisor_verdict_pass_allows_progress_challenge_does_not() {
    assert!(AdvisorVerdict::Pass.allows_progress());
    let c = AdvisorVerdict::challenge("  verifier found P0  ");
    assert_eq!(
        c,
        AdvisorVerdict::Challenge {
            reason: "verifier found P0".into()
        }
    );
    assert!(!c.allows_progress());
    // 공백 반려 사유는 정규화 — 근거 없는 반려를 남기지 않는다.
    assert_eq!(
        AdvisorVerdict::challenge("   "),
        AdvisorVerdict::Challenge {
            reason: "unspecified".into()
        }
    );
}

#[test]
fn advisor_verdict_parse_is_fail_closed() {
    assert_eq!(
        AdvisorVerdict::parse(&serde_json::json!({"decision":"pass"})),
        Ok(AdvisorVerdict::Pass)
    );
    assert_eq!(
        AdvisorVerdict::parse(&serde_json::json!({"decision":"challenge","reason":"bad"})),
        Ok(AdvisorVerdict::Challenge {
            reason: "bad".into()
        })
    );
    for bad in [
        serde_json::json!({"decision":"challenge"}),
        serde_json::json!({"decision":"challenge","reason":7}),
        serde_json::json!({"decision":"Challenge","reason":"x"}),
        serde_json::json!({"decision":"human"}),
        serde_json::json!({}),
        serde_json::json!("pass"),
        serde_json::json!(null),
        serde_json::json!("[advisor:pass]"),
    ] {
        assert!(AdvisorVerdict::parse(&bad).is_err(), "{bad}");
    }
}

#[test]
fn advisor_verdict_serde_is_tagged_round_trip() {
    assert_eq!(
        serde_json::to_value(AdvisorVerdict::Pass).unwrap(),
        serde_json::json!({"decision":"pass"})
    );
    let c = AdvisorVerdict::Challenge { reason: "r".into() };
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v, serde_json::json!({"decision":"challenge","reason":"r"}));
    assert_eq!(serde_json::from_value::<AdvisorVerdict>(v).unwrap(), c);
    assert!(serde_json::from_value::<AdvisorVerdict>(serde_json::json!({"decision":"x"})).is_err());
}

fn doc(gate: &str, decision: Value) -> Value {
    let mut d = serde_json::json!({"schemaVersion":1,"runId":" run-1 ","gate":gate});
    d.as_object_mut()
        .unwrap()
        .extend(decision.as_object().unwrap().clone());
    d
}

#[test]
fn advisor_checkpoint_accepts_valid_pass_and_challenge_documents() {
    let cp = AdvisorCheckpoint::from_value(&doc(
        "g3_pre_closeout",
        serde_json::json!({"decision":"pass"}),
    ))
    .unwrap();
    assert!(cp.verdict.allows_progress());
    assert_eq!(cp.run_id, "run-1", "runId 트림");
    assert_eq!(cp.gate, AdvisorGate::G3PreCloseout);
    assert_eq!(cp.schema_version, ADVISOR_CHECKPOINT_SCHEMA_VERSION);
    let cp2 = AdvisorCheckpoint::from_value(&doc(
        "g2_second_error",
        serde_json::json!({"decision":"challenge","reason":"P0"}),
    ))
    .unwrap();
    assert!(!cp2.verdict.allows_progress());
    assert_eq!(
        serde_json::to_value(&cp2).unwrap(),
        serde_json::json!({"schemaVersion":1,"runId":"run-1","gate":"g2_second_error","verdict":{"decision":"challenge","reason":"P0"}})
    );
}

#[test]
fn advisor_checkpoint_rejects_every_schema_violation() {
    let pass = || serde_json::json!({"decision":"pass"});
    let cases: Vec<(&str, Value)> = vec![
        ("not_an_object", serde_json::json!("x")),
        (
            "unsupported_schema_version",
            serde_json::json!({"runId":"r","gate":"g1_pre_plan","decision":"pass"}),
        ),
        (
            "unsupported_schema_version",
            serde_json::json!({"schemaVersion":2,"runId":"r","gate":"g1_pre_plan","decision":"pass"}),
        ),
        (
            "missing_run_id",
            serde_json::json!({"schemaVersion":1,"runId":"  ","gate":"g1_pre_plan","decision":"pass"}),
        ),
        (
            "unknown_gate",
            serde_json::json!({"schemaVersion":1,"runId":"r","gate":"g9","decision":"pass"}),
        ),
        (
            "unknown_gate",
            serde_json::json!({"schemaVersion":1,"runId":"r","decision":"pass"}),
        ),
        (
            "invalid_advisor_verdict",
            serde_json::json!({"schemaVersion":1,"runId":"r","gate":"g1_pre_plan","decision":"challenge"}),
        ),
        (
            "invalid_advisor_verdict",
            serde_json::json!({"schemaVersion":1,"runId":"r","gate":"g1_pre_plan"}),
        ),
        (
            "unrecognized_key",
            serde_json::json!({"schemaVersion":1,"runId":"r","gate":"g1_pre_plan","decision":"pass","extra":1}),
        ),
    ];
    for (want, v) in cases {
        assert_eq!(AdvisorCheckpoint::from_value(&v).unwrap_err(), want, "{v}");
    }
    assert_eq!(
        AdvisorCheckpoint::from_value(&doc("g1_pre_plan", pass()))
            .unwrap()
            .gate,
        AdvisorGate::G1PrePlan
    );
}

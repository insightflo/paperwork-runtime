use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionKind {
    RateLimit429,
    InfraSigterm,
    StaleQueued,
    QaRejection,
    ContentDefect,
    PermissionOrAuth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionRouteTarget {
    DeterministicBackoff,
    StructuredHuddle,
    HumanEscalation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExceptionRouteInput {
    pub kind: ExceptionKind,
    pub huddle_rounds_completed: u32,
    pub max_huddle_rounds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExceptionRouteDecision {
    pub target: ExceptionRouteTarget,
    pub spawn_unblock_issue: bool,
    pub reason: String,
}

pub fn route_step_exception(input: &ExceptionRouteInput) -> ExceptionRouteDecision {
    let max_rounds = if input.max_huddle_rounds == 0 {
        2
    } else {
        input.max_huddle_rounds
    };
    let (target, reason) = match input.kind {
        ExceptionKind::RateLimit429 | ExceptionKind::InfraSigterm | ExceptionKind::StaleQueued => (
            ExceptionRouteTarget::DeterministicBackoff,
            "infra_zero_token_backoff",
        ),
        ExceptionKind::PermissionOrAuth => (
            ExceptionRouteTarget::HumanEscalation,
            "auth_requires_human",
        ),
        ExceptionKind::QaRejection | ExceptionKind::ContentDefect => {
            if input.huddle_rounds_completed < max_rounds {
                (
                    ExceptionRouteTarget::StructuredHuddle,
                    "route_structured_huddle",
                )
            } else {
                (
                    ExceptionRouteTarget::HumanEscalation,
                    "huddle_rounds_exhausted",
                )
            }
        }
    };
    ExceptionRouteDecision {
        target,
        spawn_unblock_issue: false,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: ExceptionKind, done: u32, max: u32) -> ExceptionRouteInput {
        ExceptionRouteInput {
            kind,
            huddle_rounds_completed: done,
            max_huddle_rounds: max,
        }
    }

    fn assert_route(input: ExceptionRouteInput, target: ExceptionRouteTarget, reason: &str) {
        let decision = route_step_exception(&input);
        assert_eq!(decision.target, target);
        assert_eq!(decision.reason, reason);
        assert!(!decision.spawn_unblock_issue);
    }

    #[test]
    fn infra_exceptions_use_zero_token_backoff() {
        for kind in [
            ExceptionKind::RateLimit429,
            ExceptionKind::InfraSigterm,
            ExceptionKind::StaleQueued,
        ] {
            assert_route(
                input(kind, 0, 0),
                ExceptionRouteTarget::DeterministicBackoff,
                "infra_zero_token_backoff",
            );
        }
    }

    #[test]
    fn qa_and_content_defects_huddle_then_escalate() {
        for kind in [ExceptionKind::QaRejection, ExceptionKind::ContentDefect] {
            for done in [0, 1] {
                assert_route(
                    input(kind, done, 0),
                    ExceptionRouteTarget::StructuredHuddle,
                    "route_structured_huddle",
                );
            }
            assert_route(
                input(kind, 2, 0),
                ExceptionRouteTarget::HumanEscalation,
                "huddle_rounds_exhausted",
            );
            assert_route(
                input(kind, 2, 3),
                ExceptionRouteTarget::StructuredHuddle,
                "route_structured_huddle",
            );
        }
    }

    #[test]
    fn permission_or_auth_escalates_directly() {
        assert_route(
            input(ExceptionKind::PermissionOrAuth, 0, 0),
            ExceptionRouteTarget::HumanEscalation,
            "auth_requires_human",
        );
    }

    #[test]
    fn serde_round_trip_preserves_contract() {
        let input = input(ExceptionKind::ContentDefect, 1, 2);
        let encoded = serde_json::to_string(&input).unwrap();
        assert!(encoded.contains("\"kind\":\"content_defect\""));
        let decoded: ExceptionRouteInput = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.kind, input.kind);
        assert_eq!(decoded.huddle_rounds_completed, 1);
        assert_eq!(decoded.max_huddle_rounds, 2);

        let decision = route_step_exception(&input);
        let decision_json = serde_json::to_string(&decision).unwrap();
        assert!(decision_json.contains("\"target\":\"structured_huddle\""));
        let round_tripped: ExceptionRouteDecision =
            serde_json::from_str(&decision_json).unwrap();
        assert_eq!(round_tripped, decision);
    }
}

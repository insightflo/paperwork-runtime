use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepRoutingKind {
    Oversight,
    Analyze,
    Validate,
    Readback,
    Produce,
    Synthesize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRouteInput {
    pub step_kind: StepRoutingKind,
    pub devin_local_available: bool,
    pub high_risk_override: bool,
    pub default_adapter: String,
    pub default_model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepRouteDecision {
    pub adapter: String,
    pub model: String,
    pub zero_cost_routed: bool,
    pub reason: String,
}

pub fn route_step_adapter_model(input: &StepRouteInput) -> StepRouteDecision {
    let lightweight = matches!(
        input.step_kind,
        StepRoutingKind::Oversight
            | StepRoutingKind::Analyze
            | StepRoutingKind::Validate
            | StepRoutingKind::Readback
    );
    if lightweight && !input.high_risk_override && input.devin_local_available {
        return StepRouteDecision {
            adapter: "devin_local".into(),
            model: "swe-2-flash-medium".into(),
            zero_cost_routed: true,
            reason: "lightweight_step_free_tier".into(),
        };
    }
    let reason = if lightweight && input.high_risk_override {
        "high_risk_override"
    } else if lightweight && !input.devin_local_available {
        "devin_local_unavailable"
    } else {
        "production_step_default"
    };
    StepRouteDecision {
        adapter: input.default_adapter.clone(),
        model: input.default_model.clone(),
        zero_cost_routed: false,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(step_kind: StepRoutingKind) -> StepRouteInput {
        StepRouteInput {
            step_kind,
            devin_local_available: true,
            high_risk_override: false,
            default_adapter: "default_adapter".into(),
            default_model: "default_model".into(),
        }
    }

    fn assert_default(decision: &StepRouteDecision, reason: &str) {
        assert_eq!(decision.adapter, "default_adapter");
        assert_eq!(decision.model, "default_model");
        assert!(!decision.zero_cost_routed);
        assert_eq!(decision.reason, reason);
    }

    #[test]
    fn lightweight_steps_route_to_devin_free_tier() {
        for step_kind in [
            StepRoutingKind::Oversight,
            StepRoutingKind::Analyze,
            StepRoutingKind::Validate,
            StepRoutingKind::Readback,
        ] {
            let decision = route_step_adapter_model(&input(step_kind));
            assert_eq!(decision.adapter, "devin_local");
            assert_eq!(decision.model, "swe-2-flash-medium");
            assert!(decision.zero_cost_routed);
            assert_eq!(decision.reason, "lightweight_step_free_tier");
        }
    }

    #[test]
    fn production_steps_stay_on_default_adapter_model() {
        for step_kind in [StepRoutingKind::Produce, StepRoutingKind::Synthesize] {
            let decision = route_step_adapter_model(&input(step_kind));
            assert_default(&decision, "production_step_default");
        }
    }

    #[test]
    fn high_risk_override_keeps_default_adapter_model() {
        let mut input = input(StepRoutingKind::Oversight);
        input.high_risk_override = true;
        let decision = route_step_adapter_model(&input);
        assert_default(&decision, "high_risk_override");
    }

    #[test]
    fn unavailable_devin_local_falls_back_to_default() {
        let mut input = input(StepRoutingKind::Validate);
        input.devin_local_available = false;
        let decision = route_step_adapter_model(&input);
        assert_default(&decision, "devin_local_unavailable");
    }

    #[test]
    fn serde_round_trip_preserves_contract_and_snake_case() {
        for (step_kind, encoded) in [
            (StepRoutingKind::Oversight, "\"oversight\""),
            (StepRoutingKind::Analyze, "\"analyze\""),
            (StepRoutingKind::Validate, "\"validate\""),
            (StepRoutingKind::Readback, "\"readback\""),
            (StepRoutingKind::Produce, "\"produce\""),
            (StepRoutingKind::Synthesize, "\"synthesize\""),
        ] {
            let json = serde_json::to_string(&step_kind).expect("serialize kind");
            assert_eq!(json, encoded);
            let decoded: StepRoutingKind = serde_json::from_str(&json).expect("deserialize kind");
            assert_eq!(decoded, step_kind);
        }

        let input = input(StepRoutingKind::Readback);
        let input_json = serde_json::to_string(&input).expect("serialize input");
        let decoded_input: StepRouteInput = serde_json::from_str(&input_json).expect("deserialize input");
        assert_eq!(decoded_input.step_kind, StepRoutingKind::Readback);
        assert!(decoded_input.devin_local_available);
        assert!(!decoded_input.high_risk_override);
        assert_eq!(decoded_input.default_adapter, input.default_adapter);
        assert_eq!(decoded_input.default_model, input.default_model);

        let decision = route_step_adapter_model(&decoded_input);
        let decision_json = serde_json::to_string(&decision).expect("serialize decision");
        let decoded_decision: StepRouteDecision =
            serde_json::from_str(&decision_json).expect("deserialize decision");
        assert_eq!(decoded_decision, decision);
    }
}

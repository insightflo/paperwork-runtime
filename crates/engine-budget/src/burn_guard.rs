use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BurnGuardStatus {
    Healthy,
    Warning,
    Throttle,
    Halt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissionBurnInput {
    pub spent_cents: u64,
    pub budget_cents: u64,
    pub burn_cents_per_min: f64,
    pub warning_ratio: Option<f64>,
    pub throttle_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MissionBurnDecision {
    pub status: BurnGuardStatus,
    pub utilization_ratio: f64,
    pub remaining_cents: u64,
    pub eta_exhaustion_min: Option<f64>,
}

pub fn evaluate_mission_burn(input: &MissionBurnInput) -> MissionBurnDecision {
    if input.budget_cents == 0 && input.spent_cents == 0 {
        return MissionBurnDecision {
            status: BurnGuardStatus::Healthy,
            utilization_ratio: 0.0,
            remaining_cents: 0,
            eta_exhaustion_min: None,
        };
    }

    let remaining_cents = input.budget_cents.saturating_sub(input.spent_cents);
    let utilization_ratio = input.spent_cents as f64 / input.budget_cents as f64;
    let warning_ratio = input.warning_ratio.unwrap_or(0.75);
    let throttle_ratio = input.throttle_ratio.unwrap_or(0.90);
    let status = if utilization_ratio >= 1.0 {
        BurnGuardStatus::Halt
    } else if utilization_ratio >= throttle_ratio {
        BurnGuardStatus::Throttle
    } else if utilization_ratio >= warning_ratio {
        BurnGuardStatus::Warning
    } else {
        BurnGuardStatus::Healthy
    };
    let eta_exhaustion_min = if remaining_cents == 0 {
        Some(0.0)
    } else if input.burn_cents_per_min.is_finite() && input.burn_cents_per_min > 0.0 {
        Some(remaining_cents as f64 / input.burn_cents_per_min)
    } else {
        None
    };

    MissionBurnDecision {
        status,
        utilization_ratio,
        remaining_cents,
        eta_exhaustion_min,
    }
}

#[cfg(test)]
mod tests {
    use super::BurnGuardStatus::*;
    use super::*;

    fn input(spent_cents: u64, budget_cents: u64, burn_cents_per_min: f64) -> MissionBurnInput {
        MissionBurnInput {
            spent_cents,
            budget_cents,
            burn_cents_per_min,
            warning_ratio: None,
            throttle_ratio: None,
        }
    }

    #[test]
    fn healthy_below_default_warning_threshold() {
        let decision = evaluate_mission_burn(&input(500, 1000, 100.0));
        assert_eq!(decision.status, Healthy);
        assert_eq!(decision.utilization_ratio, 0.5);
        assert_eq!(decision.remaining_cents, 500);
        assert_eq!(decision.eta_exhaustion_min, Some(5.0));
    }

    #[test]
    fn warning_throttle_and_halt_thresholds_are_inclusive() {
        for (spent_cents, expected) in [(750, Warning), (900, Throttle), (1000, Halt)] {
            let decision = evaluate_mission_burn(&input(spent_cents, 1000, 0.0));
            assert_eq!(decision.status, expected, "spent_cents={spent_cents}");
        }
        assert_eq!(evaluate_mission_burn(&input(1000, 1000, 10.0)).eta_exhaustion_min, Some(0.0));
    }

    #[test]
    fn zero_budget_without_spend_is_healthy() {
        assert_eq!(
            evaluate_mission_burn(&input(0, 0, 100.0)),
            MissionBurnDecision {
                status: Healthy,
                utilization_ratio: 0.0,
                remaining_cents: 0,
                eta_exhaustion_min: None,
            }
        );
    }

    #[test]
    fn zero_budget_with_spend_halts() {
        let decision = evaluate_mission_burn(&input(1, 0, 100.0));
        assert_eq!(decision.status, Halt);
        assert!(decision.utilization_ratio.is_infinite());
        assert_eq!(decision.remaining_cents, 0);
        assert_eq!(decision.eta_exhaustion_min, Some(0.0));
    }

    #[test]
    fn non_positive_or_non_finite_burn_rate_has_no_eta() {
        for burn_cents_per_min in [0.0, -1.0, f64::NAN] {
            let decision = evaluate_mission_burn(&input(500, 1000, burn_cents_per_min));
            assert_eq!(decision.eta_exhaustion_min, None);
        }
    }

    #[test]
    fn custom_thresholds_replace_defaults() {
        let mut custom = input(550, 1000, 10.0);
        custom.warning_ratio = Some(0.5);
        custom.throttle_ratio = Some(0.6);
        assert_eq!(evaluate_mission_burn(&custom).status, Warning);
        custom.spent_cents = 650;
        assert_eq!(evaluate_mission_burn(&custom).status, Throttle);
    }

    #[test]
    fn serde_round_trip_preserves_decision_and_input() {
        let mut burn_input = input(800, 1000, 25.0);
        burn_input.warning_ratio = Some(0.8);
        let input_json = serde_json::to_value(&burn_input).unwrap();
        let decoded_input: MissionBurnInput = serde_json::from_value(input_json.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded_input).unwrap(), input_json);

        let decision = evaluate_mission_burn(&burn_input);
        let json = serde_json::to_string(&decision).unwrap();
        assert!(json.contains("\"status\":\"warning\""));
        assert_eq!(serde_json::from_str::<MissionBurnDecision>(&json).unwrap(), decision);
    }
}

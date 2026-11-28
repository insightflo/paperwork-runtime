use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorGateStage {
    G1PrePlan,
    G2RepeatFailure,
    G3PreSubmit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorVerdictKind {
    Pass,
    Challenge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvisorVerdictRecord {
    pub stage: AdvisorGateStage,
    pub verdict: AdvisorVerdictKind,
    pub target_revision: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateCheckResult {
    pub passed: bool,
    pub blocking_reason: Option<String>,
}

fn blocked(reason: &str) -> GateCheckResult {
    GateCheckResult {
        passed: false,
        blocking_reason: Some(reason.to_string()),
    }
}

pub fn verify_stage_gate_clearance(
    records: &[AdvisorVerdictRecord],
    required_stage: AdvisorGateStage,
    current_revision: &str,
) -> GateCheckResult {
    let revision = current_revision.trim();
    if revision.is_empty() {
        return blocked("missing_target_revision");
    }

    let matching = records.iter().rfind(|record| record.stage == required_stage && record.target_revision.trim() == revision);

    match matching {
        None => blocked("missing_advisor_verdict"),
        Some(record) => match record.verdict {
            AdvisorVerdictKind::Pass => GateCheckResult {
                passed: true,
                blocking_reason: None,
            },
            AdvisorVerdictKind::Challenge => {
                let reason = record
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("advisor_challenged");
                blocked(reason)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(stage: AdvisorGateStage, verdict: AdvisorVerdictKind, target_revision: &str, reason: Option<&str>) -> AdvisorVerdictRecord {
        AdvisorVerdictRecord {
            stage,
            verdict,
            target_revision: target_revision.to_string(),
            reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn missing_or_stale_verdict_blocks_gate() {
        let missing = verify_stage_gate_clearance(&[], AdvisorGateStage::G1PrePlan, "rev-1");
        assert!(!missing.passed);
        assert_eq!(missing.blocking_reason.as_deref(), Some("missing_advisor_verdict"));

        let stale_records = [record(AdvisorGateStage::G1PrePlan, AdvisorVerdictKind::Pass, "rev-old", None)];
        let stale = verify_stage_gate_clearance(&stale_records, AdvisorGateStage::G1PrePlan, "rev-current");
        assert!(!stale.passed);
        assert_eq!(stale.blocking_reason.as_deref(), Some("missing_advisor_verdict"));
    }

    #[test]
    fn challenge_blocks_with_trimmed_custom_reason() {
        let records = [record(
            AdvisorGateStage::G2RepeatFailure,
            AdvisorVerdictKind::Challenge,
            "rev-1",
            Some("  evidence is insufficient  "),
        )];
        let result = verify_stage_gate_clearance(&records, AdvisorGateStage::G2RepeatFailure, "rev-1");
        assert!(!result.passed);
        assert_eq!(result.blocking_reason.as_deref(), Some("evidence is insufficient"));
    }

    #[test]
    fn later_pass_overrides_earlier_challenge_on_same_revision() {
        let records = [
            record(AdvisorGateStage::G3PreSubmit, AdvisorVerdictKind::Challenge, "rev-1", Some("retry")),
            record(AdvisorGateStage::G3PreSubmit, AdvisorVerdictKind::Pass, "rev-1", None),
        ];
        let result = verify_stage_gate_clearance(&records, AdvisorGateStage::G3PreSubmit, "rev-1");
        assert!(result.passed);
        assert_eq!(result.blocking_reason, None);
    }

    #[test]
    fn empty_revision_is_rejected() {
        let records = [record(AdvisorGateStage::G1PrePlan, AdvisorVerdictKind::Pass, "", None)];
        for revision in ["", "   ", "\t\n"] {
            let result = verify_stage_gate_clearance(&records, AdvisorGateStage::G1PrePlan, revision);
            assert!(!result.passed);
            assert_eq!(result.blocking_reason.as_deref(), Some("missing_target_revision"));
        }
    }

    #[test]
    fn serde_round_trip_preserves_contracts() {
        for (stage, wire) in [
            (AdvisorGateStage::G1PrePlan, "g1_pre_plan"),
            (AdvisorGateStage::G2RepeatFailure, "g2_repeat_failure"),
            (AdvisorGateStage::G3PreSubmit, "g3_pre_submit"),
        ] {
            assert_eq!(serde_json::to_value(stage).unwrap(), serde_json::json!(wire));
            assert_eq!(serde_json::from_value::<AdvisorGateStage>(serde_json::json!(wire)).unwrap(), stage);
        }
        for (verdict, wire) in [(AdvisorVerdictKind::Pass, "pass"), (AdvisorVerdictKind::Challenge, "challenge")] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), serde_json::json!(wire));
            assert_eq!(serde_json::from_value::<AdvisorVerdictKind>(serde_json::json!(wire)).unwrap(), verdict);
        }

        let original = record(AdvisorGateStage::G3PreSubmit, AdvisorVerdictKind::Challenge, "rev-9", Some("needs review"));
        let encoded = serde_json::to_string(&original).unwrap();
        assert_eq!(serde_json::from_str::<AdvisorVerdictRecord>(&encoded).unwrap(), original);

        let result = GateCheckResult {
            passed: false,
            blocking_reason: Some("advisor_challenged".to_string()),
        };
        let encoded = serde_json::to_string(&result).unwrap();
        assert_eq!(serde_json::from_str::<GateCheckResult>(&encoded).unwrap(), result);
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanCardAdmissionInput {
    pub reason: Option<String>,
    pub message: Option<String>,
    pub next_action: Option<String>,
    pub source_role: String,
    pub has_running_workflow_step: bool,
    pub source_workflow_run_id: Option<String>,
    pub latest_active_workflow_run_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAdmissionRejection {
    HumanCardReasonRequired,
    MissionReworkInProgress,
    SupersededWorkflowRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionAdmissionVerdict {
    pub allowed: bool,
    pub rejection: Option<DecisionAdmissionRejection>,
    pub resolved_text: Option<String>,
}

pub fn evaluate_human_card_admission(input: &HumanCardAdmissionInput) -> DecisionAdmissionVerdict {
    let resolved_text = resolve_text(input).map(str::to_owned);
    let reject = if is_superseded_run(input) {
        Some(DecisionAdmissionRejection::SupersededWorkflowRun)
    } else if input.source_role.trim().eq_ignore_ascii_case("oversight") && input.has_running_workflow_step {
        Some(DecisionAdmissionRejection::MissionReworkInProgress)
    } else if resolved_text.is_none() {
        Some(DecisionAdmissionRejection::HumanCardReasonRequired)
    } else {
        None
    };
    DecisionAdmissionVerdict { allowed: reject.is_none(), rejection: reject, resolved_text }
}

fn resolve_text(input: &HumanCardAdmissionInput) -> Option<&str> {
    trimmed_non_empty(input.reason.as_deref())
        .or_else(|| trimmed_non_empty(input.message.as_deref()))
        .or_else(|| trimmed_non_empty(input.next_action.as_deref()))
}

fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

fn is_superseded_run(input: &HumanCardAdmissionInput) -> bool {
    let (Some(source), Some(latest)) = (&input.source_workflow_run_id, &input.latest_active_workflow_run_id) else {
        return false;
    };
    let source = source.trim();
    let latest = latest.trim();
    !source.is_empty() && !latest.is_empty() && source != latest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> HumanCardAdmissionInput {
        HumanCardAdmissionInput {
            reason: None,
            message: None,
            next_action: None,
            source_role: "mission_owner".to_string(),
            has_running_workflow_step: false,
            source_workflow_run_id: None,
            latest_active_workflow_run_id: None,
        }
    }

    fn verdict(input: &HumanCardAdmissionInput) -> DecisionAdmissionVerdict {
        evaluate_human_card_admission(input)
    }

    #[test]
    fn valid_reason_is_trimmed_and_allowed() {
        let mut input = input();
        input.reason = Some("  Need a human decision.  ".to_string());
        let verdict = verdict(&input);
        assert_eq!(verdict, DecisionAdmissionVerdict {
            allowed: true,
            rejection: None,
            resolved_text: Some("Need a human decision.".to_string()),
        });
    }

    #[test]
    fn blank_reason_falls_back_to_message() {
        let mut input = input();
        input.reason = Some(" \t\n ".to_string());
        input.message = Some("  Message explains the blocker. ".to_string());
        input.next_action = Some("ignored fallback".to_string());
        let verdict = verdict(&input);
        assert!(verdict.allowed);
        assert_eq!(verdict.resolved_text.as_deref(), Some("Message explains the blocker."));
    }

    #[test]
    fn blank_reason_and_message_fall_back_to_next_action() {
        let mut input = input();
        input.reason = Some("".to_string());
        input.message = Some("   ".to_string());
        input.next_action = Some("  Review the failed step.  ".to_string());
        let verdict = verdict(&input);
        assert!(verdict.allowed);
        assert_eq!(verdict.resolved_text.as_deref(), Some("Review the failed step."));
    }

    #[test]
    fn all_blank_or_missing_text_is_rejected() {
        for mut input in [input(), {
            let mut blank = input();
            blank.reason = Some(" ".to_string());
            blank.message = Some("\t\n".to_string());
            blank.next_action = Some("  ".to_string());
            blank
        }] {
            input.source_role = "worker".to_string();
            let verdict = verdict(&input);
            assert!(!verdict.allowed);
            assert_eq!(verdict.rejection, Some(DecisionAdmissionRejection::HumanCardReasonRequired));
            assert_eq!(verdict.resolved_text, None);
        }
    }

    #[test]
    fn oversight_with_running_workflow_step_is_rejected() {
        let mut input = input();
        input.reason = Some("Rework is requested.".to_string());
        input.source_role = "  OvErSiGhT ".to_string();
        input.has_running_workflow_step = true;
        let verdict = verdict(&input);
        assert!(!verdict.allowed);
        assert_eq!(verdict.rejection, Some(DecisionAdmissionRejection::MissionReworkInProgress));
    }

    #[test]
    fn mission_owner_with_running_workflow_step_is_allowed() {
        let mut input = input();
        input.reason = Some("Owner rework is requested.".to_string());
        input.source_role = "mission_owner".to_string();
        input.has_running_workflow_step = true;
        let verdict = verdict(&input);
        assert!(verdict.allowed);
        assert_eq!(verdict.rejection, None);
    }

    #[test]
    fn superseded_run_takes_precedence_over_other_rejections() {
        let mut input = input();
        input.source_role = "oversight".to_string();
        input.has_running_workflow_step = true;
        input.source_workflow_run_id = Some(" run-old ".to_string());
        input.latest_active_workflow_run_id = Some("run-new".to_string());
        let verdict = verdict(&input);
        assert!(!verdict.allowed);
        assert_eq!(verdict.rejection, Some(DecisionAdmissionRejection::SupersededWorkflowRun));
    }

    #[test]
    fn matching_run_ids_are_allowed() {
        let mut input = input();
        input.reason = Some("Current run needs review.".to_string());
        input.source_workflow_run_id = Some(" run-current ".to_string());
        input.latest_active_workflow_run_id = Some("run-current".to_string());
        let verdict = verdict(&input);
        assert!(verdict.allowed);
        assert_eq!(verdict.rejection, None);
    }

    #[test]
    fn blank_or_missing_run_ids_do_not_trigger_superseded_guard() {
        for (source, latest) in [
            (Some("  ".to_string()), Some("run-new".to_string())),
            (Some("run-old".to_string()), Some("".to_string())),
            (None, Some("run-new".to_string())),
            (Some("run-old".to_string()), None),
        ] {
            let mut input = input();
            input.reason = Some("Current run needs review.".to_string());
            input.source_workflow_run_id = source;
            input.latest_active_workflow_run_id = latest;
            assert!(verdict(&input).allowed);
        }
    }

    #[test]
    fn rejection_serde_uses_snake_case_and_round_trips() {
        for (variant, name) in [
            (DecisionAdmissionRejection::HumanCardReasonRequired, "human_card_reason_required"),
            (DecisionAdmissionRejection::MissionReworkInProgress, "mission_rework_in_progress"),
            (DecisionAdmissionRejection::SupersededWorkflowRun, "superseded_workflow_run"),
        ] {
            assert_eq!(serde_json::to_value(variant).unwrap(), serde_json::json!(name));
            assert_eq!(serde_json::from_value::<DecisionAdmissionRejection>(serde_json::json!(name)).unwrap(), variant);
        }
    }

    #[test]
    fn input_and_verdict_serde_round_trip() {
        let mut input = input();
        input.reason = Some(" round trip ".to_string());
        input.source_workflow_run_id = Some("run-1".to_string());
        input.latest_active_workflow_run_id = Some("run-1".to_string());
        let decoded_input: HumanCardAdmissionInput = serde_json::from_value(serde_json::to_value(&input).unwrap()).unwrap();
        assert_eq!(decoded_input.reason.as_deref(), input.reason.as_deref());
        assert_eq!(decoded_input.source_role, input.source_role);
        let verdict = verdict(&input);
        let decoded_verdict: DecisionAdmissionVerdict = serde_json::from_value(serde_json::to_value(&verdict).unwrap()).unwrap();
        assert_eq!(decoded_verdict, verdict);
    }
}

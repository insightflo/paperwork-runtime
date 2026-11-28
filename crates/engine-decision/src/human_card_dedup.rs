use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HumanCardKey {
    pub mission_id: String,
    pub step_run_id: Option<String>,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenHumanCard {
    pub decision_id: String,
    pub key: HumanCardKey,
    pub is_pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanCardDedupDecision {
    pub is_duplicate: bool,
    pub existing_decision_id: Option<String>,
}

pub fn check_human_card_duplicate(
    open_cards: &[OpenHumanCard],
    candidate: &HumanCardKey,
) -> HumanCardDedupDecision {
    let mission_id = candidate.mission_id.trim();
    let step_run_id = normalized_step_run_id(candidate.step_run_id.as_deref());
    let reason_code = candidate.reason_code.trim();

    match open_cards.iter().find(|card| {
        card.is_pending
            && card.key.mission_id.trim() == mission_id
            && normalized_step_run_id(card.key.step_run_id.as_deref()) == step_run_id
            && card.key.reason_code.trim() == reason_code
    }) {
        Some(card) => HumanCardDedupDecision {
            is_duplicate: true,
            existing_decision_id: Some(card.decision_id.clone()),
        },
        None => HumanCardDedupDecision {
            is_duplicate: false,
            existing_decision_id: None,
        },
    }
}

fn normalized_step_run_id(value: Option<&str>) -> &str {
    value.map(str::trim).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(mission_id: &str, step_run_id: Option<&str>, reason_code: &str) -> HumanCardKey {
        HumanCardKey {
            mission_id: mission_id.to_string(),
            step_run_id: step_run_id.map(str::to_string),
            reason_code: reason_code.to_string(),
        }
    }

    fn card(decision_id: &str, key: HumanCardKey, is_pending: bool) -> OpenHumanCard {
        OpenHumanCard {
            decision_id: decision_id.to_string(),
            key,
            is_pending,
        }
    }

    fn not_duplicate() -> HumanCardDedupDecision {
        HumanCardDedupDecision {
            is_duplicate: false,
            existing_decision_id: None,
        }
    }

    #[test]
    fn empty_open_cards_do_not_duplicate() {
        let candidate = key("mission-1", Some("step-1"), "needs_human");
        assert_eq!(check_human_card_duplicate(&[], &candidate), not_duplicate());
    }

    #[test]
    fn exact_pending_match_is_deduplicated() {
        let open_cards = [card("decision-1", key("mission-1", Some("step-1"), "needs_human"), true)];
        let candidate = key("mission-1", Some("step-1"), "needs_human");
        assert_eq!(
            check_human_card_duplicate(&open_cards, &candidate),
            HumanCardDedupDecision {
                is_duplicate: true,
                existing_decision_id: Some("decision-1".to_string()),
            }
        );
    }

    #[test]
    fn trimmed_pending_match_is_deduplicated() {
        let open_cards = [card("decision-1", key("mission-1", Some("step-1"), "needs_human"), true)];
        let candidate = key(" mission-1 ", Some(" step-1 "), " needs_human ");
        assert!(check_human_card_duplicate(&open_cards, &candidate).is_duplicate);
    }

    #[test]
    fn non_pending_card_does_not_block_new_card() {
        let open_cards = [card("decision-1", key("mission-1", Some("step-1"), "needs_human"), false)];
        let candidate = key("mission-1", Some("step-1"), "needs_human");
        assert_eq!(check_human_card_duplicate(&open_cards, &candidate), not_duplicate());
    }

    #[test]
    fn blank_step_run_id_matches_none() {
        let open_cards = [card("decision-1", key("mission-1", Some("  "), "needs_human"), true)];
        let candidate = key("mission-1", None, "needs_human");
        assert!(check_human_card_duplicate(&open_cards, &candidate).is_duplicate);
    }

    #[test]
    fn distinct_step_run_id_is_allowed() {
        let open_cards = [card("decision-1", key("mission-1", Some("step-1"), "needs_human"), true)];
        let candidate = key("mission-1", Some("step-2"), "needs_human");
        assert_eq!(check_human_card_duplicate(&open_cards, &candidate), not_duplicate());
    }

    #[test]
    fn first_matching_pending_card_wins() {
        let key = key("mission-1", Some("step-1"), "needs_human");
        let open_cards = [
            card("decision-first", key.clone(), true),
            card("decision-second", key.clone(), true),
        ];
        assert_eq!(
            check_human_card_duplicate(&open_cards, &key).existing_decision_id,
            Some("decision-first".to_string())
        );
    }

    #[test]
    fn serde_round_trip() {
        let key = key("mission-1", Some("step-1"), "needs_human");
        let open_card = card("decision-1", key.clone(), true);
        let decision = check_human_card_duplicate(std::slice::from_ref(&open_card), &key);

        let key_json = serde_json::to_value(&key).unwrap();
        let card_json = serde_json::to_value(&open_card).unwrap();
        let decision_json = serde_json::to_value(&decision).unwrap();

        assert_eq!(serde_json::from_value::<HumanCardKey>(key_json).unwrap(), key);
        assert_eq!(serde_json::from_value::<OpenHumanCard>(card_json).unwrap(), open_card);
        assert_eq!(serde_json::from_value::<HumanCardDedupDecision>(decision_json).unwrap(), decision);
    }
}

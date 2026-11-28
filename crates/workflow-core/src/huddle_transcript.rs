use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HuddleMessage {
    pub round: u32,
    pub speaker_role: String,
    pub summary: String,
    pub proposed_action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactHuddleBrief {
    pub round_count: u32,
    pub latest_round_messages: Vec<HuddleMessage>,
    pub deduped_actions: Vec<String>,
}

fn truncate_summary(summary: &str, limit: usize) -> String {
    let mut chars = summary.chars();
    let truncated: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

pub fn build_compact_huddle_brief(
    messages: &[HuddleMessage],
    max_summary_chars: usize,
) -> CompactHuddleBrief {
    let limit = if max_summary_chars == 0 {
        240
    } else {
        max_summary_chars
    };
    if messages.is_empty() {
        return CompactHuddleBrief {
            round_count: 0,
            latest_round_messages: Vec::new(),
            deduped_actions: Vec::new(),
        };
    }

    let round_count = messages.iter().map(|m| m.round).max().unwrap_or(0);
    let latest_round_messages = messages
        .iter()
        .filter(|message| message.round == round_count)
        .map(|message| HuddleMessage {
            round: message.round,
            speaker_role: message.speaker_role.clone(),
            summary: truncate_summary(&message.summary, limit),
            proposed_action: message.proposed_action.clone(),
        })
        .collect();

    let mut seen = HashSet::new();
    let mut deduped_actions = Vec::new();
    for action in messages
        .iter()
        .filter_map(|message| message.proposed_action.as_deref())
        .map(str::trim)
        .filter(|action| !action.is_empty())
    {
        if seen.insert(action) {
            deduped_actions.push(action.to_owned());
        }
    }

    CompactHuddleBrief {
        round_count,
        latest_round_messages,
        deduped_actions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(round: u32, summary: &str, action: Option<&str>) -> HuddleMessage {
        HuddleMessage {
            round,
            speaker_role: format!("speaker-{round}"),
            summary: summary.to_owned(),
            proposed_action: action.map(str::to_owned),
        }
    }

    #[test]
    fn empty_messages_produce_empty_brief() {
        let brief = build_compact_huddle_brief(&[], 100);
        assert_eq!(brief.round_count, 0);
        assert!(brief.latest_round_messages.is_empty());
        assert!(brief.deduped_actions.is_empty());
    }

    #[test]
    fn keeps_latest_round_and_dedupes_actions_across_all_rounds() {
        let messages = [
            message(1, "round one", Some("  retry producer  ")),
            message(2, "latest one", Some("retry producer")),
            message(2, "latest two", Some(" escalate ")),
            message(1, "round one extra", Some("   ")),
        ];
        let brief = build_compact_huddle_brief(&messages, 240);

        assert_eq!(brief.round_count, 2);
        assert_eq!(brief.latest_round_messages.len(), 2);
        assert!(
            brief
                .latest_round_messages
                .iter()
                .all(|item| item.round == 2)
        );
        assert_eq!(brief.latest_round_messages[0].summary, "latest one");
        assert_eq!(brief.deduped_actions, ["retry producer", "escalate"]);
    }

    #[test]
    fn truncates_korean_text_on_utf8_char_boundary() {
        let messages = [message(1, "ab가나다", None)];
        let brief = build_compact_huddle_brief(&messages, 3);
        assert_eq!(brief.latest_round_messages[0].summary, "ab가...");
    }

    #[test]
    fn zero_limit_uses_default_240_chars() {
        let messages = [message(1, &"x".repeat(241), None)];
        let brief = build_compact_huddle_brief(&messages, 0);
        let summary = &brief.latest_round_messages[0].summary;
        assert_eq!(summary.chars().count(), 243);
        assert!(summary.ends_with("..."));
    }

    #[test]
    fn serde_round_trip_preserves_brief() {
        let brief = CompactHuddleBrief {
            round_count: 1,
            latest_round_messages: vec![message(1, "요약", Some("다음 행동"))],
            deduped_actions: vec!["다음 행동".to_owned()],
        };
        let json = serde_json::to_string(&brief).expect("serialize brief");
        let decoded: CompactHuddleBrief =
            serde_json::from_str(&json).expect("deserialize brief");
        assert_eq!(decoded, brief);
    }
}

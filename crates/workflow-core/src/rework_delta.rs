use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const DEFAULT_MAX_SUMMARY_CHARS: usize = 600;
const ELLIPSIS: &str = "...";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReworkDeltaInput {
    pub step_id: String,
    pub attempt_index: u32,
    pub failure_summary: String,
    pub artifact_paths: Vec<String>,
    pub max_summary_chars: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReworkDeltaPacket {
    pub step_id: String,
    pub attempt_index: u32,
    pub failure_delta: String,
    pub artifact_paths: Vec<String>,
    pub truncated: bool,
}

pub fn build_rework_delta_packet(input: &ReworkDeltaInput) -> ReworkDeltaPacket {
    let max_summary_chars = if input.max_summary_chars == 0 {
        DEFAULT_MAX_SUMMARY_CHARS
    } else {
        input.max_summary_chars
    };
    let summary = input.failure_summary.trim();
    let truncated = summary.chars().count() > max_summary_chars;
    let mut failure_delta: String = summary.chars().take(max_summary_chars).collect();
    if truncated {
        failure_delta.push_str(ELLIPSIS);
    }

    let mut seen = HashSet::new();
    let mut artifact_paths = Vec::new();
    for artifact_path in &input.artifact_paths {
        let trimmed = artifact_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            artifact_paths.push(trimmed.to_string());
        }
    }

    ReworkDeltaPacket {
        step_id: input.step_id.clone(),
        attempt_index: input.attempt_index,
        failure_delta,
        artifact_paths,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        failure_summary: String,
        artifact_paths: Vec<String>,
        max_summary_chars: usize,
    ) -> ReworkDeltaInput {
        ReworkDeltaInput {
            step_id: "step-1".to_string(),
            attempt_index: 2,
            failure_summary,
            artifact_paths,
            max_summary_chars,
        }
    }

    #[test]
    fn normal_summary_is_trimmed_without_truncation() {
        let packet = build_rework_delta_packet(&input(
            "  QA failed because the artifact contract drifted.  ".to_string(),
            vec!["artifacts/rework.log".to_string()],
            600,
        ));

        assert_eq!(packet.step_id, "step-1");
        assert_eq!(packet.attempt_index, 2);
        assert_eq!(
            packet.failure_delta,
            "QA failed because the artifact contract drifted."
        );
        assert!(!packet.truncated);
    }

    #[test]
    fn utf8_boundary_is_preserved_for_korean_and_emoji() {
        let exact = "가".repeat(4) + "🙂";
        let exact_packet = build_rework_delta_packet(&input(exact.clone(), Vec::new(), 5));
        assert_eq!(exact_packet.failure_delta, exact);
        assert!(!exact_packet.truncated);

        let over_input = format!("{exact}나");
        let over_packet = build_rework_delta_packet(&input(over_input, Vec::new(), 5));
        assert_eq!(over_packet.failure_delta, format!("{exact}..."));
        assert!(over_packet.truncated);
    }

    #[test]
    fn artifact_paths_are_trimmed_non_empty_and_first_seen_deduplicated() {
        let packet = build_rework_delta_packet(&input(
            "failed".to_string(),
            vec![
                " artifacts/a.log ".to_string(),
                "".to_string(),
                "artifacts/a.log".to_string(),
                "artifacts/b.log".to_string(),
                " artifacts/b.log ".to_string(),
                "   ".to_string(),
            ],
            100,
        ));

        assert_eq!(
            packet.artifact_paths,
            vec!["artifacts/a.log", "artifacts/b.log"]
        );
    }

    #[test]
    fn zero_max_summary_chars_uses_default_limit() {
        let packet = build_rework_delta_packet(&input("x".repeat(601), Vec::new(), 0));

        assert!(packet.truncated);
        assert_eq!(packet.failure_delta.chars().count(), 603);
        assert!(packet.failure_delta.ends_with("..."));
        assert_eq!(packet.failure_delta.chars().take(600).count(), 600);
    }

    #[test]
    fn serde_round_trip_preserves_input_and_packet() {
        let source = input(
            "한글 failure 🙂".to_string(),
            vec!["artifacts/a.log".to_string()],
            8,
        );
        let encoded_input = serde_json::to_string(&source).unwrap();
        let decoded_input: ReworkDeltaInput = serde_json::from_str(&encoded_input).unwrap();
        assert_eq!(decoded_input.step_id, source.step_id);
        assert_eq!(decoded_input.attempt_index, source.attempt_index);
        assert_eq!(decoded_input.failure_summary, source.failure_summary);
        assert_eq!(decoded_input.artifact_paths, source.artifact_paths);
        assert_eq!(decoded_input.max_summary_chars, source.max_summary_chars);

        let packet = build_rework_delta_packet(&decoded_input);
        let encoded_packet = serde_json::to_string(&packet).unwrap();
        let decoded_packet: ReworkDeltaPacket = serde_json::from_str(&encoded_packet).unwrap();
        assert_eq!(decoded_packet, packet);
    }
}

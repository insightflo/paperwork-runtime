//! Pure queue-fairness evaluation for heartbeat scheduling.
//!
//! Jain's index measures allocation equality across agents, while the starved
//! set reports agents whose longest wait reached the caller's threshold.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentQueueShare {
    pub agent_id: String,
    pub allocated_slots: u64,
    pub longest_wait_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FairnessReport {
    pub jain_index: f64,
    pub starved_agent_ids: Vec<String>,
    pub is_fair: bool,
}

pub fn evaluate_queue_fairness(
    shares: &[AgentQueueShare],
    starvation_threshold_ms: u64,
    min_jain_index: f64,
) -> FairnessReport {
    let sum: f64 = shares.iter().map(|share| share.allocated_slots as f64).sum();
    let sum_squares: f64 = shares
        .iter()
        .map(|share| {
            let slots = share.allocated_slots as f64;
            slots * slots
        })
        .sum();

    let jain_index = if shares.is_empty() || sum_squares == 0.0 {
        1.0
    } else {
        (sum * sum) / (shares.len() as f64 * sum_squares)
    };

    let mut starved_agent_ids: Vec<String> = shares
        .iter()
        .filter(|share| share.longest_wait_ms >= starvation_threshold_ms)
        .map(|share| share.agent_id.clone())
        .collect();
    starved_agent_ids.sort();
    starved_agent_ids.dedup();

    FairnessReport {
        jain_index,
        is_fair: jain_index >= min_jain_index && starved_agent_ids.is_empty(),
        starved_agent_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share(agent_id: &str, allocated_slots: u64, longest_wait_ms: u64) -> AgentQueueShare {
        AgentQueueShare {
            agent_id: agent_id.to_string(),
            allocated_slots,
            longest_wait_ms,
        }
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
    }

    #[test]
    fn empty_input_is_perfectly_fair() {
        let report = evaluate_queue_fairness(&[], 1_000, 1.0);
        assert_eq!(report.jain_index, 1.0);
        assert!(report.starved_agent_ids.is_empty());
        assert!(report.is_fair);
    }

    #[test]
    fn all_zero_allocations_are_perfectly_fair() {
        let shares = vec![share("alpha", 0, 0), share("beta", 0, 0)];
        let report = evaluate_queue_fairness(&shares, 1_000, 1.0);
        assert_eq!(report.jain_index, 1.0);
        assert!(report.is_fair);
    }

    #[test]
    fn equal_shares_have_jain_index_one() {
        let shares = vec![share("alpha", 4, 0), share("beta", 4, 0), share("gamma", 4, 0)];
        let report = evaluate_queue_fairness(&shares, 1_000, 1.0);
        assert_close(report.jain_index, 1.0);
        assert!(report.is_fair);
    }

    #[test]
    fn monopoly_has_jain_index_one_over_n() {
        let shares = vec![
            share("alpha", 8, 0),
            share("beta", 0, 0),
            share("gamma", 0, 0),
            share("delta", 0, 0),
        ];
        let report = evaluate_queue_fairness(&shares, 1_000, 0.5);
        assert_close(report.jain_index, 0.25);
        assert!(!report.is_fair);
    }

    #[test]
    fn starvation_is_inclusive_sorted_and_deduplicated() {
        let shares = vec![
            share("zulu", 1, 1_000),
            share("alpha", 1, 1_500),
            share("mike", 1, 999),
            share("zulu", 2, 1_200),
        ];
        let report = evaluate_queue_fairness(&shares, 1_000, 0.0);
        assert_eq!(report.starved_agent_ids, vec!["alpha".to_string(), "zulu".to_string()]);
        assert!(!report.is_fair);
    }

    #[test]
    fn serde_round_trip_preserves_contracts() {
        let share = share("alpha", 3, 250);
        let encoded_share = serde_json::to_string(&share).unwrap();
        let decoded_share: AgentQueueShare = serde_json::from_str(&encoded_share).unwrap();
        assert_eq!(decoded_share.agent_id, share.agent_id);
        assert_eq!(decoded_share.allocated_slots, share.allocated_slots);
        assert_eq!(decoded_share.longest_wait_ms, share.longest_wait_ms);

        let report = FairnessReport {
            jain_index: 0.75,
            starved_agent_ids: vec!["alpha".to_string()],
            is_fair: false,
        };
        let encoded_report = serde_json::to_string(&report).unwrap();
        let decoded_report: FairnessReport = serde_json::from_str(&encoded_report).unwrap();
        assert_eq!(decoded_report, report);
    }
}

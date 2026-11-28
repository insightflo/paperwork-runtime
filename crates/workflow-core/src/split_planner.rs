//! [파일 목적] issue dispatch를 단일 에이전트 또는 split fanout 실행 방식으로 보낼지 순수하게 결정한다.
//! [계약] split fanout은 독립 하위작업이 2개 이상이면서 대규모 변경 또는 고위험일 때만 선택한다.
//! [외부 연결] 실행 부수효과는 없고, 호출자가 추정치·위험도·반복 실패·병렬 상한을 주입한다.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    SingleAgentFast,
    SingleAgentFrontier,
    SplitFanout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueDispatchInput {
    pub estimated_file_count: u32,
    pub is_high_risk: bool,
    pub identical_failure_count: u32,
    pub independent_subtask_count: u32,
    pub max_parallel_workers: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueDispatchPlan {
    pub mode: ExecutionMode,
    pub worker_count: u32,
    pub require_independent_verify: bool,
    pub reason: String,
}

pub fn plan_issue_execution_mode(input: &IssueDispatchInput) -> IssueDispatchPlan {
    let max_workers = if input.max_parallel_workers == 0 {
        4
    } else {
        input.max_parallel_workers
    };

    if input.independent_subtask_count >= 2
        && (input.estimated_file_count > 5 || input.is_high_risk)
    {
        return IssueDispatchPlan {
            mode: ExecutionMode::SplitFanout,
            worker_count: input.independent_subtask_count.min(max_workers),
            require_independent_verify: true,
            reason: "multi_subtask_split_fanout".to_string(),
        };
    }

    if input.is_high_risk || input.identical_failure_count >= 2 {
        return IssueDispatchPlan {
            mode: ExecutionMode::SingleAgentFrontier,
            worker_count: 1,
            require_independent_verify: true,
            reason: "high_risk_or_g2_frontier".to_string(),
        };
    }

    IssueDispatchPlan {
        mode: ExecutionMode::SingleAgentFast,
        worker_count: 1,
        require_independent_verify: false,
        reason: "simple_one_shot_fast".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        estimated_file_count: u32,
        is_high_risk: bool,
        identical_failure_count: u32,
        independent_subtask_count: u32,
        max_parallel_workers: u32,
    ) -> IssueDispatchInput {
        IssueDispatchInput {
            estimated_file_count,
            is_high_risk,
            identical_failure_count,
            independent_subtask_count,
            max_parallel_workers,
        }
    }

    #[test]
    fn simple_one_shot_uses_fast_single_agent_without_split_overhead() {
        let plan = plan_issue_execution_mode(&input(2, false, 0, 1, 4));

        assert_eq!(plan.mode, ExecutionMode::SingleAgentFast);
        assert_eq!(plan.worker_count, 1);
        assert!(!plan.require_independent_verify);
        assert_eq!(plan.reason.as_str(), "simple_one_shot_fast");
    }

    #[test]
    fn g2_repeat_failure_promotes_to_frontier_with_independent_verify() {
        let plan = plan_issue_execution_mode(&input(2, false, 2, 1, 4));

        assert_eq!(plan.mode, ExecutionMode::SingleAgentFrontier);
        assert_eq!(plan.worker_count, 1);
        assert!(plan.require_independent_verify);
        assert_eq!(plan.reason.as_str(), "high_risk_or_g2_frontier");
    }

    #[test]
    fn high_risk_multi_subtask_uses_split_fanout_capped_at_max_workers() {
        let plan = plan_issue_execution_mode(&input(1, true, 0, 9, 4));

        assert_eq!(plan.mode, ExecutionMode::SplitFanout);
        assert_eq!(plan.worker_count, 4);
        assert!(plan.require_independent_verify);
        assert_eq!(plan.reason.as_str(), "multi_subtask_split_fanout");
    }

    #[test]
    fn serde_round_trip_preserves_mode_and_plan_contracts() {
        let encoded_mode = serde_json::to_string(&ExecutionMode::SplitFanout).unwrap();
        assert_eq!(encoded_mode.as_str(), "\"split_fanout\"");
        let decoded_mode: ExecutionMode = serde_json::from_str(&encoded_mode).unwrap();
        assert_eq!(decoded_mode, ExecutionMode::SplitFanout);

        let plan = IssueDispatchPlan {
            mode: ExecutionMode::SingleAgentFrontier,
            worker_count: 1,
            require_independent_verify: true,
            reason: "high_risk_or_g2_frontier".to_string(),
        };
        let encoded_plan = serde_json::to_string(&plan).unwrap();
        let decoded_plan: IssueDispatchPlan = serde_json::from_str(&encoded_plan).unwrap();
        assert_eq!(decoded_plan, plan);
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelTargetKind {
    QueuedWakeup,
    OpenUnblockIssue,
    OpenOwnerActionIssue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveWorkItem {
    pub id: String,
    pub kind: CancelTargetKind,
    pub workflow_run_id: String,
    pub is_terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupersededCancelPlan {
    pub latest_workflow_run_id: String,
    pub cancel_ids: Vec<String>,
    pub kept_count: usize,
}

pub fn plan_superseded_run_cancellations(
    latest_workflow_run_id: &str,
    items: &[ActiveWorkItem],
) -> SupersededCancelPlan {
    let latest = latest_workflow_run_id.trim();
    if latest.is_empty() {
        return SupersededCancelPlan {
            latest_workflow_run_id: latest.to_string(),
            cancel_ids: Vec::new(),
            kept_count: items.len(),
        };
    }

    let mut selected: Vec<&ActiveWorkItem> = items
        .iter()
        .filter(|item| {
            let item_run_id = item.workflow_run_id.trim();
            !item.is_terminal && !item_run_id.is_empty() && item_run_id != latest
        })
        .collect();
    let selected_items_count = selected.len();
    selected.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut seen = HashSet::new();
    let mut cancel_ids = Vec::new();
    for item in selected {
        if seen.insert(item.id.as_str()) {
            cancel_ids.push(item.id.clone());
        }
    }

    SupersededCancelPlan {
        latest_workflow_run_id: latest.to_string(),
        cancel_ids,
        kept_count: items.len().saturating_sub(selected_items_count),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: CancelTargetKind, workflow_run_id: &str, is_terminal: bool) -> ActiveWorkItem {
        ActiveWorkItem {
            id: id.to_string(),
            kind,
            workflow_run_id: workflow_run_id.to_string(),
            is_terminal,
        }
    }

    #[test]
    fn empty_latest_run_id_cancels_nothing() {
        let items = [
            item("wake-1", CancelTargetKind::QueuedWakeup, "run-old", false),
            item("issue-1", CancelTargetKind::OpenUnblockIssue, "run-old", false),
        ];
        let plan = plan_superseded_run_cancellations(" \t ", &items);
        assert!(plan.cancel_ids.is_empty());
        assert_eq!(plan.kept_count, items.len());
        assert_eq!(plan.latest_workflow_run_id, "");
    }

    #[test]
    fn active_items_from_superseded_runs_are_cancelled_across_all_kinds() {
        let items = [
            item("wake-1", CancelTargetKind::QueuedWakeup, "run-old", false),
            item("unblock-1", CancelTargetKind::OpenUnblockIssue, " run-old ", false),
            item("owner-1", CancelTargetKind::OpenOwnerActionIssue, "run-older", false),
        ];
        let plan = plan_superseded_run_cancellations("run-new", &items);
        assert_eq!(plan.cancel_ids, vec!["wake-1", "unblock-1", "owner-1"]);
        assert_eq!(plan.kept_count, 0);
    }

    #[test]
    fn terminal_blank_run_and_latest_run_items_are_kept() {
        let items = [
            item("terminal-old", CancelTargetKind::QueuedWakeup, "run-old", true),
            item("blank-run", CancelTargetKind::OpenUnblockIssue, "  ", false),
            item("latest", CancelTargetKind::OpenOwnerActionIssue, " run-new ", false),
        ];
        let plan = plan_superseded_run_cancellations("run-new", &items);
        assert!(plan.cancel_ids.is_empty());
        assert_eq!(plan.kept_count, items.len());
    }

    #[test]
    fn ordering_is_kind_then_id_and_duplicate_ids_are_emitted_once() {
        let items = [
            item("owner-z", CancelTargetKind::OpenOwnerActionIssue, "run-old", false),
            item("wake-b", CancelTargetKind::QueuedWakeup, "run-old", false),
            item("unblock-b", CancelTargetKind::OpenUnblockIssue, "run-old", false),
            item("wake-a", CancelTargetKind::QueuedWakeup, "run-old", false),
            item("unblock-a", CancelTargetKind::OpenUnblockIssue, "run-old", false),
            item("unblock-a", CancelTargetKind::OpenUnblockIssue, "run-old", false),
        ];
        let plan = plan_superseded_run_cancellations("run-new", &items);
        assert_eq!(
            plan.cancel_ids,
            vec!["wake-a", "wake-b", "unblock-a", "unblock-b", "owner-z"]
        );
        assert_eq!(plan.kept_count, 0);
    }

    #[test]
    fn serde_round_trip_preserves_snake_case_contract() {
        let source = item("owner-1", CancelTargetKind::OpenOwnerActionIssue, "run-old", false);
        let encoded_item = serde_json::to_string(&source).unwrap();
        assert!(encoded_item.contains("\"kind\":\"open_owner_action_issue\""));
        let decoded_item: ActiveWorkItem = serde_json::from_str(&encoded_item).unwrap();
        assert_eq!(decoded_item, source);

        let plan = plan_superseded_run_cancellations(" run-new ", &[decoded_item]);
        let encoded_plan = serde_json::to_string(&plan).unwrap();
        assert!(encoded_plan.contains("\"latest_workflow_run_id\":\"run-new\""));
        let decoded_plan: SupersededCancelPlan = serde_json::from_str(&encoded_plan).unwrap();
        assert_eq!(decoded_plan, plan);
    }
}

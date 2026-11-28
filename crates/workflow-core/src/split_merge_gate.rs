use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitBranchOutcome {
    pub branch_id: String,
    pub succeeded: bool,
    pub touched_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitMergeVerdict {
    pub ready_to_merge: bool,
    pub failed_branch_ids: Vec<String>,
    pub conflicting_files: Vec<String>,
}

pub fn evaluate_split_merge_gate(branches: &[SplitBranchOutcome]) -> SplitMergeVerdict {
    let mut failed_branch_ids = branches
        .iter()
        .filter(|branch| !branch.succeeded)
        .map(|branch| branch.branch_id.clone())
        .collect::<Vec<_>>();
    failed_branch_ids.sort();

    let mut touch_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for branch in branches {
        let mut unique_files = BTreeSet::new();
        for file in &branch.touched_files {
            let trimmed = file.trim();
            if !trimmed.is_empty() {
                unique_files.insert(trimmed);
            }
        }
        for file in unique_files {
            *touch_counts.entry(file).or_insert(0) += 1;
        }
    }

    let conflicting_files = touch_counts
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .map(|(file, _)| file.to_string())
        .collect::<Vec<_>>();

    SplitMergeVerdict {
        ready_to_merge: !branches.is_empty()
            && failed_branch_ids.is_empty()
            && conflicting_files.is_empty(),
        failed_branch_ids,
        conflicting_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch(branch_id: &str, succeeded: bool, touched_files: &[&str]) -> SplitBranchOutcome {
        SplitBranchOutcome {
            branch_id: branch_id.to_string(),
            succeeded,
            touched_files: touched_files.iter().map(|file| String::from(*file)).collect(),
        }
    }

    #[test]
    fn empty_branches_are_not_ready_to_merge() {
        let verdict = evaluate_split_merge_gate(&[]);

        assert!(!verdict.ready_to_merge);
        assert!(verdict.failed_branch_ids.is_empty());
        assert!(verdict.conflicting_files.is_empty());
    }

    #[test]
    fn disjoint_successful_branches_are_ready_to_merge() {
        let branches = [
            branch("left", true, &["src/left.rs"]),
            branch("right", true, &["src/right.rs"]),
        ];

        let verdict = evaluate_split_merge_gate(&branches);

        assert!(verdict.ready_to_merge);
        assert!(verdict.failed_branch_ids.is_empty());
        assert!(verdict.conflicting_files.is_empty());
    }

    #[test]
    fn overlapping_files_are_conflicts_and_sorted() {
        let branches = [
            branch("left", true, &["zeta.rs", "alpha.rs"]),
            branch("right", true, &[" beta.rs ", "zeta.rs", "alpha.rs"]),
        ];

        let verdict = evaluate_split_merge_gate(&branches);

        assert!(!verdict.ready_to_merge);
        assert_eq!(
            verdict.conflicting_files,
            vec!["alpha.rs".to_string(), "zeta.rs".to_string()]
        );
    }

    #[test]
    fn failed_branches_block_merge_and_are_sorted() {
        let branches = [
            branch("zulu", false, &["zulu.rs"]),
            branch("alpha", false, &["alpha.rs"]),
            branch("ok", true, &["ok.rs"]),
        ];

        let verdict = evaluate_split_merge_gate(&branches);

        assert!(!verdict.ready_to_merge);
        assert_eq!(
            verdict.failed_branch_ids,
            vec!["alpha".to_string(), "zulu".to_string()]
        );
    }

    #[test]
    fn duplicate_file_within_one_branch_is_not_a_cross_branch_conflict() {
        let branches = [branch(
            "solo",
            true,
            &["same.rs", " same.rs ", "same.rs"],
        )];

        let verdict = evaluate_split_merge_gate(&branches);

        assert!(verdict.ready_to_merge);
        assert!(verdict.conflicting_files.is_empty());
    }

    #[test]
    fn serde_round_trips_outcome_and_verdict() {
        let outcome = branch("serde", false, &["src/serde.rs"]);
        let outcome_json = serde_json::to_string(&outcome).unwrap();
        let outcome_back: SplitBranchOutcome = serde_json::from_str(&outcome_json).unwrap();
        assert_eq!(outcome_back, outcome);

        let verdict = SplitMergeVerdict {
            ready_to_merge: false,
            failed_branch_ids: vec!["serde".to_string()],
            conflicting_files: vec!["src/serde.rs".to_string()],
        };
        let verdict_json = serde_json::to_string(&verdict).unwrap();
        let verdict_back: SplitMergeVerdict = serde_json::from_str(&verdict_json).unwrap();
        assert_eq!(verdict_back, verdict);
    }
}

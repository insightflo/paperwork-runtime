use crate::scoring::{normalize_nfc_lower, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

const DEFAULT_STALE_DAYS: u64 = 90;
const MAX_STALE_DAYS: u64 = 36_500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LintNodesRequest {
    pub schema_version: u32,
    pub now_epoch_ms: i64,
    pub stale_days: Option<u64>,
    pub nodes: Vec<LintNodeInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LintNodeInput {
    pub id: String,
    pub kb_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub certified: bool,
    #[serde(default)]
    pub linked_node_ids: Vec<String>,
    pub updated_at_epoch_ms: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LintFinding {
    pub node_id: String,
    pub kb_id: String,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintNodesResponse {
    pub schema_version: u32,
    pub findings: Vec<LintFinding>,
    pub stale_retire_candidate_ids: Vec<String>,
}

pub fn lint_nodes(req: LintNodesRequest) -> Result<LintNodesResponse, String> {
    if req.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schemaVersion: {}", req.schema_version));
    }
    let clamped_days = req
        .stale_days
        .unwrap_or(DEFAULT_STALE_DAYS)
        .min(MAX_STALE_DAYS);
    let stale_ms = (clamped_days as i64).saturating_mul(24 * 60 * 60 * 1000);
    let status_by_id: HashMap<&str, &str> = req
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.status.as_str()))
        .collect();

    let mut findings = Vec::new();
    let mut stale_ids = Vec::new();
    let mut title_groups: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();

    for node in &req.nodes {
        if node.status != "active" {
            continue;
        }
        let norm_title = normalize_nfc_lower(node.title.trim());
        title_groups
            .entry((node.kb_id.clone(), norm_title))
            .or_default()
            .push(node.id.clone());

        let mut active_outgoing = 0usize;
        for target_id in &node.linked_node_ids {
            match status_by_id.get(target_id.as_str()).copied() {
                None => findings.push(LintFinding {
                    node_id: node.id.clone(),
                    kb_id: node.kb_id.clone(),
                    code: "broken_link_missing".into(),
                    detail: target_id.clone(),
                }),
                Some(st) if st != "active" => findings.push(LintFinding {
                    node_id: node.id.clone(),
                    kb_id: node.kb_id.clone(),
                    code: "broken_link_retired".into(),
                    detail: target_id.clone(),
                }),
                Some(_) => active_outgoing += 1,
            }
        }

        let has_valid_parent = match node.parent_id.as_deref() {
            None => false,
            Some(pid) => match status_by_id.get(pid).copied() {
                None => {
                    findings.push(LintFinding {
                        node_id: node.id.clone(),
                        kb_id: node.kb_id.clone(),
                        code: "broken_link_missing".into(),
                        detail: format!("parent:{pid}"),
                    });
                    false
                }
                Some(st) if st != "active" => {
                    findings.push(LintFinding {
                        node_id: node.id.clone(),
                        kb_id: node.kb_id.clone(),
                        code: "broken_link_retired".into(),
                        detail: format!("parent:{pid}"),
                    });
                    false
                }
                Some(_) => true,
            },
        };

        if !has_valid_parent && active_outgoing == 0 {
            findings.push(LintFinding {
                node_id: node.id.clone(),
                kb_id: node.kb_id.clone(),
                code: "orphan".into(),
                detail: "rootless node with no active outgoing links".into(),
            });
        }

        if !node.certified && req.now_epoch_ms.saturating_sub(node.updated_at_epoch_ms) > stale_ms {
            findings.push(LintFinding {
                node_id: node.id.clone(),
                kb_id: node.kb_id.clone(),
                code: "stale_uncertified".into(),
                detail: format!("older than {}d", clamped_days),
            });
            stale_ids.push(node.id.clone());
        }
    }

    for ((kb_id, norm_title), mut ids) in title_groups {
        if ids.len() > 1 {
            ids.sort();
            for id in &ids[1..] {
                findings.push(LintFinding {
                    node_id: id.clone(),
                    kb_id: kb_id.clone(),
                    code: "duplicate_title".into(),
                    detail: format!("duplicates {} ({})", ids[0], norm_title),
                });
            }
        }
    }

    findings.sort_by(|a, b| {
        a.node_id
            .cmp(&b.node_id)
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| a.detail.cmp(&b.detail))
    });
    stale_ids.sort();

    Ok(LintNodesResponse {
        schema_version: SCHEMA_VERSION,
        findings,
        stale_retire_candidate_ids: stale_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn detects_nfd_vs_nfc_duplicate_and_independent_orphan_plus_broken_links_and_stale() {
        let now = 1_800_000_000_000i64;
        let old = now - 100 * 24 * 60 * 60 * 1000;
        let nfd_stored: String = "배포 정책".nfd().collect();
        let res = lint_nodes(LintNodesRequest {
            schema_version: 1,
            now_epoch_ms: now,
            stale_days: Some(90),
            nodes: vec![
                LintNodeInput {
                    id: "n1".into(),
                    kb_id: "kb1".into(),
                    parent_id: None,
                    title: nfd_stored,
                    status: "active".into(),
                    certified: true,
                    linked_node_ids: vec!["n3".into(), "missing-id".into()],
                    updated_at_epoch_ms: old,
                },
                LintNodeInput {
                    id: "n2".into(),
                    kb_id: "kb1".into(),
                    parent_id: Some("n1".into()),
                    title: "배포 정책".into(),
                    status: "active".into(),
                    certified: false,
                    linked_node_ids: vec![],
                    updated_at_epoch_ms: old,
                },
                LintNodeInput {
                    id: "n3".into(),
                    kb_id: "kb1".into(),
                    parent_id: None,
                    title: "Old Retired".into(),
                    status: "retired".into(),
                    certified: false,
                    linked_node_ids: vec![],
                    updated_at_epoch_ms: old,
                },
            ],
        })
        .unwrap();

        let codes: Vec<(&str, &str)> = res
            .findings
            .iter()
            .map(|f| (f.node_id.as_str(), f.code.as_str()))
            .collect();
        assert!(codes.contains(&("n1", "orphan")));
        assert!(codes.contains(&("n1", "broken_link_retired")));
        assert!(codes.contains(&("n1", "broken_link_missing")));
        assert!(!codes.contains(&("n1", "stale_uncertified")));
        assert!(codes.contains(&("n2", "duplicate_title")));
        assert!(codes.contains(&("n2", "stale_uncertified")));
        assert_eq!(res.stale_retire_candidate_ids, vec!["n2".to_string()]);
    }
}

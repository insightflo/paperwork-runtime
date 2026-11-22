use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

pub const SCHEMA_VERSION: u32 = 1;
const MAX_LIMIT: usize = 8;
const MAX_SNIPPET_CHARS: usize = 180;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreNodesRequest {
    pub schema_version: u32,
    pub query: String,
    pub limit: Option<usize>,
    pub nodes: Vec<ScoreNodeInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreNodeInput {
    pub id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_node_type")]
    pub node_type: String,
    #[serde(default)]
    pub certified: bool,
}

fn default_node_type() -> String {
    "concept".to_string()
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScoreNodeHit {
    pub id: String,
    pub score: u32,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreNodesResponse {
    pub schema_version: u32,
    pub hits: Vec<ScoreNodeHit>,
}

pub fn normalize_nfc_lower(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}

pub fn tokenize(query: &str) -> Vec<String> {
    let norm = normalize_nfc_lower(query);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for part in norm.split(|c: char| !c.is_alphanumeric()) {
        if part.chars().count() >= 2 && seen.insert(part.to_string()) {
            out.push(part.to_string());
            if out.len() >= 12 {
                break;
            }
        }
    }
    out
}

fn extract_char_snippet(text: &str, needle: Option<&str>) -> String {
    let nfc: String = text.nfc().collect();
    let collapsed: String = nfc.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let start_char = needle
        .and_then(|tok| {
            let lower: String = collapsed.to_lowercase();
            lower
                .find(tok)
                .map(|byte_idx| lower[..byte_idx].chars().count().saturating_sub(30))
        })
        .unwrap_or(0);
    chars
        .into_iter()
        .skip(start_char)
        .take(MAX_SNIPPET_CHARS)
        .collect()
}

pub fn score_nodes(req: ScoreNodesRequest) -> Result<ScoreNodesResponse, String> {
    if req.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schemaVersion: {}", req.schema_version));
    }
    let limit = match req.limit {
        Some(0) => return Err("limit must be >= 1".to_string()),
        Some(n) => n.min(MAX_LIMIT),
        None => 5,
    };
    let tokens = tokenize(&req.query);
    if tokens.is_empty() {
        return Err("query must contain at least one search term (min 2 chars)".to_string());
    }

    let mut hits = Vec::new();
    for node in &req.nodes {
        let title_l = normalize_nfc_lower(&node.title);
        let slug_l = normalize_nfc_lower(&node.slug);
        let summary_l = normalize_nfc_lower(&node.summary);
        let content_l = normalize_nfc_lower(&node.content);
        let tags_l: Vec<String> = node.tags.iter().map(|t| normalize_nfc_lower(t)).collect();

        let mut match_score: u32 = 0;
        let mut first_tok: Option<&str> = None;
        for tok in &tokens {
            if title_l.contains(tok.as_str()) || slug_l.contains(tok.as_str()) {
                match_score += 4;
            }
            if tags_l.iter().any(|t| t.contains(tok.as_str())) {
                match_score += 3;
            }
            if summary_l.contains(tok.as_str()) {
                match_score += 2;
            }
            if content_l.contains(tok.as_str()) {
                match_score += 1;
                if first_tok.is_none() {
                    first_tok = Some(tok.as_str());
                }
            }
        }
        if match_score == 0 {
            continue;
        }
        let boost = u32::from(node.certified) * 2 + u32::from(node.node_type == "glossary");
        let snippet_src = if node.content.trim().is_empty() {
            &node.summary
        } else {
            &node.content
        };
        hits.push(ScoreNodeHit {
            id: node.id.clone(),
            score: match_score + boost,
            snippet: extract_char_snippet(snippet_src, first_tok),
        });
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    hits.truncate(limit);
    Ok(ScoreNodesResponse {
        schema_version: SCHEMA_VERSION,
        hits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn scores_korean_nfc_and_nfd_safely_with_deterministic_tie_break() {
        let nfd_title: String = "워크트리 격리 규칙".nfd().collect();
        let req = ScoreNodesRequest {
            schema_version: 1,
            query: "워크트리 규칙".to_string(),
            limit: Some(8),
            nodes: vec![
                ScoreNodeInput {
                    id: "b-node".into(),
                    slug: "worktree-b".into(),
                    title: nfd_title,
                    summary: "한국어 요약".into(),
                    content: "워크트리 격리 규칙을 반드시 준수해야 합니다. ".repeat(10),
                    tags: vec!["워크트리".into()],
                    node_type: "glossary".into(),
                    certified: true,
                },
                ScoreNodeInput {
                    id: "a-node".into(),
                    slug: "worktree-a".into(),
                    title: "워크트리 격리 규칙".into(),
                    summary: "한국어 요약".into(),
                    content: "워크트리 격리 규칙을 반드시 준수해야 합니다. ".repeat(10),
                    tags: vec!["워크트리".into()],
                    node_type: "glossary".into(),
                    certified: true,
                },
            ],
        };
        let res = score_nodes(req).unwrap();
        assert_eq!(res.hits.len(), 2);
        assert_eq!(res.hits[0].id, "a-node");
        assert_eq!(res.hits[1].id, "b-node");
        assert!(res.hits[0].snippet.chars().count() <= MAX_SNIPPET_CHARS);
    }

    #[test]
    fn rejects_invalid_schema_version_and_zero_limit_and_unknown_fields() {
        let bad_ver: ScoreNodesRequest =
            serde_json::from_str(r#"{"schemaVersion":2,"query":"test","nodes":[]}"#).unwrap();
        assert!(score_nodes(bad_ver).is_err());

        let bad_limit: ScoreNodesRequest =
            serde_json::from_str(r#"{"schemaVersion":1,"query":"test","limit":0,"nodes":[]}"#)
                .unwrap();
        assert!(score_nodes(bad_limit).is_err());

        let unknown = serde_json::from_str::<ScoreNodesRequest>(
            r#"{"schemaVersion":1,"query":"test","extraField":1,"nodes":[]}"#,
        );
        assert!(unknown.is_err());
    }
}

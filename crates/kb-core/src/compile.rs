use crate::scoring::{normalize_nfc_lower, tokenize, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileMissionRequest {
    pub schema_version: u32,
    pub mission_id: String,
    pub mission_title: String,
    pub completed_at: String,
    pub url: Option<String>,
    pub slug_hint: Option<String>,
    pub section: Option<String>,
    #[serde(default)]
    pub highlights: Vec<String>,
    #[serde(default)]
    pub existing_nodes: Vec<ExistingNodeRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingNodeRef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledSourceRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileMissionResponse {
    pub schema_version: u32,
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub node_type: String,
    pub tags: Vec<String>,
    pub linked_node_ids: Vec<String>,
    pub source_refs: Vec<CompiledSourceRef>,
}

fn slugify(raw: &str, fallback_id: &str) -> String {
    let nfc = normalize_nfc_lower(raw);
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in nfc.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!(
            "mission-{}",
            fallback_id.chars().take(8).collect::<String>()
        )
    } else {
        trimmed
    }
}

pub fn compile_mission(req: CompileMissionRequest) -> Result<CompileMissionResponse, String> {
    if req.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schemaVersion: {}", req.schema_version));
    }
    let title: String = req
        .mission_title
        .nfc()
        .collect::<String>()
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("missionTitle must be non-empty".to_string());
    }

    let slug_src = req.slug_hint.as_deref().unwrap_or(&title);
    let slug = slugify(slug_src, &req.mission_id);

    let mut tag_set = BTreeSet::new();
    tag_set.insert("auto-compiled".to_string());
    if let Some(sec) = &req.section {
        let s = normalize_nfc_lower(sec.trim());
        if !s.is_empty() {
            tag_set.insert(s);
        }
    }
    for tok in tokenize(&title).into_iter().take(5) {
        tag_set.insert(tok);
    }
    let tags: Vec<String> = tag_set.into_iter().collect();

    let clean_highlights: Vec<String> = req
        .highlights
        .iter()
        .map(|h| h.nfc().collect::<String>().trim().to_string())
        .filter(|h| !h.is_empty())
        .take(8)
        .collect();

    let summary_src = clean_highlights
        .first()
        .map(String::as_str)
        .unwrap_or(&title);
    let summary: String = summary_src.chars().take(100).collect();

    let mut body_lines = vec![format!("# {}", title)];
    if let Some(url) = &req.url {
        body_lines.push(format!("- Source URL: {}", url.trim()));
    }
    if !clean_highlights.is_empty() {
        body_lines.push(String::new());
        body_lines.push("## Key Facts".to_string());
        for h in &clean_highlights {
            body_lines.push(format!("- {}", h));
        }
    }
    let content = body_lines.join("\n");

    let mut scored_links: Vec<(u32, String)> = Vec::new();
    for ex in &req.existing_nodes {
        let ex_title = normalize_nfc_lower(&ex.title);
        let ex_tags: Vec<String> = ex.tags.iter().map(|t| normalize_nfc_lower(t)).collect();
        let mut overlap = 0u32;
        for t in &tags {
            if t == "auto-compiled" {
                continue;
            }
            if ex_tags.iter().any(|et| et == t) {
                overlap += 2;
            }
            if ex_title.contains(t.as_str()) {
                overlap += 1;
            }
        }
        if overlap > 0 {
            scored_links.push((overlap, ex.id.clone()));
        }
    }
    scored_links.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let linked_node_ids: Vec<String> = scored_links.into_iter().take(3).map(|(_, id)| id).collect();

    Ok(CompileMissionResponse {
        schema_version: SCHEMA_VERSION,
        slug,
        title,
        summary,
        content,
        node_type: "entity".to_string(),
        tags,
        linked_node_ids,
        source_refs: vec![CompiledSourceRef {
            kind: "mission".to_string(),
            id: req.mission_id,
            label: req.mission_title.nfc().collect(),
            url: req.url,
            updated_at: req.completed_at,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_mission_deterministically_and_auto_links_top_3() {
        let res = compile_mission(CompileMissionRequest {
            schema_version: 1,
            mission_id: "a5778f5b-e7bf-480f-ab7b-51a13232a970".into(),
            mission_title: "2026-11-22 service-onboarding — instagram-agent-skill".into(),
            completed_at: "2026-11-22T12:00:00Z".into(),
            url: Some("https://github.com/postzen-dev/instagram-agent-skill".into()),
            slug_hint: Some("instagram-agent-skill".into()),
            section: Some("manuals".into()),
            highlights: vec!["Instagram 자동화 스킬 온보딩 가이드".into()],
            existing_nodes: vec![
                ExistingNodeRef {
                    id: "node-1".into(),
                    title: "Instagram Agent Skill Overview".into(),
                    tags: vec!["instagram".into(), "manuals".into()],
                },
                ExistingNodeRef {
                    id: "node-2".into(),
                    title: "Unrelated Finance Thesis".into(),
                    tags: vec!["macro".into()],
                },
            ],
        })
        .unwrap();

        assert_eq!(res.slug, "instagram-agent-skill");
        assert_eq!(res.linked_node_ids, vec!["node-1".to_string()]);
        assert_eq!(res.source_refs[0].kind, "mission");
        assert!(res.content.contains("Instagram 자동화 스킬 온보딩 가이드"));
    }
}

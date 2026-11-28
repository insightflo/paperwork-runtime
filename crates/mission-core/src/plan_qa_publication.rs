//! Publication receipt topology checks shared by the mission PLAN-QA entry point.
use super::{diag, helpers::*};
use crate::js::{js_to_string, js_trim, js_truthy};
use serde_json::{json, Value};

/// `consumesPublicationResult` — the consumer's declared receipt arg must bind
/// `{$steps.<publisher-id>.workProductPath}`.
fn consumes_publication_result(
    unit: Option<&Value>,
    publisher: Option<&Value>,
    tools: Option<&Value>,
) -> Result<bool, String> {
    let Some(pid) = prop(publisher, "id")?.and_then(Value::as_str) else {
        return Ok(false);
    };
    let trimmed = js_trim(pid);
    if trimmed.is_empty() {
        return Ok(false);
    }
    let Some(args) = prop(unit, "toolArgs")?.and_then(Value::as_object) else {
        return Ok(false);
    };
    let reference = format!("{{$steps.{trimmed}.workProductPath}}");
    for c in selected_artifact_contracts(unit, tools)? {
        if c.get("role").and_then(Value::as_str) != Some("publication-verify") {
            continue;
        }
        let receipt = c.get("consumerParams").and_then(|cp| cp.get("receipt"));
        if !receipt.is_some_and(js_truthy) {
            continue;
        }
        if args
            .get(js_to_string(receipt).as_str())
            .and_then(Value::as_str)
            == Some(reference.as_str())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `reviewPublicationVerificationTopology` — every publication unit needs a
/// downstream publication-verify consumer with the bound receipt argument.
pub(super) fn review_publication_verification_topology(
    units: &[Value],
    tools: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let deps = build_dependency_index(units)?;
    for (pi, publisher) in units.iter().enumerate() {
        if !has_plan_artifact_role(Some(publisher), tools, "publication")? {
            continue;
        }
        let mut ok = false;
        for (ci, consumer) in units.iter().enumerate() {
            if unit_depends_on(&deps, ci, pi)
                && consumes_publication_result(Some(consumer), Some(publisher), tools)?
            {
                ok = true;
                break;
            }
        }
        if !ok {
            return Ok(vec![diag("missing_publication_verify_tool", "invalid",
                "Each publication unit requires a downstream publication-verify tool whose declared artifactContract.consumerParams.receipt argument binds {$steps.<publication-unit-id>.workProductPath}. Use the registered result, not a guessed destination.".into())]);
        }
    }
    Ok(vec![])
}

/// `reviewPublicationQaReceiptTopology` — receipt-requiring publishers need
/// an upstream declared mechanical QA tool when the catalog supports QA.
pub(super) fn review_publication_qa_receipt_topology(
    units: &[Value],
    tools: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let mut company_has_qa_tool = false;
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        let unit = json!({ "toolName": prop(Some(tool), "name")? });
        if has_plan_artifact_role(Some(&unit), Some(&json!([tool])), "qa")? {
            company_has_qa_tool = true;
            break;
        }
    }
    if !company_has_qa_tool {
        return Ok(vec![]);
    }
    let deps = build_dependency_index(units)?;
    for (pi, publisher) in units.iter().enumerate() {
        let requires_receipt = selected_artifact_contracts(Some(publisher), tools)?.iter().any(|c| {
            c.get("role").and_then(Value::as_str) == Some("publication")
                && c.get("consumerParams").and_then(|cp| cp.get("receipt")).is_some_and(js_truthy)
        });
        if !requires_receipt {
            continue;
        }
        let mut covered = false;
        for (qi, qa) in units.iter().enumerate() {
            if unit_depends_on(&deps, pi, qi) && has_plan_artifact_role(Some(qa), tools, "qa")? {
                covered = true;
                break;
            }
        }
        if !covered {
            return Ok(vec![diag("missing_publication_qa_receipt_tool", "invalid",
                "Each publication tool declaring artifactContract.consumerParams.receipt requires an upstream mechanical QA tool (artifactContract.role === \"qa\") producing toolArtifactReceipt. Add that tool to the publication unit's dependencies; an LLM QA step alone cannot produce the required receipt.".into())]);
        }
    }
    Ok(vec![])
}

fn non_empty_string_arg(args: &serde_json::Map<String, Value>, key: Option<&str>) -> bool {
    let Some(k) = key.filter(|s| !s.is_empty()) else {
        return false;
    };
    args.get(k)
        .and_then(Value::as_str)
        .is_some_and(|v| !js_trim(v).is_empty())
}

/// `reviewQaToolInputContract` — mechanical QA tool units must bind valid
/// `inputParams` (`content` + `assetsDir` or `html` + declared `bundleManifest`).
pub(super) fn review_qa_tool_input_contract(
    units: &[Value],
    tools: Option<&Value>,
) -> Result<Vec<Value>, String> {
    for unit in units {
        let Some(args) = prop(Some(unit), "toolArgs")?.and_then(Value::as_object) else {
            continue;
        };
        for c in selected_artifact_contracts(Some(unit), tools)? {
            if c.get("role").and_then(Value::as_str) != Some("qa") {
                continue;
            }
            let Some(names) = c.get("inputParams").and_then(Value::as_object) else {
                continue;
            };
            let content_key = names.get("content").and_then(Value::as_str);
            let html_key = names.get("html").and_then(Value::as_str);
            let manifest_key = names.get("manifest").and_then(Value::as_str);
            let assets_dir_key = names.get("assetsDir").and_then(Value::as_str);
            let has_content = non_empty_string_arg(args, content_key);
            let has_html = non_empty_string_arg(args, html_key);
            if has_content && has_html {
                return Ok(vec![diag("invalid_qa_tool_input_contract", "invalid",
                    "QA tool unit cannot pass both html and content inputs; pass content (content.json) + assetsDir (preferred) or html + declared bundleManifest.".into())]);
            }
            if has_html {
                let has_manifest = c.get("bundleManifest").is_some_and(js_truthy)
                    && non_empty_string_arg(args, manifest_key);
                if !has_manifest {
                    return Ok(vec![diag("invalid_qa_tool_input_contract", "invalid",
                        "QA tool unit passed html input without its declared bundleManifest argument; pass content (content.json) + assetsDir (preferred) or bind both html and the declared manifest argument.".into())]);
                }
            } else if has_content
                && assets_dir_key.is_some_and(|k| !k.is_empty())
                && !non_empty_string_arg(args, assets_dir_key)
            {
                return Ok(vec![diag("invalid_qa_tool_input_contract", "invalid",
                    "QA tool unit passed content input without its required assetsDir argument.".into())]);
            }
        }
    }
    Ok(vec![])
}

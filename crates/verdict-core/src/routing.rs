//! Port of resolveQualityVerdictRouting (server/src/services/quality-verdict-routing.ts).
//! `input` property reads go through crate::js_prop so a null/undefined `input`
//! throws the same V8 TypeError text the TS function produces. `reason` and
//! `failureType` pass through verbatim (`?? null` only collapses
//! missing/null); `requiredEvidenceSurfaces` is mapped through JS `trim` and
//! `filter(Boolean)` semantics.

use crate::{js_prop, js_trim, truthy};
use serde_json::{json, Value};

fn normalize_required_evidence_surfaces(surfaces: Option<&Value>) -> Result<Vec<String>, String> {
    // `if (!surfaces) return []` — falsy (missing/null/false/0/"") short-circuits.
    let Some(v) = surfaces else {
        return Ok(vec![]);
    };
    if !truthy(v) {
        return Ok(vec![]);
    }
    let Some(items) = v.as_array() else {
        return Err("surfaces.map is not a function".to_string());
    };
    let trimmed = items
        .iter()
        .map(|it| match it {
            // V8: null.trim() -> "Cannot read properties of null (reading 'trim')".
            Value::Null => Err("Cannot read properties of null (reading 'trim')".to_string()),
            _ => it
                .as_str()
                .map(|s| js_trim(s).to_string())
                .ok_or_else(|| "surface.trim is not a function".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(trimmed.into_iter().filter(|s| !s.is_empty()).collect())
}

pub fn resolve_quality_verdict_routing(input: Option<&Value>) -> Result<Value, String> {
    let verdict = js_prop(input, "verdict")?.and_then(Value::as_str);
    match verdict {
        Some("needs_evidence") => Ok(json!({
            "kind": "evidence",
            "reason": js_prop(input, "reason")?.cloned().unwrap_or(Value::Null),
            "requiredEvidenceSurfaces": normalize_required_evidence_surfaces(
                js_prop(input, "requiredEvidenceSurfaces")?,
            )?,
        })),
        Some(v @ ("fail" | "request_changes")) => Ok(json!({
            "kind": "correction",
            "verdict": v,
            "reason": js_prop(input, "reason")?.cloned().unwrap_or(Value::Null),
            "failureType": js_prop(input, "failureType")?.cloned().unwrap_or(Value::Null),
        })),
        _ => Ok(json!({ "kind": "none" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_kinds() {
        assert_eq!(
            resolve_quality_verdict_routing(Some(&json!({"verdict": "fail", "failureType": "t"})))
                .unwrap(),
            json!({"kind": "correction", "verdict": "fail", "reason": null, "failureType": "t"})
        );
        assert_eq!(
            resolve_quality_verdict_routing(Some(&json!({"verdict": "FAIL"}))).unwrap(),
            json!({"kind": "none"})
        );
        assert_eq!(
            resolve_quality_verdict_routing(Some(&json!(5))).unwrap(),
            json!({"kind": "none"})
        );
    }

    #[test]
    fn surfaces_and_errors() {
        assert_eq!(
            resolve_quality_verdict_routing(Some(
                &json!({"verdict": "needs_evidence", "requiredEvidenceSurfaces": [" x ", ""]})
            ))
            .unwrap(),
            json!({"kind": "evidence", "reason": null, "requiredEvidenceSurfaces": ["x"]})
        );
        assert_eq!(
            resolve_quality_verdict_routing(Some(
                &json!({"verdict": "needs_evidence", "requiredEvidenceSurfaces": [1]})
            ))
            .unwrap_err(),
            "surface.trim is not a function"
        );
        assert_eq!(
            resolve_quality_verdict_routing(Some(
                &json!({"verdict": "needs_evidence", "requiredEvidenceSurfaces": [null]})
            ))
            .unwrap_err(),
            "Cannot read properties of null (reading 'trim')"
        );
        assert_eq!(
            resolve_quality_verdict_routing(Some(
                &json!({"verdict": "needs_evidence", "requiredEvidenceSurfaces": ["\u{85}x\u{85}"]})
            ))
            .unwrap(),
            json!({"kind": "evidence", "reason": null, "requiredEvidenceSurfaces": ["\u{85}x\u{85}"]})
        );
        assert_eq!(
            resolve_quality_verdict_routing(None).unwrap_err(),
            "Cannot read properties of undefined (reading 'verdict')"
        );
    }
}

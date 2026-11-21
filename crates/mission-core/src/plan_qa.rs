//! Pure port of server/src/services/missions/mission-plan-qa.ts — the
//! deterministic plan-time QA checklist: reviewPlanAgainstIntent,
//! buildClarificationRequest, extractUnitRoles (plus the marker/topology/order
//! reviews they chain). Err(_) mirrors Node 24 V8 TypeError texts; outputs are
//! byte-parity with the TS returns.
#[path = "plan_qa_helpers.rs"]
mod helpers;
use crate::js::{js_to_string, js_trim, js_truthy};
use helpers::*;
use serde_json::{json, Map, Value};

pub const SUBCOMMANDS: &[&str] = &[
    "review-plan-against-intent",
    "build-clarification-request",
    "extract-unit-roles",
];

fn diag(code: &str, severity: &str, message: String) -> Value {
    json!({"code": code, "severity": severity, "message": message})
}

/// `reviewArtifactWorkProductMarkers` — publication units cannot opt out of
/// graphWorkProductRequired. `reviewDeliveryToolPreflightMarkers` is the TS
/// constant `[]` (no property reads) and stays inlined as such.
fn review_artifact_work_product_markers(
    units: &[Value],
    tools: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for u in units {
        if has_plan_artifact_role(Some(u), tools, "publication")?
            && prop(Some(u), "graphWorkProductRequired")? == Some(&Value::Bool(false))
        {
            out.push(diag("invalid_artifact_workproduct_marker", "invalid",
                "Publication units must register their result: graphWorkProductRequired cannot be false.".into()));
        }
    }
    Ok(out)
}

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
fn review_publication_verification_topology(
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

/// `reviewArtifactQaDeliveryOrder` — producer → artifact-QA → delivery order.
fn review_artifact_qa_delivery_order(
    intent: Option<&Value>,
    units: &[Value],
    tools: Option<&Value>,
) -> Result<Vec<Value>, String> {
    if falsy(prop(intent, "publish")?) {
        return Ok(vec![]);
    }
    let (mut delivery, mut producers, mut qa) = (Vec::new(), Vec::new(), Vec::new());
    for (i, u) in units.iter().enumerate() {
        if has_plan_artifact_role(Some(u), tools, "publication")? {
            delivery.push(i);
        }
    }
    if delivery.is_empty() {
        return Ok(vec![]);
    }
    for (i, u) in units.iter().enumerate() {
        let producer = classify_workflow_step_role(Some(u))? == "action"
            && prop(Some(u), "graphWorkProductRequired")? == Some(&Value::Bool(true));
        if producer && !has_plan_artifact_role(Some(u), tools, "publication")? {
            producers.push(i);
        }
    }
    if producers.is_empty() {
        return Ok(vec![]);
    }
    for (i, u) in units.iter().enumerate() {
        if classify_workflow_step_role(Some(u))? == "qa" {
            qa.push(i);
        }
    }
    if qa.is_empty() {
        return Ok(vec![diag("missing_artifact_qa_before_delivery", "invalid",
            "배포할 산출물을 만드는 plan 이지만 배포 전에 산출물 자체(내용/형식/필수 조건/근거/템플릿 적용 등)를 검증하는 QA unit 이 없습니다. 산출물 작성 후, 배포 전에 [QA] 산출물 검증 unit 을 추가하세요.".into())]);
    }
    let deps = build_dependency_index(units)?;
    let ordered = delivery.iter().all(|&d| {
        qa.iter().any(|&q| {
            unit_depends_on(&deps, d, q) && producers.iter().any(|&p| unit_depends_on(&deps, q, p))
        })
    });
    let reversed = producers
        .iter()
        .any(|&p| qa.iter().any(|&q| unit_depends_on(&deps, p, q)));
    if !ordered || reversed {
        return Ok(vec![diag("invalid_artifact_qa_delivery_order", "invalid",
            "산출물 배포 workflow 의 순서가 잘못되었습니다. 조건 확인/사전 조사 → 산출물 작성 → [QA] 산출물 자체 검증 → 배포 → 배포 readback/최종 QA 순서가 되도록 dependsOn 을 수정하세요.".into())]);
    }
    Ok(vec![])
}

/// `reviewPlanAgainstIntent` — marker reviews first, then intent-gated checks.
fn review_plan_against_intent(input: &Value) -> Result<Value, String> {
    if input.is_null() {
        return Err("Cannot destructure property 'intent' of 'input' as it is null.".into());
    }
    let intent = input.get("intent");
    let tools_owned = input.get("tools").cloned().unwrap_or_else(|| json!([]));
    let tools = Some(&tools_owned);
    let units: &[Value] = match input.get("selectedExecutionUnits") {
        Some(Value::Array(a)) => a,
        Some(Value::Null) => {
            return Err("Cannot read properties of null (reading 'flatMap')".into())
        }
        None => return Err("Cannot read properties of undefined (reading 'flatMap')".into()),
        Some(_) => return Err("units.flatMap is not a function".into()),
    };
    let mut diagnostics = review_artifact_work_product_markers(units, tools)?;
    diagnostics.extend(review_publication_verification_topology(units, tools)?);
    if falsy(prop(intent, "publish")?)
        && falsy(prop(intent, "audienceSplit")?)
        && falsy(prop(intent, "scenario")?)
    {
        return Ok(json!(diagnostics));
    }
    let mut roles = Vec::with_capacity(units.len());
    for u in units {
        roles.push(extract_unit_roles(Some(u), tools)?);
    }
    let has_role = |k: &str| roles.iter().any(|r| r.get(k) == Some(&Value::Bool(true)));
    if !falsy(prop(intent, "publish")?) {
        let publish_tokens = intent_signals_by_category(intent, "publish")?;
        let why = if !publish_tokens.is_empty() {
            format!("(선언된 역할: {})", js_join_opt(&publish_tokens, ", "))
        } else {
            "(게시 계약 필요)".to_string()
        };
        if !has_role("publish") {
            diagnostics.push(diag("missing_publish_unit", "invalid",
                format!("게시 계약이 필요하지만 {why} selectedExecutionUnits 에 publication 역할이 선언된 도구가 없습니다. 게시 도구를 명시적으로 선택하세요.")));
        } else if !has_post_delivery_readback_qa(units, tools)? {
            diagnostics.push(diag("missing_publish_readback_qa", "invalid",
                format!("게시/배포 unit 은 있으나 게시물 검증(QA/readback) unit 이 없습니다 {why}. 게시 후 산출물을 검증하는 [QA] unit 또는 readback 단계를 추가하세요.")));
        }
        diagnostics.extend(review_artifact_qa_delivery_order(intent, units, tools)?);
    }
    if !falsy(prop(intent, "audienceSplit")?) {
        let audiences = audiences_display(intent)?;
        if !has_role("audienceSplit") {
            diagnostics.push(diag("missing_audience_split", "needs_clarification",
                format!("Brief 가 복수 대상({audiences})을 구분하지만 selectedExecutionUnits/successCriteria 에 대상별 분기 근거가 없습니다. 각 대상별 가이드를 다루는 unit 또는 success criteria 를 추가하거나, 단일 대상으로 한정하려면 그 의도를 명시하세요.")));
        }
    }
    if !falsy(prop(intent, "scenario")?) && !has_role("scenario") {
        diagnostics.push(diag("missing_scenario_taxonomy", "needs_clarification",
            "Brief 가 상황별/케이스별 처리를 요구하지만 시나리오 taxonomy unit 또는 success criteria 가 없습니다. 상황별 케이스를 다루는 unit 이나 success criteria 를 추가하세요.".into()));
    }
    Ok(json!(diagnostics))
}

/// `intentContextForCode` — None models `undefined` (key dropped on stringify).
fn intent_context_for_code(
    code: Option<&str>,
    intent: Option<&Value>,
) -> Result<Option<Value>, String> {
    Ok(match code {
        Some("missing_audience_split") => prop(intent, "audiences")?.cloned(),
        Some("missing_scenario_taxonomy") => {
            Some(json!(intent_signals_by_category(intent, "scenario")?))
        }
        Some("missing_publish_unit") | Some("missing_publish_readback_qa") => {
            Some(json!(intent_signals_by_category(intent, "publish")?))
        }
        _ => Some(json!([])),
    })
}

/// `clarificationQuestionForCode` — per-code user question text.
fn clarification_question_for_code(
    code: Option<&str>,
    intent: Option<&Value>,
) -> Result<String, String> {
    Ok(match code {
        Some("missing_audience_split") => format!("복수 대상({}) 각각에 대한 가이드가 필요한가요, 아니면 단일 대상으로 한정할까요? 대상별 분기가 필요하면 각 대상을 다루는 unit/success criteria 를 추가해 주세요.", audiences_join(intent)?),
        Some("missing_scenario_taxonomy") => "상황별/케이스별 처리가 필요한가요? 그렇다면 다뤄야 할 시나리오 목록이나 상황별 success criteria 를 알려 주세요.".into(),
        Some("missing_publish_unit") => "산출물을 사이트에 게시/배포해야 하나요? 그렇다면 게시 대상을 확인해 게시 unit 을 추가해 주세요.".into(),
        Some("missing_publish_readback_qa") => "게시 후 산출물 검증(QA/readback)이 필요한가요? 그렇다면 검증 unit 을 추가해 주세요.".into(),
        _ => "계획에 누락된 항목이 있는지 확인해 주세요.".into(),
    })
}

/// `buildClarificationRequest` — needs_clarification diagnostics → questions.
fn build_clarification_request(input: &Value) -> Result<Value, String> {
    if input.is_null() {
        return Err("Cannot destructure property 'intent' of 'input' as it is null.".into());
    }
    let intent = input.get("intent");
    let arr = crate::revision_delta::iter_values(
        prop(Some(input), "diagnostics")?.unwrap_or(&Value::Null),
        "input.diagnostics",
    )?;
    let mut questions = Vec::new();
    for d in &arr {
        if prop(Some(d), "severity")?.and_then(Value::as_str) != Some("needs_clarification") {
            continue;
        }
        let code = prop(Some(d), "code")?;
        let code_str = code.and_then(Value::as_str);
        let intent_context = intent_context_for_code(code_str, intent)?;
        let mut q = Map::new();
        if let Some(c) = code {
            q.insert("code".into(), c.clone());
        }
        if let Some(ic) = intent_context {
            q.insert("intentContext".into(), ic);
        }
        q.insert(
            "question".into(),
            json!(clarification_question_for_code(code_str, intent)?),
        );
        questions.push(Value::Object(q));
    }
    Ok(json!(questions))
}

pub fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "review-plan-against-intent" => review_plan_against_intent(&input),
        "build-clarification-request" => build_clarification_request(&input),
        "extract-unit-roles" => {
            if input.is_null() {
                return Err("Cannot read properties of null (reading 'unit')".into());
            }
            let tools = input.get("tools").cloned().unwrap_or_else(|| json!([]));
            extract_unit_roles(input.get("unit"), Some(&tools))
        }
        _ => Err(format!("unknown subcommand: {subcommand}")),
    }
}

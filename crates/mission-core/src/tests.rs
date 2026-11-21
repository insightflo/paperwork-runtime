use super::*;
use serde_json::Map;

fn run(sub: &str, payload: &str) -> Result<Value, String> { dispatch(sub, payload.as_bytes()) }
fn ok(sub: &str, payload: &str) -> Value { run(sub, payload).unwrap() }
fn codes(out: &Value) -> Vec<&str> {
    out["diagnostics"].as_array().unwrap().iter().filter_map(|d| d["code"].as_str()).collect()
}

#[test]
fn js_shim_semantics() {
    assert_eq!(js::read_string(&json!("  a\u{feff} ")), Some("a".to_string()));
    assert_eq!(js::read_string(&json!(" \u{00a0} ")), None);
    assert_eq!(js::read_string(&json!(7)), None);
    assert!(js::valid_string_array(&json!([])));
    assert!(!js::valid_string_array(&json!(["a", 1])));
    assert_eq!(js::unique(vec!["x", "y", "x"]), vec!["x", "y"]);
    assert!(!js::js_truthy(&json!("")) && !js::js_truthy(&json!(0)) && js::js_truthy(&json!([])));
    assert_eq!(js::js_spread(&json!(["a", "b"]))["0"], json!("a"));
    assert_eq!(js::js_spread(&json!(null)), Map::new());
}

#[test]
fn normalize_merges_alias_forms_draft_targets_and_passthrough() {
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"a","unitId":"legacy-a","sourceRef":{"id":"src-a"}},
        {"id":"b","dependsOn":["legacy-a"]},
        {"id":"c","after":["b"],"dependencies":["a","a"]},
        {"id":"d"},
        {"id":"e","kind":"oversight","dependencies":["d"]}],
        "draftSteps":[
            {"unitId":"d","dependencies":["c"]},
            {"units":[],"unitId":"b","dependsOn":["a"]},
            {"units":["e"],"dependsOn":["c"]},
            "plain step", {"id":"note","title":"x"}, 7, ["x","y"]]}"#);
    assert_eq!(out["ok"], json!(true));
    let g = &out["graph"];
    assert_eq!(g["dependencyIndex"], json!([[], [0], [0, 1], [2], [3, 2]]));
    assert_eq!(g["units"][1]["dependencies"], json!(["a"]));
    assert_eq!(g["units"][1]["dependsOn"], Value::Null);
    assert_eq!(g["units"][2]["after"], Value::Null);
    assert_eq!(g["materializedDependencyIndex"], json!([[], [0], [0, 1], [2]]));
    assert_eq!(g["draftSteps"][0], json!({"unitId": "d", "dependencies": ["c"]}));
    assert_eq!(g["draftSteps"][1], json!({"units": [], "unitId": "b", "dependencies": ["a"]}));
    assert_eq!(g["draftSteps"][2]["units"], json!(["e"]));
    assert_eq!(g["draftSteps"][3], json!("plain step"));
    assert_eq!(g["draftSteps"][4], json!({"id": "note", "title": "x"}));
    assert_eq!(g["draftSteps"][5], json!({}));
    assert_eq!(g["draftSteps"][6], json!({"0": "x", "1": "y"}));
}

#[test]
fn normalize_diagnostics_cover_policy_shapes_refs_and_cycles() {
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"deliveryVerification":{},"dependsOn":[]},{"id":"dup"},{"id":"dup"},{}],
        "draftSteps":[{"capAcceptance":null}]}"#);
    assert_eq!(codes(&out), [
        "board_only_plan_policy", "board_only_plan_policy",
        "missing_unit_id", "missing_unit_id", "duplicate_unit_id"]);
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"a","dependencies":"x"},{"id":"b","dependsOn":[1,"c"]},{"id":"c","after":null}],
        "draftSteps":[{"units":"nope","dependsOn":["a"]},{"unitId":5,"after":["a"]}]}"#);
    assert_eq!(codes(&out), [
        "invalid_dependency_shape", "invalid_dependency_shape", "invalid_dependency_shape",
        "invalid_dependency_shape", "unresolved_dependency_target_ref",
        "invalid_dependency_shape", "unresolved_dependency_target_ref"]);
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"a","sourceRef":{"id":"s"}},{"id":"b","sourceRef":{"id":"s"}},
        {"id":"c","dependencies":["s","ghost","a"]}]}"#);
    assert_eq!(codes(&out), ["ambiguous_dependency_ref", "unresolved_dependency_ref"]);
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"a","dependencies":["c"]},{"id":"b","dependencies":["a"]},
        {"id":"c","dependencies":["b"]},{"id":"d","dependencies":["d"]}]}"#);
    assert_eq!(codes(&out), ["self_dependency", "dependency_cycle"]);
    assert_eq!(out["diagnostics"][1]["message"], json!("Plan dependency cycle detected: a -> c -> b -> a."));
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"a","dependencies":["o"]},{"id":"o","kind":"oversight"}]}"#);
    assert_eq!(codes(&out), ["materialized_dependency_on_filtered_unit"]);
    let out = ok("normalize-dependency-graph", r#"{"units":[
        {"id":"w"},{"id":"o","kind":"oversight","dependencies":["w"]}]}"#);
    assert_eq!(out["ok"], json!(true));
}

#[test]
fn materialized_and_remap_dispatch() {
    let mat = |extra: &str| ok("is-unit-materialized", &format!("{{\"unit\":{{\"id\":\"u\"{extra}}}}}"));
    assert_eq!(mat(""), json!(true));
    assert_eq!(mat(r#","type":"oversight","triggerOn":"escalation""#), json!(false));
    assert_eq!(mat(r#","type":"oversight""#), json!(true));
    assert_eq!(mat(r#","kind":"  Oversight ""#), json!(false));
    assert_eq!(mat(r#","type":"tool","qaType":"structural","kind":"oversight","triggerOn":"escalation""#), json!(true));
    assert_eq!(mat(r#","sourceRef":{"type":"cross_company_mission_request"}"#), json!(false));
    assert!(run("is-unit-materialized", r#"{"unit":null}"#).is_err());
    let out = ok("remap-to-step-ids", r#"{"units":[{"id":"a"},{"id":"b","dependencies":["a"]},{"id":"c","dependencies":["b"]}],"stepIds":["s1","s2","s3"]}"#);
    assert_eq!(out, json!([[], ["s1"], ["s2"]]));
    assert!(run("remap-to-step-ids", r#"{"units":[{"id":"a"}],"stepIds":[]}"#).unwrap_err().contains("equal length"));
    assert!(run("remap-to-step-ids", r#"{"units":[{"id":"a","dependencies":["ghost"]}],"stepIds":["s1"]}"#).unwrap_err().contains("ghost"));
}

#[test]
fn operator_card_summary_dispatch() {
    let card =
        |p: &str| operator_card_summary::dispatch("format-operator-decision-summary", p.as_bytes());
    let out = card(r#"{"decision":"escalate","reason":"blocked"}"#).unwrap();
    assert!(out.starts_with('"')
        && out.contains("증상: 미션 진행이 중단되었습니다")
        && out.contains("blocked"));
    let payload = serde_json::to_string(&json!({
        "decision": "escalate",
        "reason": "### Mission owner decision\nDecision: replan_mission\nReason: deep cause\nNext action: replan\nEvidence: /issues/42"
    }))
    .unwrap();
    let out = card(&payload).unwrap();
    assert!(out.contains("deep cause") && out.contains("/issues/42") && !out.contains("Decision:"));
    let reason = format!("{}🚀{}", "a".repeat(199), "tail");
    let payload =
        format!(r#"{{"decision":"escalate","reason":{}}}"#, js::js_json_stringify(&json!(reason)));
    assert!(card(&payload).unwrap().contains("\\ud83d"));
    // Kelvin U+212A / long-s U+017F must not fold into the ASCII blocker
    // label: JS non-unicode i-flag never folds a char >= 128 to ASCII.
    let kelvin = "mission bloc\u{212a}er escalated: real reason here";
    let p = format!(r#"{{"decision":"escalate","reason":{}}}"#, js::js_json_stringify(&json!(kelvin)));
    assert!(card(&p).unwrap().contains(kelvin));
    let p = format!(
        r#"{{"decision":"escalate","reason":"ok","nextAction":{}}}"#,
        js::js_json_stringify(&json!(kelvin))
    );
    assert!(card(&p).unwrap().contains(kelvin));
    let longs = "mi\u{17f}\u{17f}ion blocker escalated: real reason here";
    let p = format!(r#"{{"decision":"escalate","reason":{}}}"#, js::js_json_stringify(&json!(longs)));
    assert!(card(&p).unwrap().contains(longs));
    let out = card(r#"{"decision":"escalate","reason":"Mission blocker escalated: gone"}"#).unwrap();
    assert!(out.contains("gone") && !out.contains("blocker"));
    assert_eq!(card(r#"{"reason":5}"#).unwrap_err(), "text.toLowerCase is not a function");
    assert_eq!(card("null").unwrap_err(), "Cannot read properties of null (reading 'reason')");
    assert!(operator_card_summary::dispatch("nope", b"{}").is_err());
}

#[test]
fn dispatcher_fails_closed() {
    assert!(run("nope", "{}").is_err());
    assert!(run("normalize-dependency-graph", "not json").is_err());
    assert!(run("normalize-dependency-graph", r#"{"draftSteps":[]}"#).is_err());
    assert!(run("normalize-dependency-graph", r#"{"units":[],"draftSteps":null}"#).is_err());
    assert!(run("normalize-dependency-graph", r#"{"units":[null]}"#)
        .unwrap_err().contains("Cannot convert undefined or null to object"));
    let out = ok("normalize-dependency-graph", r#"{"units":[]}"#);
    assert_eq!(out["ok"], json!(true));
}

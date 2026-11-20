//! [파일 목적] qa-source-defect-card-historical.ts 1:1 포트 — pre-#329 오너 결정 카드 빌더.
//!   카드는 serde_json::Value 로 조립하고, JS slice(0,n) 만 UTF-16 코드유닛 절단으로
//!   재현한다 — 경계에서 서로게이트 쌍이 갈라지면 String 으로 표현 불가하므로 sentinel
//!   자리표시를 심은 뒤 직렬화 텍스트에서 \uXXXX 이스케이프로 교체한다.
//! [parity] 정렬은 Node 기본 로케일(LC_ALL > LANG, C/POSIX·미설정 → en-US)의 ICU
//!   collation(localeCompare). 빈 findings 도 every() 가 true 라 sourceOnly — 분기 동일.
//!   비문자열 finding.id/qaStepId 는 비교자가 실제 호출되는 2개 이상일 때만 TS TypeError → Err.
//!   promotedFindingIds 는 `new Set` 의미론: 배열 요소/문자열 char, SameValueZero 매칭.
//! [외부 연결] main.rs 서브커맨드 "qa-defect-card-historical". js_value 헬퍼 재사용.

use crate::js_value::{js_str, strict_eq};
use icu_collator::options::CollatorOptions;
use icu_collator::CollatorBorrowed;
use icu_locale_core::{locale, Locale};
use serde_json::{json, Map, Value};
use std::env;
use std::fmt::Write as _;
use std::sync::OnceLock;

/// JS s.slice(0,n) 결과를 JSON 텍스트에 심는다 — 쌍이 온전하면 일반 String 반환,
///   갈라지면 sentinel 자리표시를 넣고 실제 \uXXXX 이스케이프 문자열을 tags 에 적재.
struct Cutter {
    sent: String,
    tags: Vec<String>,
}
impl Cutter {
    fn cut(&mut self, s: &str, n: usize) -> String {
        let units: Vec<u16> = s.encode_utf16().take(n).collect();
        match String::from_utf16(&units) {
            Ok(v) => v,
            Err(_) => {
                self.tags.push(esc16(&units));
                format!("{}{}", self.sent, self.tags.len() - 1)
            }
        }
    }
    fn finish(self, mut out: String) -> String {
        for (i, esc) in self.tags.iter().enumerate() {
            // 같은 sentinel 이 옵션 facts clone 으로 여러 번 복제될 수 있으므로 전부 교체.
            out = out.replace(&format!("\"{}{i}\"", self.sent), esc);
        }
        out
    }
}

const ESC: &[(u16, &str)] = &[
    (0x22, "\\\""),
    (0x5c, "\\\\"),
    (0x08, "\\b"),
    (0x09, "\\t"),
    (0x0a, "\\n"),
    (0x0c, "\\f"),
    (0x0d, "\\r"),
];

/// u16 시퀀스를 따옴표 포함 JSON 문자열 리터럴로 — lone surrogate 도 \uXXXX 로 출력해
///   JSON.parse 시 원래 JS 문자열(쌍 절단 상태)과 동일하게 복원된다.
fn esc16(units: &[u16]) -> String {
    let mut o = String::from("\"");
    for &u in units {
        if let Some(&(_, e)) = ESC.iter().find(|&&(c, _)| c == u) {
            o.push_str(e);
        } else if u < 0x20 || (0xd800..=0xdfff).contains(&u) {
            let _ = write!(o, "\\u{u:04x}");
        } else {
            o.push(char::from_u32(u32::from(u)).unwrap_or('\u{fffd}'));
        }
    }
    o.push('"');
    o
}

/// 입력 값 전체에서 sentinel 부분문자열 탐색 — 자리표시가 진짜 콘텐츠와 절대 충돌하지 않도록.
fn deep_contains(v: &Value, needle: &str) -> bool {
    match v {
        Value::String(s) => s.contains(needle),
        Value::Array(a) => a.iter().any(|e| deep_contains(e, needle)),
        Value::Object(m) => {
            m.keys().any(|k| k.contains(needle)) || m.values().any(|e| deep_contains(e, needle))
        }
        _ => false,
    }
}

/// Node 디폴트 로케일 해석: LC_ALL > LANG (빈 값 건너뜀), C/POSIX·미설정·파싱 실패 → en-US.
fn default_locale() -> Locale {
    for key in ["LC_ALL", "LANG"] {
        let Ok(v) = env::var(key) else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        let tag = v
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .replace('_', "-");
        return match tag.as_str() {
            "" | "C" | "POSIX" => locale!("en-US"),
            _ => tag.parse().unwrap_or(locale!("en-US")),
        };
    }
    locale!("en-US")
}

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLL: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLL.get_or_init(|| {
        CollatorBorrowed::try_new(default_locale().into(), CollatorOptions::default())
            .or_else(|_| {
                CollatorBorrowed::try_new(locale!("en-US").into(), CollatorOptions::default())
            })
            .expect("icu collator compiled data unavailable")
    })
}

/// JS truthiness — null/absent/false/±0/"" 만 거짓.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// SameValueZero — strict_eq 에 NaN=NaN 동치만 얹은 Set.has 의미론.
fn svz(a: &Value, b: &Value) -> bool {
    strict_eq(a, b)
        || matches!((a, b), (Value::Number(x), Value::Number(y))
            if x.as_f64().is_some_and(|f| f.is_nan()) && y.as_f64().is_some_and(|f| f.is_nan()))
}

/// `[...list].sort(localeCompare)` — 비교자는 len>=2 에서만 호출되므로 그때만 비문자열 키 검사.
fn sort_checked<T>(
    list: &mut [T],
    err: &str,
    key: impl Fn(&T) -> &Option<Value>,
) -> Result<(), String> {
    if list.len() < 2 {
        return Ok(());
    }
    if list
        .iter()
        .any(|v| !matches!(key(v), Some(Value::String(_))))
    {
        return Err(format!("{err}.localeCompare is not a function"));
    }
    list.sort_by(|a, b| {
        collator().compare(
            key(a).as_ref().and_then(Value::as_str).unwrap_or(""),
            key(b).as_ref().and_then(Value::as_str).unwrap_or(""),
        )
    });
    Ok(())
}

struct F(Option<Value>, Option<Value>, Option<Value>); // finding: id, layer, summary
struct R(Option<Value>, Option<Value>); // qaRef: qaStepId, qaIssueId

/// 서브커맨드 본체 — 카드 입력 JSON → 카드 JSON 텍스트. 아래 함수는 TS 리터럴과
///   같은 배치를 유지하도록 dense 표기를 의도적으로 쓴다(rustfmt skip).
#[rustfmt::skip]
pub fn historical_card(raw: &[u8]) -> Result<String, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let arr = |k: &str| input.get(k).and_then(Value::as_array).ok_or_else(|| format!("input.{k} is not iterable"));
    let mut findings: Vec<F> = arr("findings")?.iter().map(|f| F(f.get("id").cloned(), f.get("layer").cloned(), f.get("summary").cloned())).collect();
    let mut refs: Vec<R> = arr("qaRefs")?.iter().map(|r| R(r.get("qaStepId").cloned(), r.get("qaIssueId").cloned())).collect();
    sort_checked(&mut findings, "finding.id", |f| &f.0)?;
    sort_checked(&mut refs, "ref.qaStepId", |r| &r.0)?;
    let promoted: Vec<Value> = match input.get("promotedFindingIds") { // new Set — 배열 요소/문자열 char
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(t)) => t.chars().map(|c| Value::String(c.to_string())).collect(),
        Some(_) => return Err("promotedFindingIds is not iterable".into()),
    };
    let marked = |f: &F| f.0.as_ref().is_some_and(|i| promoted.iter().any(|p| svz(p, i)));
    let badge = |f: &F| format!("{}{}", js_str(f.1.as_ref()), if marked(f) { "*" } else { "" });
    let is_src = |f: &F| matches!(&f.1, Some(Value::String(v)) if v == "source_data");
    let source_only = findings.iter().all(&is_src);
    let promoted_count = findings.iter().filter(|f| marked(f)).count();
    let findings_lines: Vec<String> = findings.iter().map(|f| format!("- [{}] ({}) {}", badge(f), js_str(f.0.as_ref()), js_str(f.2.as_ref()))).collect();
    let qa_list = refs.iter().map(|r| {
        let mut l = format!("- QA step `{}`", js_str(r.0.as_ref()));
        if truthy(r.1.as_ref()) { let _ = write!(l, " (issue {})", js_str(r.1.as_ref())); }
        l
    }).collect::<Vec<_>>().join("\n");
    let run_s = js_str(input.get("workflowRunId"));
    let step_s = js_str(input.get("producerStepId"));
    let iter_s = js_str(input.get("iteration"));
    let max_s = js_str(input.get("maxIterations"));
    let sent = (0xe000u32..=0xe0ff).filter_map(char::from_u32).map(|c| format!("{c}s6b"))
        .find(|c| !deep_contains(&input, c)).ok_or_else(|| "sentinel collision".to_string())?;
    let mut ct = Cutter { sent, tags: vec![] };

    let mut layer_parts = vec![if findings.is_empty() { "미제출(구버전 판정)" } else if source_only { "전부 source_data(원천 데이터 결함)" } else { "혼합(artifact + source_data)" }.to_string()];
    if promoted_count > 0 { layer_parts.push(format!("재발 승격 {promoted_count}건(직전 반려 같은 finding id 재발)")); }
    let mut facts = vec![
        json!({"label":"결함 계층","value":layer_parts.join(" — "),"status":"known"}),
        json!({"label":"생산자 rework 상태","value":format!("iteration {iter_s}/{max_s}{}", if source_only { " (원천 라우팅은 한도 미소모)" } else { "" }),"status":"known"}),
    ];
    facts.extend(findings.iter().take(8).map(|f| json!({
        "label": ct.cut(&format!("결함 {}", js_str(f.0.as_ref())), 80),
        "value": ct.cut(&format!("[{}] {}", badge(f), js_str(f.2.as_ref())), 200),
        "status": "known",
    })));
    let ev: Vec<Value> = refs.iter().filter(|r| truthy(r.1.as_ref())).take(10).map(|r| json!({
        "label": format!("QA 반려 이슈 ({})", js_str(r.0.as_ref())),
        "href": format!("/issues/{}", js_str(r.1.as_ref())),
    })).collect();
    let option = |id: &str, label: &str, desc: &str| json!({"id":id,"label":label,"description":desc,"facts":facts.clone(),"evidenceRefs":ev.clone()});

    let joined = findings_lines.join("\n");
    let desc_src = if joined.is_empty() { "findings 미제출(구버전 판정 — cap 소진 경로)" } else { joined.as_str() };
    let ev_href = refs.iter().find(|r| truthy(r.1.as_ref())).map(|r| js_str(r.1.as_ref())).unwrap_or_else(|| step_s.clone());
    let mut interp: Vec<String> = vec![
        "QA가 공식 verdict API(request_changes)로 제출한 결함 계층 태그 기준입니다.".into(),
        if source_only { "모든 findings가 source_data(원천 데이터 결함)로 분류되었습니다 — 생산자(리포트 materialize)가 고칠 수 없는 결함이므로 자동 재작업을 돌리지 않고 즉시 오너 판단을 요청합니다." } else { "findings에 산출물(artifact) 계층이 포함되어 있거나 구버전 판정입니다 — 기존 재작업/cap 경로와 병행하여 오너 판단을 요청합니다." }.into(),
        "".into(), "결함 항목:".into(),
    ];
    if findings_lines.is_empty() { interp.push("- (findings 미제출)".into()); } else { interp.extend(findings_lines.iter().cloned()); }
    interp.extend(["".into(), format!("반려 QA: {}", if qa_list.is_empty() { "(unknown)" } else { &qa_list })]);
    let kind = if source_only { "원천 데이터" } else if findings.iter().any(&is_src) { "원천+산출물" } else { "산출물" };
    let mut desc: Vec<String> = vec![
        "## QA 반려 계층 라우팅 — 오너 결정 필요".into(), "".into(),
        format!("Producer: step `{step_s}` (iteration {iter_s}/{max_s})"),
        format!("Workflow run: {run_s}"), "".into(),
        "QA가 반려(request_changes)했고, 결함 계층 태그(findings)에 따라 오너 조치가 필요합니다.".into(), "".into(), "결함 항목:".into(),
    ];
    if findings_lines.is_empty() { desc.push("- (findings 미제출 — cap 소진 경로)".into()); } else { desc.extend(findings_lines.iter().cloned()); }
    desc.extend(["".into(), "반려 QA:".into(), if qa_list.is_empty() { "- (unknown)".into() } else { qa_list }, "".into(),
        "### 선택 후 실행 방법".into(),
        "카드 해결 시 linkIssue assignee(mission owner agent)가 wake 됩니다. 오너 에이전트는 선택된 옵션에 따라 기존 실행 API로 진행합니다:".into(),
        "- 원천 수집 재실행 → 수집 스텝 이슈 재시도(retry_source_issue, 수집 이슈 대상)".into(),
        "- 생산자 재작업 추가 → 재작업 한도 +1(qaReworkCapBoost) 후 retry_source_issue(생산자 이슈 대상)".into(),
        "- 유지보수 이관 → 유지보수 이슈 생성(결함 findings 근거 첨부)".into(),
        "- 미션 재계획 → replan_mission".into(),
        "Comments and markers are display-only and cannot authorize execution.".into()]);

    let definition = json!({
        "options": [
            option("rerun_source_collection","원천 수집 재실행","수집(collect) 계열 원천 스텝의 산출물이 결함의 원인입니다. 수집 스텝 이슈를 재실행(retry)해 원천 데이터를 다시 생성한 뒤 파이프라인이 이어지도록 지시합니다."),
            option("extra_producer_rework","생산자 재작업 1회 추가",&format!("QA 반려가 산출물(artifact) 결함으로 판단되면 생산자 재작업을 1회 더 허용합니다. 재작업 한도 +1(qaReworkCapBoost) 부여 후 생산자 이슈 재작업을 지시합니다. 현재 iteration {iter_s}/{max_s}.")),
            option("maintenance_issue","[유지보수] 이슈 생성","원천 데이터 결함이 코드/스킬/수집 파이프라인 수준의 근본 원인으로 의심되면 유지보수(maintenance) 트랙으로 이관합니다. 결함 findings를 근거로 유지보수 이슈를 생성합니다."),
            option("replan_mission","미션 재계획","현재 접근으로는 완수할 수 없다고 판단되면 미션을 재계획(replan_mission)합니다."),
            option("cancel","취소","조치 없이 카드를 닫습니다. 런은 현재 상태(failed/대기)로 유지됩니다."),
        ],
        "actions": [
            {"id":"submit","label":"결정 제출","outcome":"submit","tone":"primary","requiresSelection":true},
            {"id":"dismiss","label":"카드 닫기","outcome":"hold","tone":"neutral","requiresSelection":false},
        ],
        "selection": {"min":1,"max":1},
        "comment": {"mode":"optional","label":"메모","placeholder":"결정 근거나 오너 에이전트에 전달할 지시를 남길 수 있습니다","maxLength":2000},
        "approvedScope": ["operator_decision.resolve"],
        "forbiddenScope": ["auto_retry","producer_auto_rework"],
        "humanReview": {
            "schemaVersion":"human-review-v1",
            "decisionSubject":"QA 반려 계층 라우팅 — 원천 데이터 결함에 대한 오너 조치 선택",
            "evidence":[{"label":"QA 구조화 판정(findings)","href":format!("/issues/{ev_href}"),"location":format!("workflow run {run_s} / producer {step_s}"),"description":ct.cut(desc_src,1000)}],
            "interpretation":ct.cut(&interp.join("\n"),4000),
            "impact":{"ifApproved":"선택한 옵션대로 오너 에이전트가 기존 실행 API(수집 재시도 / 재작업 승인 / 유지보수 이관 / 재계획)로 진행합니다.","ifRejected":"카드를 닫으면 런은 현재 상태로 유지되며 자동 재시도는 일어나지 않습니다.","ifWrong":"원천이 정상인데 수집을 재실행하면 세대가 낭비되고, 산출물 결함인데 수집만 재실행하면 같은 반려가 반복됩니다."},
            "unresolvedFacts":if findings.is_empty() { vec![json!("QA가 findings를 제출하지 않았습니다 — 계층 분류 없이 cap 소진으로만 판단됩니다.")] } else { vec![] },
            "questions":[if source_only { "원천 수집 스텝 재실행으로 결함이 해소될 것으로 보이는가, 유지보수 이관이 필요한 근본 원인인가?" } else { "산출물 계층 결함이 생산자 재작업으로 해소 가능한가?" }],
            "recommendedNextStep":if source_only { "원천 수집 재실행(rerun_source_collection) 권장 — 생산자 재작업은 원천 결함을 고치지 못합니다." } else { "생산자 재작업 1회 추가(extra_producer_rework) 또는 미션 재계획(replan_mission) 검토." },
            "requiredReviewer":"human-operator",
        },
    });

    let mut sc = Map::new();
    if let Some(m) = input.get("missionId") { sc.insert("missionId".into(), m.clone()); }
    sc.insert("workflowId".into(), Value::Null);
    if let Some(r) = input.get("workflowRunId") { sc.insert("workflowRunId".into(), r.clone()); }
    sc.insert("artifactRefs".into(), json!([]));
    let mut card = json!({
        "schemaVersion": 1,
        "requestKey": format!("qa-source-defect:{run_s}:{step_s}:{iter_s}"),
        "priority": "high",
        "interactionType": "single_select",
        "title": ct.cut(&format!("QA 반려 {kind} 결함 — 오너 결정 필요 ({step_s} iter {iter_s})"), 200),
        "description": ct.cut(&desc.join("\n"), 4000),
        "sourceType": "workflow_qa_rejection",
        "sourceId": ct.cut(&format!("{run_s}:{step_s}:{iter_s}"), 200),
        "sourceContext": Value::Object(sc),
        "definition": definition,
    });
    if let Some(i) = input.get("linkIssueId") { card["issueId"] = i.clone(); }
    card["continuationMode"] = json!(if truthy(input.get("linkIssueId")) { "issue_current_assignee" } else { "none" });
    Ok(ct.finish(serde_json::to_string(&card).map_err(|e| e.to_string())?))
}

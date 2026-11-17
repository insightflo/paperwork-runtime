// [원인 해석 레지스트리 2026-11-17] 사람 카드 '쉬운 해석'의 원인 해석 회귀 테스트.
// - 레지스트리: 각 패턴 계열 매칭·우선순위(구조화 > 타임아웃 충돌)·null 폴백.
// - 카드 빌더: 매칭 reason → 원인 문장이 첫 문장, 없음/미매치 → 기존 문장 불변.
// - 해시 대조 계약: 얼린 원본 본체·pre-failure-cause 현행 변형이 후보 목록에 남아
//   패턴에 맞는 사유를 가진 구형/직전 pending 카드가 409 로 깨지지 않는다.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { interpretFailureCause, interpretTargetFailureStatusSentence,
  withFailureCauseInterpretation } from "../services/failure-interpretation.js";
import { buildMissionOwnerHumanInputDecisionCard,
  buildPreFailureCauseMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec } from "../services/missions/mission-owner-human-input-card.js";
import { buildLegacyMissionOwnerHumanInputDecisionCardVariants,
  buildPreCompactMissionOwnerHumanInputDecisionCard,
  buildStage1CompactMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card-precompact.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";

const GATEWAY = "중계 구간(게이트웨이) 오류입니다 — 뒷단 서비스의 일시 장애일 수 있고, 원인이 가려질 수 있으니 서비스 상태를 확인하세요.";
const TIMEOUT = "대상이 시간 내에 응답하지 못했습니다(시간 초과) — 일시적인 느림이나 장애일 수 있으니 잠시 후 재시도를 고려하세요.";
const CONNECTION = "대상 서비스에 연결하지 못했습니다(네트워크/DNS 문제) — 상대 서비스 상태를 확인하세요.";
const AUTH = "권한이 없거나 접근이 거부되었습니다 — 자격증명·권한 설정을 확인하세요.";
const NOT_FOUND = "수집 대상 주소는 없는 페이지입니다(404). 재시작으로는 해결되지 않습니다 — 입력 주소를 확인·수정한 뒤 다시 시도하세요.";
const SHAPE = "응답 내용이 예상 형식과 다릅니다 — 페이지 구조나 계약이 바뀌었을 수 있으니 확인하세요.";
const GATEWAY_REASON = "scrapling-dynamic-fetch: remote endpoint returned status 502 — bad gateway";

describe("interpretFailureCause registry", () => {
  it("interprets structured target-failure JSON (whole text and embedded in prose)", () => {
    const json = JSON.stringify({ error: "target fetch failed", message: "target returned HTTP 404",
      url: "https://example.com/page", targetStatus: 404 });
    expect(interpretFailureCause(json)).toBe(NOT_FOUND);
    const embedded = `Workflow tool "fetch" remote endpoint returned status 424: ${json}`;
    expect(interpretFailureCause(embedded)).toBe(NOT_FOUND);
    const fivexx = JSON.stringify({ error: "target fetch failed", url: "https://x.test", targetStatus: 503 });
    expect(interpretFailureCause(fivexx)).toBe("대상 사이트 자체 오류(503)입니다. 잠시 후 재시도를 고려하세요.");
  });

  it.each([
    ["deadline exceeded while fetching", TIMEOUT],
    ["upstream call failed with ETIMEDOUT", TIMEOUT],
    ["request timed out after 30s", TIMEOUT],
    ["connect ECONNREFUSED 10.0.0.1:443", CONNECTION],
    ["getaddrinfo ENOTFOUND example.test", CONNECTION],
    ["EAI_AGAIN during DNS lookup", CONNECTION],
    ["502 Bad Gateway from edge", GATEWAY],
    ["scrapling-dynamic-fetch status 502 bad gateway", GATEWAY],
    ["origin_bad_gateway", GATEWAY],
    ["503 Service Unavailable", GATEWAY],
    ["401 Unauthorized", AUTH],
    ["HTTP status 403 Forbidden", AUTH],
    ["remote endpoint returned status 404", NOT_FOUND],
    ["selector matched no elements", SHAPE],
    ["remote endpoint returned a non-JSON response", SHAPE],
    ["remote response is missing required fields", SHAPE],
  ])("interprets %s", (text, expected) => {
    expect(interpretFailureCause(text)).toBe(expected);
  });

  it("lets the structured diagnostic win over a generic timeout pattern", () => {
    const text = `fetch timed out: {"error":"target fetch failed","url":"https://x.test","targetStatus":404}`;
    expect(interpretFailureCause(text)).toBe(NOT_FOUND);
  });

  it("returns null for unrelated or empty text", () => {
    expect(interpretFailureCause("미션 진행이 멈춰 사람의 방향 결정이 필요합니다.")).toBeNull();
    expect(interpretFailureCause("heartbeat 429 쿼터 초과")).toBeNull();
    expect(interpretFailureCause("")).toBeNull();
  });
});

describe("withFailureCauseInterpretation", () => {
  it("prepends the cause line when a pattern matches", () => {
    expect(withFailureCauseInterpretation({ reason: GATEWAY_REASON }, "진행 안내 문장"))
      .toBe(`${GATEWAY}\n진행 안내 문장`);
  });
  it("keeps the base sentence when nothing matches", () => {
    expect(withFailureCauseInterpretation({ reason: "승인이 필요합니다" }, "진행 안내 문장"))
      .toBe("진행 안내 문장");
    expect(withFailureCauseInterpretation({}, "진행 안내 문장")).toBe("진행 안내 문장");
  });
});

// ---------- 카드 빌더 결합 ----------
function spec(overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec {
  return {
    companyId: randomUUID(), missionId: randomUUID(), decisionEventId: randomUUID(),
    decision: "request_input", ownerActionIssueId: randomUUID(), ownerActionIssueStatus: "in_progress",
    requestedByAgentId: randomUUID(), reason: "사람 승인이 필요합니다",
    nextAction: "운영자 승인 후 다음 단계를 진행해 주세요", evidence: "근거 원문",
    issueTitle: "Owner oversight", issueIdentifier: "RES-1", sourceIssueId: null, workflowRunId: null,
    structuredOptions: [
      { id: "retry-revised-input", label: "입력 수정 후 재시도" },
      { id: "replan-mission", label: "재계획" },
    ],
    ...overrides,
  };
}
const OPTION_DERIVED = "자동 복구 경로가 더 이상 남아 있지 않아 멈췄으며, 아래 선택지에서 복구 방법을 고르면 미션 오너가 해당 절차를 실행합니다.";

describe("human card easy-reading interpretation with failure cause", () => {
  it("starts the current card interpretation with the gateway cause sentence", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: GATEWAY_REASON }));
    const interpretation = card.definition.humanReview!.interpretation;
    expect(interpretation.startsWith(GATEWAY)).toBe(true);
    expect(interpretation).not.toContain("\n");
    expect(interpretation.length).toBeLessThanOrEqual(200);
  });

  it("keeps the option-derived sentence when reason is absent or unmatched", () => {
    for (const overrides of [
      { reason: undefined, evidence: undefined },
      { reason: "사람 승인이 필요합니다" },
    ]) {
      expect(buildMissionOwnerHumanInputDecisionCard(spec(overrides))
        .definition.humanReview!.interpretation).toBe(OPTION_DERIVED);
    }
  });

  it("starts the stage1 compact card interpretation with the cause sentence", () => {
    const card = buildStage1CompactMissionOwnerHumanInputDecisionCard(spec({ reason: GATEWAY_REASON }));
    expect(card.definition.humanReview!.interpretation.startsWith(GATEWAY)).toBe(true);
    expect(card.definition.humanReview!.interpretation).not.toContain("\n");
  });

  it("starts the precompact card interpretation with the cause sentence on the first line", () => {
    const card = buildPreCompactMissionOwnerHumanInputDecisionCard(spec({ reason: GATEWAY_REASON }));
    expect(card.definition.humanReview!.interpretation.split("\n")[0]).toBe(GATEWAY);
  });

  it("interprets structured diagnostics carried inside a mission owner reason", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason:
      `[사람 해석] 수집 대상 주소는 없는 페이지입니다(404). (대상: https://x.test) (원본: {"error":"target fetch failed","url":"https://x.test","targetStatus":404})` }));
    expect(card.definition.humanReview!.interpretation.startsWith(NOT_FOUND)).toBe(true);
  });
});

// ---------- requestHash 대조 계약(얼린 형식 보존) ----------
describe("requestHash candidate preservation", () => {
  it("keeps the pre-failure-cause current format in the candidate list", () => {
    const input = spec({ reason: GATEWAY_REASON });
    const preCause = buildPreFailureCauseMissionOwnerHumanInputDecisionCard(input);
    // 원인 해석이 없던 시대의 해석 문장이 그대로다 — 원인 문장이 붙지 않는다.
    expect(preCause.definition.humanReview!.interpretation).toBe(OPTION_DERIVED);
    const hashes = buildLegacyMissionOwnerHumanInputDecisionCardVariants(input)
      .map((variant) => validateAndHashOperatorDecisionCreate(variant).requestHash);
    expect(hashes).toContain(validateAndHashOperatorDecisionCreate(preCause).requestHash);
  });

  it("keeps byte-exact legacy interpretations available alongside cause-applied ones", () => {
    const input = spec({ reason: GATEWAY_REASON });
    const variants = buildLegacyMissionOwnerHumanInputDecisionCardVariants(input);
    const interpretations = variants.map((variant) => variant.definition.humanReview!.interpretation);
    // 원인 적용본(게이트웨이 문장 시작)과 바이트-동일 원본(승인 여부·요청 사유 형식)이 함께 후보다.
    expect(interpretations.some((line) => line.startsWith(GATEWAY))).toBe(true);
    expect(interpretations.some((line) => line.startsWith("사람 결정(") && line.includes("승인 여부"))).toBe(true);
    expect(interpretations.some((line) => line.startsWith("미션 오너 에이전트가 사람 결정"))).toBe(true);
  });
});

// ---------- #757 문장 매핑 공유 계약 ----------
describe("interpretTargetFailureStatusSentence", () => {
  it("maps the structured status classes and declines others", () => {
    expect(interpretTargetFailureStatusSentence(404)).toBe(NOT_FOUND);
    expect(interpretTargetFailureStatusSentence(403))
      .toBe("대상 사이트가 접근을 거부했습니다(403). 차단 또는 로그인 필요 여부를 확인하세요.");
    expect(interpretTargetFailureStatusSentence(503)).toBe("대상 사이트 자체 오류(503)입니다. 잠시 후 재시도를 고려하세요.");
    expect(interpretTargetFailureStatusSentence(429)).toBe("대상 사이트가 429를 반환했습니다. 주소·요청 조건을 확인하세요.");
    expect(interpretTargetFailureStatusSentence(200)).toBeNull();
  });
});

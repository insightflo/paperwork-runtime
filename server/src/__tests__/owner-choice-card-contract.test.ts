// server/src/__tests__/owner-choice-card-contract.test.ts
//
// [owner-choice-card Stage 1] 선택 카드 payload 계약과 TTL sourceContext 의 단위 검증.
//   - 4 결정 지점(topic/direction/budget/publish) 유효 카드 수용 + 2h 기본 afterMs 적용
//   - fail-closed 거부: 옵션 1개, id 중복, defaultOptionId 누락, safe 제안이
//     비가역·미존재 선택지를 가리킴, 계약 밖 필드, 비객체 입력
//   - buildOwnerChoiceCardSourceContext: 2h 기본 TTL, safeAutoAdvance/irreversible 전파,
//     afterMs 재정의, 기존 sourceContext 키(missionId/workflowId/workflowRunId) 하위 호환
//   - C08 회귀 방어: 기존 owner-human-request-contract 스키마가 기존 payload 를 그대로
//     수용하고 기존 re한정도 그대로 작동함을 확인 — 이 Stage 는 C08 계약 파일을
//     전혀 수정하지 않으므로 기존 C08 카드와 100% 호환이 유지된다.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OWNER_CHOICE_CARD_DEFAULT_TTL_MS,
  buildOwnerChoiceCardSourceContext,
  parseOwnerChoiceCardPayload,
} from "../services/missions/owner-choice-card-contract.js";
import { ownerHumanCurrentSchema, ownerHumanScopeSchema,
  ownerHumanSubmissionSchema } from "../services/missions/owner-human-request-contract.js";

const uuid = () => randomUUID();
const option = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, label: `옵션 ${id}`, summary: `${id} 선택지 요약`, ...extra });

function payload(overrides: Record<string, unknown> = {}) {
  return {
    decisionKind: "choice",
    decisionPoint: "topic_selection",
    prompt: "이번 스프린트 주제를 선택해 주세요.",
    options: [option("topic-alpha"), option("topic-beta", { recommended: true })],
    autoAdvanceProposal: {
      defaultOptionId: "topic-beta", safe: true, rationale: "권장안이며 되돌릴 수 있습니다.",
    },
    ...overrides,
  };
}
const parsedOrThrow = (overrides: Record<string, unknown> = {}) => {
  const result = parseOwnerChoiceCardPayload(payload(overrides));
  if (!result.ok) throw new Error(`fixture rejected: ${result.error}`);
  return result.data;
};

describe("ownerChoiceCardPayloadSchema / parseOwnerChoiceCardPayload", () => {
  it("accepts a valid topic_selection card and applies the 2h default afterMs", () => {
    expect(OWNER_CHOICE_CARD_DEFAULT_TTL_MS).toBe(7_200_000);
    const result = parseOwnerChoiceCardPayload(payload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.decisionKind).toBe("choice");
    expect(result.data.decisionPoint).toBe("topic_selection");
    expect(result.data.autoAdvanceProposal?.afterMs).toBe(OWNER_CHOICE_CARD_DEFAULT_TTL_MS);
    expect(result.data.autoAdvanceProposal?.defaultOptionId).toBe("topic-beta");
    expect(result.data.options[1]?.recommended).toBe(true);
  });

  it("accepts direction_choice / budget_threshold / publish_approval cards", () => {
    const direction = parseOwnerChoiceCardPayload(payload({
      decisionPoint: "direction_choice",
      prompt: "A/B 실행 방향을 선택해 주세요.",
      contextLinks: ["https://example.com/plan"],
      options: [option("dir-self-host", { summary: "자체 운영" }),
        option("dir-managed", { recommended: true, summary: "매니지드 운영" })],
      autoAdvanceProposal: {
        afterMs: 30 * 60 * 1000, defaultOptionId: "dir-managed", safe: true, rationale: "낮은 위험",
      },
    }));
    const budget = parseOwnerChoiceCardPayload(payload({
      decisionPoint: "budget_threshold",
      prompt: "이번 달 지출 한도를 선택해 주세요.",
      options: [option("budget-100"), option("budget-300", { payload: { usd: 300 } })],
      autoAdvanceProposal: undefined,
    }));
    const publish = parseOwnerChoiceCardPayload(payload({
      decisionPoint: "publish_approval",
      prompt: "게시를 승인할까요?",
      options: [option("publish-hold"), option("publish-now", { irreversible: true })],
      autoAdvanceProposal: {
        defaultOptionId: "publish-hold", safe: false,
        rationale: "비가역 선택지가 있어 자동 진행하지 않습니다.",
      },
    }));
    expect([direction.ok, budget.ok, publish.ok]).toEqual([true, true, true]);
    if (!direction.ok) return;
    expect(direction.data.autoAdvanceProposal?.afterMs).toBe(30 * 60 * 1000);
    expect(direction.data.contextLinks).toEqual(["https://example.com/plan"]);
    if (!budget.ok) return;
    expect(budget.data.autoAdvanceProposal).toBeUndefined();
    if (!publish.ok) return;
    expect(publish.data.options[1]?.irreversible).toBe(true);
  });

  it("rejects a card with fewer than 2 options", () => {
    const result = parseOwnerChoiceCardPayload(payload({ options: [option("only-one")] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/options/);
  });

  it("rejects duplicate option ids and contract-unknown fields", () => {
    const duplicate = parseOwnerChoiceCardPayload(payload({
      options: [option("same-id"), option("same-id", { recommended: true })],
    }));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toMatch(/duplicate option id/);
    const unknownField = parseOwnerChoiceCardPayload(payload({ decisionVocabulary: "x" }));
    expect(unknownField.ok).toBe(false);
  });

  it("rejects a proposal whose defaultOptionId is absent", () => {
    const result = parseOwnerChoiceCardPayload(payload({
      autoAdvanceProposal: { safe: true, rationale: "id 누락 제안" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/defaultOptionId/);
  });

  it("rejects safe:true pointing to an irreversible option", () => {
    const result = parseOwnerChoiceCardPayload(payload({
      options: [option("keep"), option("wipe-all", { irreversible: true })],
      autoAdvanceProposal: { defaultOptionId: "wipe-all", safe: true, rationale: "안전하다고 선언" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/irreversible/);
  });

  it("rejects safe:true pointing to an option that does not exist", () => {
    const result = parseOwnerChoiceCardPayload(payload({
      autoAdvanceProposal: { defaultOptionId: "ghost-option", safe: true, rationale: "없는 선택지" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not in options/);
  });

  it("rejects non-object payloads (fail-closed)", () => {
    expect(parseOwnerChoiceCardPayload("choice").ok).toBe(false);
    expect(parseOwnerChoiceCardPayload(null).ok).toBe(false);
    expect(parseOwnerChoiceCardPayload(undefined).ok).toBe(false);
  });
});

describe("buildOwnerChoiceCardSourceContext", () => {
  it("emits the 2h default TTL and a null suggestion when no proposal exists", () => {
    const context = buildOwnerChoiceCardSourceContext(parsedOrThrow({ autoAdvanceProposal: undefined }));
    expect(context.decisionKind).toBe("choice");
    expect(context.decisionPoint).toBe("topic_selection");
    expect(context.ttlMs).toBe(OWNER_CHOICE_CARD_DEFAULT_TTL_MS);
    expect(context.suggestedDecision).toBeNull();
    expect(context.safeAutoAdvance).toBe(false);
    expect(context.irreversible).toBe(false);
    expect(context.choiceOptions).toHaveLength(2);
  });

  it("propagates the afterMs override and a safe proposal", () => {
    const context = buildOwnerChoiceCardSourceContext(parsedOrThrow({
      autoAdvanceProposal: {
        afterMs: 15 * 60 * 1000, defaultOptionId: "topic-beta", safe: true, rationale: "짧은 대기",
      },
    }));
    expect(context.ttlMs).toBe(15 * 60 * 1000);
    expect(context.suggestedDecision).toBe("topic-beta");
    expect(context.safeAutoAdvance).toBe(true);
    const second = (context.choiceOptions as Array<Record<string, unknown>>)[1];
    expect(second).toMatchObject({ id: "topic-beta", recommended: true, irreversible: false });
  });

  it("propagates irreversible when any option is irreversible", () => {
    const context = buildOwnerChoiceCardSourceContext(parsedOrThrow({
      options: [option("keep"), option("delete-all", { irreversible: true })],
      autoAdvanceProposal: { defaultOptionId: "keep", safe: false, rationale: "비가역 포함" },
    }));
    expect(context.irreversible).toBe(true);
    expect(context.safeAutoAdvance).toBe(false);
    const second = (context.choiceOptions as Array<Record<string, unknown>>)[1];
    expect(second).toMatchObject({ id: "delete-all", irreversible: true });
  });

  it("keeps legacy sourceContext keys backward-compatible when base is provided", () => {
    const context = buildOwnerChoiceCardSourceContext(parsedOrThrow(), {
      missionId: uuid(), workflowId: null, workflowRunId: uuid(),
    });
    expect(typeof context.missionId).toBe("string");
    expect(context.workflowId).toBeNull();
    expect(typeof context.workflowRunId).toBe("string");
    expect(context.artifactRefs).toEqual([]);
    expect(context.decisionKind).toBe("choice");
    expect(context.ttlMs).toBe(OWNER_CHOICE_CARD_DEFAULT_TTL_MS);
  });
});

describe("C08 owner-human-request-contract regression guard", () => {
  it("still accepts the canonical recovery submission unchanged", () => {
    const submission = ownerHumanSubmissionSchema.safeParse({
      decision: "request_input",
      recoveryTarget: { kind: "issue", issueId: uuid() },
      reason: "재계획 승인이 필요합니다.",
      recommendedOptionId: "opt-1",
      recommendationReason: "오너 추천",
    });
    expect(submission.success).toBe(true);
  });

  it("still enforces strict keys, scope targets, and the currentness refinement", () => {
    const rogue = ownerHumanSubmissionSchema.safeParse({
      decision: "request_input", recoveryTarget: { kind: "issue", issueId: uuid() }, rogue: true,
    });
    expect(rogue.success).toBe(false);
    const scope = { companyId: uuid(), missionId: uuid(), target: { kind: "oversight" } };
    expect(ownerHumanScopeSchema.safeParse(scope).success).toBe(true);
    const base = {
      schemaVersion: 1, kind: "owner_human_current_v1", scope, lifetimeId: uuid(),
      requestKey: "rq-1", anchorIssueId: uuid(), revision: 1, recoveryNeeded: true, closure: null,
    };
    expect(ownerHumanCurrentSchema.safeParse(base).success).toBe(true);
    const broken = { ...base,
      closure: { eventId: uuid(), reason: "source_settled" } };
    expect(ownerHumanCurrentSchema.safeParse(broken).success).toBe(false);
  });
});

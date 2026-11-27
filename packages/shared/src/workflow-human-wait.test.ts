// [stage26 human_wait] Wave 1 공유 레이어 단위 테스트 — decisionTemplate 검증기와
// resolveStepLogicalClass 논리 클래스 판정. 순수 추가(기존 소스·테스트 미변경).
import { describe, expect, it } from "vitest";
import {
  workflowHumanWaitDecisionTemplateSchema,
  workflowStepDefinitionSchema,
} from "./validators/workflow.js";
import {
  resolveStepLogicalClass,
  type WorkflowStepLogicalClassSource,
} from "./types/workflow.js";

describe("workflowHumanWaitDecisionTemplateSchema", () => {
  it("parses a full payload and trims string fields", () => {
    const result = workflowHumanWaitDecisionTemplateSchema.parse({
      title: "  발주 승인 대기  ",
      prompt: "이 발주를 승인할까요?",
      requiredRole: "operator",
      timeoutMinutes: 1.5,
      allowReject: true,
      approvalLabel: "승인",
      rejectLabel: "거절",
    });
    expect(result).toEqual({
      title: "발주 승인 대기",
      prompt: "이 발주를 승인할까요?",
      requiredRole: "operator",
      timeoutMinutes: 1.5,
      allowReject: true,
      approvalLabel: "승인",
      rejectLabel: "거절",
    });
  });

  it("accepts the minimal empty template", () => {
    expect(workflowHumanWaitDecisionTemplateSchema.parse({})).toEqual({});
  });

  it("rejects non-positive timeoutMinutes but allows fractional minutes", () => {
    for (const timeoutMinutes of [0, -30]) {
      const result = workflowHumanWaitDecisionTemplateSchema.safeParse({ timeoutMinutes });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["timeoutMinutes"]);
        expect(result.error.issues[0]?.code).toBe("too_small");
      }
    }
    expect(workflowHumanWaitDecisionTemplateSchema.parse({ timeoutMinutes: 0.5 }))
      .toEqual({ timeoutMinutes: 0.5 });
    // 분 단위 숫자만 허용 — 문자열 초안 값은 공유 검증기에서 거부한다.
    const stringResult = workflowHumanWaitDecisionTemplateSchema.safeParse({ timeoutMinutes: "30" });
    expect(stringResult.success).toBe(false);
    if (!stringResult.success) {
      expect(stringResult.error.issues[0]?.code).toBe("invalid_type");
    }
  });

  it("rejects an empty (whitespace-only) title", () => {
    const result = workflowHumanWaitDecisionTemplateSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["title"]);
    }
  });

  it("enforces the title length ceiling after trimming", () => {
    expect(workflowHumanWaitDecisionTemplateSchema.safeParse({ title: "a".repeat(200) }).success).toBe(true);
    expect(workflowHumanWaitDecisionTemplateSchema.safeParse({ title: "a".repeat(201) }).success).toBe(false);
  });

  it("rejects unknown fields (strict object)", () => {
    const result = workflowHumanWaitDecisionTemplateSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("resolveStepLogicalClass", () => {
  const resolve = (step: WorkflowStepLogicalClassSource) => resolveStepLogicalClass(step);

  it("defaults null, undefined, and untyped steps to ai_agent", () => {
    expect(resolveStepLogicalClass(null)).toBe("ai_agent");
    expect(resolveStepLogicalClass(undefined)).toBe("ai_agent");
    expect(resolve({})).toBe("ai_agent");
  });

  it("maps agent and workflow step types to ai_agent", () => {
    expect(resolve({ type: "agent" })).toBe("ai_agent");
    expect(resolve({ type: "workflow" })).toBe("ai_agent");
  });

  it("maps tool, if, and complete step types to function", () => {
    expect(resolve({ type: "tool" })).toBe("function");
    expect(resolve({ type: "if" })).toBe("function");
    expect(resolve({ type: "complete" })).toBe("function");
  });

  it("maps the explicit human_wait step type to human_wait", () => {
    expect(resolve({ type: "human_wait" })).toBe("human_wait");
  });

  it("promotes steps carrying a decisionTemplate to human_wait", () => {
    expect(resolve({ type: "agent", decisionTemplate: { title: "승인" } })).toBe("human_wait");
    // 빈 프리셋도 존재 자체가 사람 대기 신호다.
    expect(resolve({ decisionTemplate: {} })).toBe("human_wait");
    // 명시적 undefined 는 부재로 본다(침묵 승격 금지).
    expect(resolve({ type: "agent", decisionTemplate: undefined })).toBe("ai_agent");
  });

  it("promotes the legacy graphApprovalRequired flag (boolean and string forms)", () => {
    expect(resolve({ type: "agent", graphApprovalRequired: true })).toBe("human_wait");
    expect(resolve({ type: "agent", graphApprovalRequired: "true" })).toBe("human_wait");
    expect(resolve({ type: "agent", graphApprovalRequired: false })).toBe("ai_agent");
    expect(resolve({ type: "agent", graphApprovalRequired: "false" })).toBe("ai_agent");
  });

  it("ranks explicit human_wait type over decisionTemplate over the legacy flag", () => {
    // 레거시 플래그는 function 매핑(tool/if/complete)보다 먼저 판정된다.
    expect(resolve({ type: "tool", graphApprovalRequired: true })).toBe("human_wait");
    expect(resolve({ type: "tool", graphApprovalRequired: "true" })).toBe("human_wait");
    expect(resolve({ type: "tool", graphApprovalRequired: "false" })).toBe("function");
    // decisionTemplate 존재가 레거시 플래그 부재/거짓보다 우선한다.
    expect(resolve({ type: "tool", decisionTemplate: {}, graphApprovalRequired: false }))
      .toBe("human_wait");
  });
});

describe("workflowStepDefinitionSchema human_wait integration", () => {
  it("accepts the human_wait step type with a decision template", () => {
    const result = workflowStepDefinitionSchema.parse({
      id: "approve-order",
      type: "human_wait",
      decisionTemplate: {
        title: "발주 승인 대기",
        prompt: "이 발주를 승인할까요?",
        timeoutMinutes: 30,
      },
    });
    expect(result.type).toBe("human_wait");
    expect(result.decisionTemplate).toEqual({
      title: "발주 승인 대기",
      prompt: "이 발주를 승인할까요?",
      timeoutMinutes: 30,
    });
  });

  it("propagates decisionTemplate strictness into the step schema", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "approve-order",
      decisionTemplate: { notAllowed: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["decisionTemplate"]);
    }
  });

  it("keeps the open string step type for backward compatibility", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "future-step",
      type: "custom_future_type",
    });
    expect(result.success).toBe(true);
  });
});

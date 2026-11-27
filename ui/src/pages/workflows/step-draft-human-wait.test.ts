// [stage26 human_wait] Wave 1 UI 초안 레이어 단위 테스트 — step-draft-defaults 기본값과
// step-draft-parsers의 decisionTemplate 파싱, 레거시 graphApprovalRequired 역호환 왕복.
// Wave 2 에서는 stepsToJson 의 decisionTemplate 초안 필드 직렬화(게이트 방식)와 저장 왕복
// 무손실을 이 파일에서 검증한다.
import { describe, expect, it } from "vitest";
import { emptyStep, jsonToSteps, stepsToJsonForSave } from "./step-draft.js";
import {
  decisionTemplateFromLegacyApprovalFlags,
  parseDecisionTemplateTimeoutMinutes,
  parseOptionalDecisionTemplate,
} from "./step-draft-parsers.js";
import { workflowHumanWaitDecisionTemplateSchema } from "@paperclipai/shared/validators/workflow";

describe("emptyStep decisionTemplate draft defaults", () => {
  it("initializes every decisionTemplate draft field", () => {
    const draft = emptyStep();
    expect(draft.decisionTemplateTitle).toBe("");
    expect(draft.decisionTemplatePrompt).toBe("");
    expect(draft.decisionTemplateRequiredRole).toBe("");
    expect(draft.decisionTemplateTimeoutMinutes).toBe("");
    expect(draft.decisionTemplateAllowReject).toBe(false);
    expect(draft.decisionTemplateApprovalLabel).toBe("");
    expect(draft.decisionTemplateRejectLabel).toBe("");
  });
});

describe("parseDecisionTemplateTimeoutMinutes", () => {
  it("accepts positive numeric and numeric-string minutes", () => {
    expect(parseDecisionTemplateTimeoutMinutes(30)).toBe(30);
    expect(parseDecisionTemplateTimeoutMinutes(1.5)).toBe(1.5);
    expect(parseDecisionTemplateTimeoutMinutes("45")).toBe(45);
    expect(parseDecisionTemplateTimeoutMinutes("  90  ")).toBe(90);
  });

  it("treats zero, negative, and non-numeric values as unset", () => {
    expect(parseDecisionTemplateTimeoutMinutes(0)).toBeUndefined();
    expect(parseDecisionTemplateTimeoutMinutes(-5)).toBeUndefined();
    expect(parseDecisionTemplateTimeoutMinutes("abc")).toBeUndefined();
    expect(parseDecisionTemplateTimeoutMinutes("")).toBeUndefined();
    expect(parseDecisionTemplateTimeoutMinutes(null)).toBeUndefined();
    expect(parseDecisionTemplateTimeoutMinutes(undefined)).toBeUndefined();
  });
});

describe("parseOptionalDecisionTemplate", () => {
  it("parses a full template, trimming text and coercing timeout strings", () => {
    expect(parseOptionalDecisionTemplate({
      title: "  발주 승인 대기  ",
      prompt: "이 발주를 승인할까요?",
      requiredRole: " operator ",
      timeoutMinutes: "90",
      allowReject: true,
      approvalLabel: " 승인 ",
      rejectLabel: "거절",
    })).toEqual({
      title: "발주 승인 대기",
      prompt: "이 발주를 승인할까요?",
      requiredRole: "operator",
      timeoutMinutes: 90,
      allowReject: true,
      approvalLabel: "승인",
      rejectLabel: "거절",
    });
  });

  it("keeps an explicit allowReject:false and drops blank or invalid fields", () => {
    // allowReject:false 는 의미 있는 값이므로 침묵 제거하지 않는다.
    expect(parseOptionalDecisionTemplate({ allowReject: false })).toEqual({ allowReject: false });
    expect(parseOptionalDecisionTemplate({
      title: "   ",
      prompt: "",
      timeoutMinutes: 0,
    })).toBeUndefined();
  });

  it("returns undefined for non-object and empty values", () => {
    expect(parseOptionalDecisionTemplate(undefined)).toBeUndefined();
    expect(parseOptionalDecisionTemplate(null)).toBeUndefined();
    expect(parseOptionalDecisionTemplate("승인")).toBeUndefined();
    expect(parseOptionalDecisionTemplate(42)).toBeUndefined();
    expect(parseOptionalDecisionTemplate([])).toBeUndefined();
    expect(parseOptionalDecisionTemplate({})).toBeUndefined();
  });

  it("produces templates that satisfy the shared validator", () => {
    const template = parseOptionalDecisionTemplate({ title: "검토", timeoutMinutes: "1.5" });
    expect(template).toBeDefined();
    expect(workflowHumanWaitDecisionTemplateSchema.parse(template)).toEqual({
      title: "검토",
      timeoutMinutes: 1.5,
    });
  });
});

describe("decisionTemplateFromLegacyApprovalFlags", () => {
  it("returns undefined when the legacy flag is absent or falsy", () => {
    expect(decisionTemplateFromLegacyApprovalFlags({})).toBeUndefined();
    expect(decisionTemplateFromLegacyApprovalFlags({ graphApprovalRequired: false })).toBeUndefined();
    expect(decisionTemplateFromLegacyApprovalFlags({ graphApprovalRequired: "false" })).toBeUndefined();
  });

  it("does not create an empty preset for a bare flag", () => {
    expect(decisionTemplateFromLegacyApprovalFlags({ graphApprovalRequired: true })).toBeUndefined();
    expect(decisionTemplateFromLegacyApprovalFlags({ graphApprovalRequired: "true" })).toBeUndefined();
  });

  it("derives prompt and lossless seconds-to-minutes timeout from legacy fields", () => {
    expect(decisionTemplateFromLegacyApprovalFlags({
      graphApprovalRequired: true,
      graphApprovalPrompt: "  결재 필요  ",
      graphApprovalTimeoutSeconds: 90,
    })).toEqual({ prompt: "결재 필요", timeoutMinutes: 1.5 });
    expect(decisionTemplateFromLegacyApprovalFlags({
      graphApprovalRequired: "true",
      graphApprovalTimeoutSeconds: "5400",
    })).toEqual({ timeoutMinutes: 90 });
  });

  it("ignores non-positive legacy timeouts", () => {
    expect(decisionTemplateFromLegacyApprovalFlags({
      graphApprovalRequired: true,
      graphApprovalTimeoutSeconds: 0,
    })).toBeUndefined();
  });

  it("derives legacy presets that satisfy the shared validator", () => {
    const template = decisionTemplateFromLegacyApprovalFlags({
      graphApprovalRequired: true,
      graphApprovalPrompt: "승인 필요",
      graphApprovalTimeoutSeconds: 90,
    });
    expect(template).toBeDefined();
    expect(workflowHumanWaitDecisionTemplateSchema.parse(template)).toEqual(template);
  });
});

describe("step draft human_wait roundtrip and backward compatibility", () => {
  it("preserves the legacy graphApprovalRequired flag through a draft save roundtrip", () => {
    const [draft] = jsonToSteps([{
      id: "approve-order",
      title: "발주 승인",
      type: "agent",
      graphApprovalRequired: true,
      graphApprovalPrompt: "결재 필요",
      graphApprovalTimeoutSeconds: 90,
    }]);
    // 임포트 시 레거시 플래그는 1급 draft 필드로 승격되고, human_wait 프리셋은 파서로 도출한다.
    expect(draft.graphApprovalRequired).toBe(true);
    expect(draft.graphApprovalTimeoutSeconds).toBe("90");
    const derived = decisionTemplateFromLegacyApprovalFlags({
      graphApprovalRequired: draft.graphApprovalRequired,
      graphApprovalPrompt: draft.graphApprovalPrompt,
      graphApprovalTimeoutSeconds: draft.graphApprovalTimeoutSeconds,
    });
    expect(derived).toEqual({ prompt: "결재 필요", timeoutMinutes: 1.5 });

    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error(result.error);
    const saved = result.steps[0] as Record<string, unknown>;
    // 역호환: 저장 직렬화는 새 decisionTemplate 필드를 만들지 않고 레거시 플래그를 유지한다.
    expect(saved.graphApprovalRequired).toBe(true);
    expect(saved.graphApprovalPrompt).toBe("결재 필요");
    expect(saved.graphApprovalTimeoutSeconds).toBe(90);
    expect(saved).not.toHaveProperty("decisionTemplate");
  });

  it("carries a serialized decisionTemplate through the draft extra bag without loss", () => {
    const decisionTemplate = {
      title: "발주 승인 대기",
      prompt: "이 발주를 승인할까요?",
      timeoutMinutes: 30,
      allowReject: false,
    };
    const [draft] = jsonToSteps([{
      id: "human-review",
      title: "사람 검토",
      type: "agent",
      decisionTemplate,
    }]);
    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error(result.error);
    const saved = result.steps[0] as Record<string, unknown>;
    expect(saved.decisionTemplate).toEqual(decisionTemplate);
    expect(workflowHumanWaitDecisionTemplateSchema.parse(saved.decisionTemplate))
      .toEqual(decisionTemplate);

    // 두 번째 왕복에서도 동일하게 유지된다(멱등).
    const [redraft] = jsonToSteps([saved as { id: string; title: string }]);
    const reresult = stepsToJsonForSave([redraft]);
    if (!("steps" in reresult)) throw new Error(reresult.error);
    expect((reresult.steps[0] as Record<string, unknown>).decisionTemplate).toEqual(decisionTemplate);
  });
});

describe("stepsToJson decisionTemplate draft serialization", () => {
  it("does not inject decisionTemplate into steps whose card fields are all at defaults", () => {
    // emptyStep 초안은 decisionTemplate* 기본값(빈 문자열/false)을 갖는다 — 카드 입력이
    // 없는 신규·기존 스텝에는 빈 decisionTemplate 키를 주입하지 않아야 한다(역호환).
    const draft = { ...emptyStep(), id: "plain-agent", title: "일반 스텝" };
    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error(result.error);
    expect(result.steps[0]).not.toHaveProperty("decisionTemplate");
  });

  it("serializes populated card fields losslessly including allowReject:false and numeric timeoutMinutes", () => {
    const [draft] = jsonToSteps([{ id: "card-edit", title: "사람 검토", type: "agent" }]);
    // 카드 편집기의 updateSelected 가 초안 필드에 쓰는 것과 동일한 경로를 시뮬레이션한다.
    draft.decisionTemplateTitle = "발주 승인 대기";
    draft.decisionTemplatePrompt = "이 발주를 승인할까요?";
    draft.decisionTemplateRequiredRole = "operator";
    draft.decisionTemplateTimeoutMinutes = "90";
    draft.decisionTemplateAllowReject = false;
    draft.decisionTemplateApprovalLabel = "승인";
    draft.decisionTemplateRejectLabel = "거절";

    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error(result.error);
    const saved = result.steps[0] as Record<string, unknown>;
    const expected = {
      title: "발주 승인 대기",
      prompt: "이 발주를 승인할까요?",
      requiredRole: "operator",
      timeoutMinutes: 90,
      allowReject: false,
      approvalLabel: "승인",
      rejectLabel: "거절",
    };
    expect(saved.decisionTemplate).toEqual(expected);
    // 공유 검증기와 임포트 파서 양쪽이 같은 값을 되돌려야 왕복이 무손실이다.
    expect(workflowHumanWaitDecisionTemplateSchema.parse(saved.decisionTemplate)).toEqual(expected);
    expect(parseOptionalDecisionTemplate(saved.decisionTemplate)).toEqual(expected);

    // 두 번째 왕복(저장본 재임포트 → 재직렬화)에서도 값이 변하지 않는다(멱등).
    const [redraft] = jsonToSteps([saved as { id: string; title: string }]);
    const reresult = stepsToJsonForSave([redraft]);
    if (!("steps" in reresult)) throw new Error(reresult.error);
    expect((reresult.steps[0] as Record<string, unknown>).decisionTemplate).toEqual(expected);
  });

  it("gates emission on explicit fields only: bare allowReject:true emits, blank or invalid input does not", () => {
    const [draft] = jsonToSteps([{ id: "reject-only", title: "거절 허용", type: "agent" }]);
    draft.decisionTemplateAllowReject = true;
    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error(result.error);
    expect((result.steps[0] as Record<string, unknown>).decisionTemplate).toEqual({ allowReject: true });

    // 공백·무효 입력만으로는 게이트가 열리지 않는다 — 빈·깨진 템플릿을 만들지 않는다.
    const [blank] = jsonToSteps([{ id: "blank-card", title: "공백 초안", type: "agent" }]);
    blank.decisionTemplateTitle = "   ";
    blank.decisionTemplateTimeoutMinutes = "abc";
    blank.decisionTemplateAllowReject = false;
    const blankResult = stepsToJsonForSave([blank]);
    if (!("steps" in blankResult)) throw new Error(blankResult.error);
    expect(blankResult.steps[0]).not.toHaveProperty("decisionTemplate");
  });
});

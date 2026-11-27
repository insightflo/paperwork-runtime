import { describe, expect, it } from "vitest";
import {
  WORKFLOW_DISPATCH_SHARP_SUCCESS_RATE_THRESHOLD,
  WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS,
  planWorkflowStepDispatch,
  type WorkflowStepDispatchInput,
} from "../services/workflow/harness-dispatch-policy.js";

const baseInput: WorkflowStepDispatchInput = {
  requiresWrite: false,
  riskLevel: "low",
  consecutiveFailures: 0,
  priorSuccessRate: 0.9,
  phase: "retry",
};

function plan(overrides: Partial<WorkflowStepDispatchInput> = {}) {
  return planWorkflowStepDispatch({ ...baseInput, ...overrides });
}

function planInvalid(overrides: Record<string, unknown>) {
  return planWorkflowStepDispatch({ ...baseInput, ...overrides } as unknown as WorkflowStepDispatchInput);
}

const failClosedPlan = {
  route: "escalate_advisor",
  requiredAdvisorGate: "g2",
  stallThresholdsMs: WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.escalate_advisor,
  inputValid: false,
};

describe("planWorkflowStepDispatch route", () => {
  it("takes the sharp fast-path for a read-only, low-risk step with a high success rate", () => {
    expect(plan()).toEqual({
      route: "sharp",
      requiredAdvisorGate: "none",
      reason: "read_only_low_risk_success_rate>=threshold",
      stallThresholdsMs: WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.sharp,
      inputValid: true,
    });
  });

  it("reaches sharp exactly at the success-rate threshold", () => {
    expect(plan({ priorSuccessRate: WORKFLOW_DISPATCH_SHARP_SUCCESS_RATE_THRESHOLD }).route).toBe("sharp");
    expect(plan({ priorSuccessRate: WORKFLOW_DISPATCH_SHARP_SUCCESS_RATE_THRESHOLD - 0.001 }).route).toBe("split");
  });

  it.each(["medium", "high"] as const)("routes to split on %s risk even when read-only with a high success rate", (riskLevel) => {
    expect(plan({ riskLevel })).toMatchObject({ route: "split", reason: `risk_level_${riskLevel}`, inputValid: true });
  });

  it("routes to split on write regardless of low risk and a high success rate", () => {
    expect(plan({ requiresWrite: true })).toMatchObject({ route: "split", reason: "requires_write", inputValid: true });
  });

  it("routes to split for a read-only low-risk step whose success rate is below the threshold", () => {
    expect(plan({ priorSuccessRate: 0.3 })).toMatchObject({
      route: "split",
      reason: "read_only_low_risk_success_rate_below_threshold",
    });
  });

  it.each([2, 3, 10])("forces escalate_advisor at %i consecutive failures regardless of route inputs", (consecutiveFailures) => {
    expect(plan({ consecutiveFailures, requiresWrite: true, riskLevel: "high", priorSuccessRate: 1 })).toMatchObject({
      route: "escalate_advisor",
      reason: "consecutive_failures>=2",
    });
    expect(plan({ consecutiveFailures, requiresWrite: false, riskLevel: "low", priorSuccessRate: 1 }).route)
      .toBe("escalate_advisor");
  });

  it("does not escalate for a single failure", () => {
    expect(plan({ consecutiveFailures: 1 }).route).toBe("sharp");
  });
});

describe("planWorkflowStepDispatch advisor gate priority", () => {
  it("requires g2 on >=2 consecutive failures in every phase", () => {
    for (const phase of ["planning", "retry", "merge"] as const) {
      expect(plan({ consecutiveFailures: 2, phase }).requiredAdvisorGate).toBe("g2");
    }
  });

  it("requires g1 in the planning phase when there is no forced escalation", () => {
    expect(plan({ phase: "planning", requiresWrite: true }).requiredAdvisorGate).toBe("g1");
  });

  it("requires g3 in the merge phase when there is no forced escalation", () => {
    expect(plan({ phase: "merge" }).requiredAdvisorGate).toBe("g3");
  });

  it("requires no gate in the retry phase below two consecutive failures", () => {
    expect(plan({ phase: "retry", consecutiveFailures: 1 }).requiredAdvisorGate).toBe("none");
  });

  it("ranks g2 above g1 and g3", () => {
    expect(plan({ consecutiveFailures: 2, phase: "planning" })).toMatchObject({ route: "escalate_advisor", requiredAdvisorGate: "g2" });
    expect(plan({ consecutiveFailures: 2, phase: "merge" })).toMatchObject({ route: "escalate_advisor", requiredAdvisorGate: "g2" });
  });

  it("keeps gate and route independent: a forced escalation still carries a gate from the valid plan", () => {
    const result = plan({ consecutiveFailures: 5, phase: "merge", requiresWrite: true });
    expect(result).toMatchObject({ inputValid: true, route: "escalate_advisor", requiredAdvisorGate: "g2" });
  });
});

describe("planWorkflowStepDispatch stall thresholds", () => {
  it("tightens the budget as confidence drops", () => {
    const { sharp, split, escalate_advisor } = WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS;
    expect(sharp.idleMs).toBeLessThan(split.idleMs);
    expect(split.idleMs).toBeLessThan(escalate_advisor.idleMs);
    expect(sharp.maxMs).toBeLessThan(split.maxMs);
    expect(split.maxMs).toBeLessThan(escalate_advisor.maxMs);
  });

  it("always returns positive thresholds that match the chosen route", () => {
    for (const route of ["sharp", "split", "escalate_advisor"] as const) {
      const thresholds = WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS[route];
      expect(thresholds.idleMs).toBeGreaterThan(0);
      expect(thresholds.maxMs).toBeGreaterThan(0);
    }
    expect(plan().stallThresholdsMs).toBe(WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.sharp);
    expect(plan({ requiresWrite: true }).stallThresholdsMs).toBe(WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.split);
    expect(plan({ consecutiveFailures: 2 }).stallThresholdsMs)
      .toBe(WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.escalate_advisor);
  });
});

describe("planWorkflowStepDispatch invalid input fails closed", () => {
  it.each([
    ["NaN success rate", { priorSuccessRate: Number.NaN }],
    ["out-of-range success rate", { priorSuccessRate: 1.5 }],
    ["negative success rate", { priorSuccessRate: -0.1 }],
    ["NaN failures", { consecutiveFailures: Number.NaN }],
    ["negative failures", { consecutiveFailures: -1 }],
    ["fractional failures", { consecutiveFailures: 1.5 }],
    ["unknown risk level", { riskLevel: "critical" }],
    ["unknown phase", { phase: "closeout" }],
    ["non-boolean requiresWrite", { requiresWrite: "no" }],
    ["missing success rate", { priorSuccessRate: undefined }],
  ])("returns the fail-closed plan for %s", (_label, overrides) => {
    expect(planInvalid(overrides)).toEqual({ ...failClosedPlan, reason: expect.stringMatching(/^invalid_input:[a-zA-Z,]+$/) });
  });

  it("names every invalid field in the reason", () => {
    expect(planInvalid({ priorSuccessRate: Number.NaN, riskLevel: "nope" }).reason)
      .toBe("invalid_input:riskLevel,priorSuccessRate");
  });

  it("fails closed for non-object input", () => {
    expect(planWorkflowStepDispatch(null as unknown as WorkflowStepDispatchInput)).toEqual({
      ...failClosedPlan,
      reason: "invalid_input:input",
    });
    expect(planWorkflowStepDispatch(undefined as unknown as WorkflowStepDispatchInput).inputValid).toBe(false);
  });

  it("never yields sharp or a waived gate for invalid input, even when other fields would fast-path", () => {
    for (const overrides of [{ priorSuccessRate: Number.NaN }, { consecutiveFailures: -3 }, { phase: "retry " }]) {
      const result = planInvalid(overrides);
      expect(result.inputValid).toBe(false);
      expect(result.route).not.toBe("sharp");
      expect(result.requiredAdvisorGate).not.toBe("none");
    }
  });
});

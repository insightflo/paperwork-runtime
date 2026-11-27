// Stage 26 Wave 3c: human_wait resume/continuation directive mapper tests.
// Pure unit tests over the structured HumanWaitGateDecision verdict — no DB and no
// natural-language parsing (rule 8: only structured fields drive step directives).
import { describe, expect, it } from "vitest";
import type { WorkflowStepLogicalClassSource } from "@paperclipai/shared/types/workflow";
import type { HumanWaitGateDecision } from "../services/workflow/control-flow/human-wait-gate.js";
import {
  buildHumanWaitStepDirective,
  isHumanWaitStepDefinition,
} from "../services/workflow/control-flow/human-wait-resume.js";

const context = { workflowRunId: "run-1", stepKey: "approve-draft", generation: 3 };
const requestKey = "human-wait:c1:run-1:approve-draft:3";

const pauseDecision: HumanWaitGateDecision = {
  action: "pause",
  reason: "awaiting_human_decision",
  decisionId: "decision-1",
  requestKey,
};
const resumeDecision: HumanWaitGateDecision = {
  action: "resume",
  resolution: "approved",
  decisionId: "decision-1",
  requestKey,
};
function failDecision(resolution: "rejected" | "expired"): HumanWaitGateDecision {
  return { action: "fail", resolution, decisionId: "decision-1", requestKey };
}

describe("buildHumanWaitStepDirective", () => {
  it("maps pause to hold_waiting_approval without waking downstream", () => {
    expect(buildHumanWaitStepDirective(pauseDecision, context)).toEqual({
      workflowRunId: "run-1",
      stepKey: "approve-draft",
      generation: 3,
      stepAction: "hold_waiting_approval",
      shouldDispatchRun: false,
      shouldWakeDownstream: false,
      decisionId: "decision-1",
      requestKey,
      reasonCode: "awaiting_human_decision",
    });
  });

  it("maps resume to complete_and_continue with downstream wake", () => {
    expect(buildHumanWaitStepDirective(resumeDecision, context)).toEqual({
      workflowRunId: "run-1",
      stepKey: "approve-draft",
      generation: 3,
      stepAction: "complete_and_continue",
      shouldDispatchRun: false,
      shouldWakeDownstream: true,
      decisionId: "decision-1",
      requestKey,
      reasonCode: "human_decision_approved",
    });
  });

  it("maps rejected failure to fail_step with human_decision_rejected", () => {
    expect(buildHumanWaitStepDirective(failDecision("rejected"), context)).toEqual({
      workflowRunId: "run-1",
      stepKey: "approve-draft",
      generation: 3,
      stepAction: "fail_step",
      shouldDispatchRun: false,
      shouldWakeDownstream: false,
      decisionId: "decision-1",
      requestKey,
      reasonCode: "human_decision_rejected",
    });
  });

  it("maps expired failure to fail_step with human_decision_expired", () => {
    const directive = buildHumanWaitStepDirective(failDecision("expired"), context);
    expect(directive.stepAction).toBe("fail_step");
    expect(directive.reasonCode).toBe("human_decision_expired");
    expect(directive.shouldWakeDownstream).toBe(false);
  });

  it("never dispatches the run for any structured verdict", () => {
    for (const gateResult of [pauseDecision, resumeDecision, failDecision("rejected"), failDecision("expired")]) {
      expect(buildHumanWaitStepDirective(gateResult, context).shouldDispatchRun).toBe(false);
    }
  });

  it("carries the structured card identity untouched", () => {
    const directive = buildHumanWaitStepDirective(resumeDecision, context);
    expect(directive.decisionId).toBe(resumeDecision.decisionId);
    expect(directive.requestKey).toBe(resumeDecision.requestKey);
  });
});

describe("isHumanWaitStepDefinition", () => {
  it("detects explicit human_wait step type", () => {
    expect(isHumanWaitStepDefinition({ type: "human_wait" })).toBe(true);
  });

  it("detects the legacy graphApprovalRequired boolean flag", () => {
    expect(isHumanWaitStepDefinition({ graphApprovalRequired: true })).toBe(true);
  });

  it("detects the legacy graphApprovalRequired string flag", () => {
    expect(isHumanWaitStepDefinition({ graphApprovalRequired: "true" })).toBe(true);
  });

  it("detects a declared decision template", () => {
    expect(isHumanWaitStepDefinition({ decisionTemplate: { title: "Approve draft" } })).toBe(true);
  });

  it("rejects non-human_wait logical classes", () => {
    const steps: WorkflowStepLogicalClassSource[] = [
      { type: "agent" },
      { type: "tool" },
      { type: "if" },
      { type: "complete" },
      { type: "workflow" },
      {},
    ];
    for (const step of steps) expect(isHumanWaitStepDefinition(step)).toBe(false);
  });

  it("rejects null and undefined steps", () => {
    expect(isHumanWaitStepDefinition(null)).toBe(false);
    expect(isHumanWaitStepDefinition(undefined)).toBe(false);
  });

  it("keeps human_wait detection for combined signals regardless of flag order", () => {
    expect(isHumanWaitStepDefinition({
      type: "human_wait",
      graphApprovalRequired: true,
      decisionTemplate: { allowReject: false },
    })).toBe(true);
    expect(isHumanWaitStepDefinition({
      type: "tool",
      decisionTemplate: { allowReject: false },
    })).toBe(true);
    expect(isHumanWaitStepDefinition({
      type: "human_wait",
      graphApprovalRequired: false,
    })).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  exceptionHuddleDecisionSchema,
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import {
  executeExceptionHuddleDecision,
  planExceptionHuddleExecution,
} from "../services/missions/exception-huddle-executor.js";

const metadataInput = {
  schemaVersion: "workflow.exception-huddle.v1" as const,
  missionId: "mission-1",
  workflowRunId: "run-1",
  sourceStepId: "qa-step",
  sourceIssueId: "issue-1",
  workProductLinks: ["/work-products/report.html"],
  participants: { ownerAgentId: "chair", producerAgentId: "writer", validatorAgentId: "reviewer" },
  maxRounds: 2,
  currentRound: 2,
  timeoutAt: "2026-11-28T01:05:00.000Z",
  decidedByAgentId: "chair",
  decidedAt: "2026-11-28T01:02:00.000Z",
};

function decision(input: Record<string, unknown>): ExceptionHuddleDecision {
  return exceptionHuddleDecisionSchema.parse(input);
}

function huddleWith(status: ExceptionHuddleMetadata["status"], value: ExceptionHuddleDecision | null) {
  return exceptionHuddleMetadataSchema.parse({
    ...metadataInput,
    status,
    decision: value,
    decidedByAgentId: status === "decided" ? metadataInput.decidedByAgentId : null,
    decidedAt: status === "decided" ? metadataInput.decidedAt : null,
  });
}

function handlers() {
  return {
    onRetryWithGuidance: vi.fn(),
    onAcceptWithWaiver: vi.fn(),
    onReplanRemaining: vi.fn(),
    onEscalate: vi.fn(),
  };
}

function expectOnly(calls: ReturnType<typeof handlers>, selected: keyof ReturnType<typeof handlers>) {
  for (const [name, handler] of Object.entries(calls)) {
    expect(handler, name).toHaveBeenCalledTimes(name === selected ? 1 : 0);
  }
}

describe("planExceptionHuddleExecution", () => {
  it("maps retry_with_guidance to an exact retry command and dispatches only its handler", () => {
    const value = decision({
      kind: "retry_with_guidance", rationale: "Evidence needs correction", guidance: "Fix the evidence",
    });
    const huddle = huddleWith("decided", value);
    const plan = planExceptionHuddleExecution(huddle);
    expect(plan).toStrictEqual({
      ok: true,
      command: {
        kind: "retry_existing_step",
        createUnblockIssue: false,
        workflowRunId: "run-1",
        sourceStepId: "qa-step",
        sourceIssueId: "issue-1",
        guidance: "Fix the evidence",
        rationale: "Evidence needs correction",
        forcedByChair: false,
        idempotencyKey: "huddle-exec:run-1:qa-step:retry_with_guidance",
      },
    });

    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual(plan);
    expectOnly(spies, "onRetryWithGuidance");
    expect(spies.onRetryWithGuidance).toHaveBeenCalledWith(plan.ok ? plan.command : undefined);
  });

  it("maps accept_with_waiver to an exact waiver command and dispatches only its handler", () => {
    const value = decision({
      kind: "accept_with_waiver", rationale: "Cosmetic issue only", waiverCondition: "Alt text is absent on a decorative image",
      forcedByChair: true,
    });
    const huddle = huddleWith("decided", value);
    const plan = planExceptionHuddleExecution(huddle);
    expect(plan).toStrictEqual({
      ok: true,
      command: {
        kind: "record_waiver_pass",
        workflowRunId: "run-1",
        sourceStepId: "qa-step",
        sourceIssueId: "issue-1",
        waiverCondition: "Alt text is absent on a decorative image",
        rationale: "Cosmetic issue only",
        forcedByChair: true,
        idempotencyKey: "huddle-exec:run-1:qa-step:accept_with_waiver",
      },
    });

    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual(plan);
    expectOnly(spies, "onAcceptWithWaiver");
    expect(spies.onAcceptWithWaiver).toHaveBeenCalledWith(plan.ok ? plan.command : undefined);
  });

  it("maps replan_remaining to an exact replan command and dispatches only its handler", () => {
    const value = decision({
      kind: "replan_remaining", rationale: "The current path cannot satisfy the mission",
      replanSummary: "Replace the blocked collection stage and keep the validated publication steps",
    });
    const huddle = huddleWith("decided", value);
    const plan = planExceptionHuddleExecution(huddle);
    expect(plan).toStrictEqual({
      ok: true,
      command: {
        kind: "replan_remaining_steps",
        missionId: "mission-1",
        workflowRunId: "run-1",
        sourceStepId: "qa-step",
        replanSummary: "Replace the blocked collection stage and keep the validated publication steps",
        rationale: "The current path cannot satisfy the mission",
        forcedByChair: false,
        idempotencyKey: "huddle-exec:run-1:qa-step:replan_remaining",
      },
    });

    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual(plan);
    expectOnly(spies, "onReplanRemaining");
    expect(spies.onReplanRemaining).toHaveBeenCalledWith(plan.ok ? plan.command : undefined);
  });

  it("maps escalate to an exact operator escalation command and dispatches only its handler", () => {
    const value = decision({
      kind: "escalate", rationale: "The actors disagree about the source contract",
      escalationReason: "Operator must choose the authoritative source contract",
    });
    const huddle = huddleWith("decided", value);
    const plan = planExceptionHuddleExecution(huddle);
    expect(plan).toStrictEqual({
      ok: true,
      command: {
        kind: "escalate_to_operator",
        missionId: "mission-1",
        workflowRunId: "run-1",
        sourceStepId: "qa-step",
        sourceIssueId: "issue-1",
        escalationReason: "Operator must choose the authoritative source contract",
        rationale: "The actors disagree about the source contract",
        forcedByChair: false,
        idempotencyKey: "huddle-exec:run-1:qa-step:escalate",
      },
    });

    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual(plan);
    expectOnly(spies, "onEscalate");
    expect(spies.onEscalate).toHaveBeenCalledWith(plan.ok ? plan.command : undefined);
  });

  it("explicitly guarantees retry_with_guidance never creates a new unblock issue", () => {
    const huddle = huddleWith("decided", decision({
      kind: "retry_with_guidance", rationale: "Retry the same step", guidance: "Use the corrected source",
    }));
    const plan = planExceptionHuddleExecution(huddle);
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.command.kind === "retry_existing_step") {
      expect(plan.command.createUnblockIssue).toBe(false);
      expect(plan.command).not.toHaveProperty("issueTitle");
      expect(plan.command).not.toHaveProperty("newIssue");
    }
  });

  it("is deterministic and does not mutate the validated huddle input", () => {
    const huddle = huddleWith("decided", decision({
      kind: "retry_with_guidance", rationale: "Evidence needs correction", guidance: "Fix the evidence",
    }));
    const before = JSON.parse(JSON.stringify(huddle));
    const first = planExceptionHuddleExecution(huddle);
    expect(planExceptionHuddleExecution(huddle)).toStrictEqual(first);
    expect(huddle).toStrictEqual(before);
  });

  it.each(["open", "timed_out", "cancelled"] as const)("fail-closes %s huddles and invokes zero handlers", (status) => {
    const huddle = huddleWith(status, null);
    expect(planExceptionHuddleExecution(huddle)).toStrictEqual({ ok: false, code: "huddle_decision_not_ready" });
    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual({ ok: false, code: "huddle_decision_not_ready" });
    for (const handler of Object.values(spies)) expect(handler).not.toHaveBeenCalled();
  });

  it("fail-closes a decided huddle whose decision is null and invokes zero handlers", () => {
    const huddle = exceptionHuddleMetadataSchema.parse({
      ...metadataInput,
      status: "decided",
      decision: null,
    });
    expect(planExceptionHuddleExecution(huddle)).toStrictEqual({ ok: false, code: "huddle_decision_not_ready" });
    const spies = handlers();
    expect(executeExceptionHuddleDecision(huddle, spies)).toStrictEqual({ ok: false, code: "huddle_decision_not_ready" });
    for (const handler of Object.values(spies)) expect(handler).not.toHaveBeenCalled();
  });
});

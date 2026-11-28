import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  exceptionHuddleDecisionSchema,
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import { recordExceptionHuddleExecutionPlan } from "../services/missions/exception-huddle-decision-audit.js";
import type { ExceptionHuddleExecutionCommand } from "../services/missions/exception-huddle-executor.js";

const companyId = "company-1";
const threadId = "thread-1";
const now = new Date("2026-11-28T01:03:00.000Z");

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

type DecisionCase = {
  kind: ExceptionHuddleDecision["kind"];
  input: Record<string, unknown>;
  expectedPlan: ExceptionHuddleExecutionCommand;
};

const decisionCases: DecisionCase[] = [
  {
    kind: "retry_with_guidance",
    input: {
      kind: "retry_with_guidance",
      rationale: "Evidence needs correction",
      guidance: "Fix the evidence",
    },
    expectedPlan: {
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
  },
  {
    kind: "accept_with_waiver",
    input: {
      kind: "accept_with_waiver",
      rationale: "Cosmetic issue only",
      waiverCondition: "Alt text is absent on a decorative image",
      forcedByChair: true,
    },
    expectedPlan: {
      kind: "record_waiver_pass",
      workflowRunId: "run-1",
      sourceStepId: "qa-step",
      sourceIssueId: "issue-1",
      waiverCondition: "Alt text is absent on a decorative image",
      rationale: "Cosmetic issue only",
      forcedByChair: true,
      idempotencyKey: "huddle-exec:run-1:qa-step:accept_with_waiver",
    },
  },
  {
    kind: "replan_remaining",
    input: {
      kind: "replan_remaining",
      rationale: "The current path cannot satisfy the mission",
      replanSummary: "Replace the blocked collection stage and keep the validated publication steps",
    },
    expectedPlan: {
      kind: "replan_remaining_steps",
      missionId: "mission-1",
      workflowRunId: "run-1",
      sourceStepId: "qa-step",
      replanSummary: "Replace the blocked collection stage and keep the validated publication steps",
      rationale: "The current path cannot satisfy the mission",
      forcedByChair: false,
      idempotencyKey: "huddle-exec:run-1:qa-step:replan_remaining",
    },
  },
  {
    kind: "escalate",
    input: {
      kind: "escalate",
      rationale: "The actors disagree about the source contract",
      escalationReason: "Operator must choose the authoritative source contract",
    },
    expectedPlan: {
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
  },
];

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

function mockDb(returnedRows: Array<{ id: string }> = [{ id: "event-1" }]) {
  const returning = vi.fn(async () => returnedRows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert } as unknown as Db,
    insert,
    values,
    onConflictDoNothing,
    returning,
  };
}

describe("recordExceptionHuddleExecutionPlan", () => {
  for (const testCase of decisionCases) {
    it(`persists the exact structured audit event for ${testCase.kind}`, async () => {
      const harness = mockDb();
      const huddle = huddleWith("decided", decision(testCase.input));
      const result = await recordExceptionHuddleExecutionPlan(harness.db, { companyId, threadId, huddle, now });

      expect(result).toStrictEqual({ recorded: true, plan: testCase.expectedPlan, inserted: true });
      expect(harness.values).toHaveBeenCalledTimes(1);
      expect(harness.values).toHaveBeenCalledWith({
        companyId,
        missionId: "mission-1",
        workflowRunId: "run-1",
        issueId: "issue-1",
        eventType: "exception_huddle_decision_planned",
        layer: "mission_owner_recovery",
        reasonCode: testCase.kind,
        idempotencyKey: testCase.expectedPlan.idempotencyKey,
        payload: { threadId, plan: testCase.expectedPlan },
        createdAt: now,
      });
      expect(harness.onConflictDoNothing).toHaveBeenCalledTimes(1);
      expect(harness.returning).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps retry_with_guidance from creating an unblock issue in the persisted plan", async () => {
    const retryCase = decisionCases[0]!;
    const harness = mockDb();
    const huddle = huddleWith("decided", decision(retryCase.input));
    const result = await recordExceptionHuddleExecutionPlan(harness.db, { companyId, threadId, huddle, now });

    expect(result).toMatchObject({ recorded: true, inserted: true });
    expect(harness.values).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        threadId,
        plan: expect.objectContaining({ kind: "retry_existing_step", createUnblockIssue: false }),
      },
    }));
  });

  it("returns inserted false cleanly when the idempotency conflict writes zero rows", async () => {
    const harness = mockDb([]);
    const huddle = huddleWith("decided", decision(decisionCases[0]!.input));
    const result = await recordExceptionHuddleExecutionPlan(harness.db, { companyId, threadId, huddle, now });

    expect(result).toStrictEqual({
      recorded: true,
      plan: decisionCases[0]!.expectedPlan,
      inserted: false,
    });
    expect(harness.values).toHaveBeenCalledTimes(1);
    expect(harness.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("fail-closes an undecided open huddle with zero DB writes", async () => {
    const harness = mockDb();
    const huddle = huddleWith("open", null);
    const result = await recordExceptionHuddleExecutionPlan(harness.db, { companyId, threadId, huddle, now });

    expect(result).toStrictEqual({ recorded: false, code: "huddle_decision_not_ready" });
    expect(harness.insert).not.toHaveBeenCalled();
    expect(harness.values).not.toHaveBeenCalled();
    expect(harness.onConflictDoNothing).not.toHaveBeenCalled();
    expect(harness.returning).not.toHaveBeenCalled();
  });
});

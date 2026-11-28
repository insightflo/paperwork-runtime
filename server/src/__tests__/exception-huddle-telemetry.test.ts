import { describe, expect, it } from "vitest";
import {
  exceptionHuddleDecisionSchema,
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import { computeExceptionHuddleTelemetry } from "../services/missions/exception-huddle-telemetry.js";

const baseMetadata: ExceptionHuddleMetadata = {
  schemaVersion: "workflow.exception-huddle.v1" as const,
  missionId: "mission-1",
  workflowRunId: "run-1",
  sourceStepId: "qa-step",
  sourceIssueId: "issue-1",
  workProductLinks: ["/work-products/report.html"],
  participants: { ownerAgentId: "chair", producerAgentId: "writer", validatorAgentId: "reviewer" },
  maxRounds: 2,
  currentRound: 1,
  timeoutAt: "2026-11-28T01:05:00.000Z",
  status: "open" as const,
  decision: null,
  decidedByAgentId: null,
  decidedAt: null,
};

function huddle(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return exceptionHuddleMetadataSchema.parse({ ...baseMetadata, ...overrides });
}

function decision(input: Record<string, unknown>): ExceptionHuddleDecision {
  return exceptionHuddleDecisionSchema.parse(input);
}

function decidedHuddle(
  missionId: string,
  value: ExceptionHuddleDecision,
  currentRound: 1 | 2,
): ExceptionHuddleMetadata {
  return huddle({
    missionId,
    currentRound,
    status: "decided",
    decision: value,
    decidedByAgentId: "chair",
    decidedAt: "2026-11-28T01:04:00.000Z",
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("computeExceptionHuddleTelemetry", () => {
  it("returns zeroed counts and null average rounds for empty input", () => {
    expect(computeExceptionHuddleTelemetry([])).toStrictEqual({
      total: 0,
      byStatus: { open: 0, timed_out: 0, decided: 0, cancelled: 0 },
      byDecisionKind: {
        retry_with_guidance: 0,
        accept_with_waiver: 0,
        replan_remaining: 0,
        escalate: 0,
      },
      byFailureKind: {},
      averageRoundsOnDecided: null,
      timeoutRate: 0,
      chairForcedDecisionCount: 0,
      resolutionRate: 0,
    });
  });

  it("computes exact status, decision, round, rate, and forced-decision metrics", () => {
    const retry = decision({
      kind: "retry_with_guidance",
      rationale: "Evidence needs correction",
      guidance: "Fix the evidence",
    });
    const waiver = decision({
      kind: "accept_with_waiver",
      rationale: "Cosmetic issue only",
      waiverCondition: "Decorative image alt text is absent",
      forcedByChair: true,
    });
    const replan = decision({
      kind: "replan_remaining",
      rationale: "The remaining path is invalid",
      replanSummary: "Replace the blocked collection stage",
    });
    const escalate = decision({
      kind: "escalate",
      rationale: "Operator authority is required",
      escalationReason: "The waiver changes mission scope",
      forcedByChair: true,
    });

    const summary = computeExceptionHuddleTelemetry([
      huddle({ missionId: "open-huddle", status: "open" }),
      huddle({ missionId: "first-timeout", status: "timed_out", currentRound: 2 }),
      huddle({ missionId: "second-timeout", status: "timed_out", currentRound: 2 }),
      huddle({ missionId: "cancelled-huddle", status: "cancelled" }),
      decidedHuddle("retry-huddle", retry, 1),
      decidedHuddle("waiver-huddle", waiver, 2),
      decidedHuddle("replan-huddle", replan, 2),
      decidedHuddle("escalate-huddle", escalate, 1),
    ]);

    expect(summary).toStrictEqual({
      total: 8,
      byStatus: { open: 1, timed_out: 2, decided: 4, cancelled: 1 },
      byDecisionKind: {
        retry_with_guidance: 1,
        accept_with_waiver: 1,
        replan_remaining: 1,
        escalate: 1,
      },
      byFailureKind: {},
      averageRoundsOnDecided: 1.5,
      timeoutRate: 0.25,
      chairForcedDecisionCount: 2,
      resolutionRate: 0.5,
    });
  });

  it("rounds average rounds to two decimals and rates to four decimals", () => {
    const retry = decision({
      kind: "retry_with_guidance",
      rationale: "Evidence needs correction",
      guidance: "Fix the evidence",
    });
    const summary = computeExceptionHuddleTelemetry([
      decidedHuddle("round-one", retry, 1),
      decidedHuddle("round-two-first", retry, 2),
      decidedHuddle("round-two-second", retry, 2),
      huddle({ missionId: "timeout-one", status: "timed_out", currentRound: 2 }),
      huddle({ missionId: "timeout-two", status: "timed_out", currentRound: 2 }),
      huddle({ missionId: "cancelled", status: "cancelled" }),
    ]);

    expect(summary.averageRoundsOnDecided).toBe(1.67);
    expect(summary.timeoutRate).toBe(0.3333);
    expect(summary.resolutionRate).toBe(0.5);
  });

  it("counts structured failure keys exactly, preferring failureKind over triggerKind", () => {
    const withSignals = (signals: Record<string, unknown>) => ({
      ...huddle(),
      ...signals,
    }) as ExceptionHuddleMetadata;

    const summary = computeExceptionHuddleTelemetry([
      withSignals({ failureKind: "qa_rejection" }),
      withSignals({ failureKind: "qa_rejection", triggerKind: "first_qa_failure" }),
      withSignals({ triggerKind: "timeout" }),
      withSignals({ failureKind: "   ", triggerKind: "" }),
    ]);

    expect(summary.byFailureKind).toStrictEqual({ qa_rejection: 2, timeout: 1 });
  });

  it("never mutates the input array or nested huddle metadata", () => {
    const retry = decision({
      kind: "retry_with_guidance",
      rationale: "Evidence needs correction",
      guidance: "Fix the evidence",
    });
    const huddles = deepFreeze([
      huddle({ missionId: "open-huddle", status: "open" }),
      decidedHuddle("decided-huddle", retry, 2),
    ]);
    const before = JSON.stringify(huddles);

    expect(() => computeExceptionHuddleTelemetry(huddles)).not.toThrow();
    expect(JSON.stringify(huddles)).toBe(before);
  });
});

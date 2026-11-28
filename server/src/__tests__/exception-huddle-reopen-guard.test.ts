import { describe, expect, it } from "vitest";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import {
  evaluateExceptionHuddleReopenGuard,
  type ActiveHuddleCandidate,
} from "../services/missions/exception-huddle-reopen-guard.js";

const target = { missionId: "mission-1", sourceStepId: "step-1", workflowRunId: "run-1" };

function huddle(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return exceptionHuddleMetadataSchema.parse({
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    sourceStepId: "step-1",
    sourceIssueId: "issue-1",
    workProductLinks: [],
    participants: {
      ownerAgentId: "owner-1",
      producerAgentId: "producer-1",
      validatorAgentId: "validator-1",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  });
}

function candidate(
  huddleMetadata: ExceptionHuddleMetadata,
  threadId = "thread-1",
  channelId = "channel-1",
): ActiveHuddleCandidate {
  return { threadId, channelId, huddle: huddleMetadata };
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

describe("evaluateExceptionHuddleReopenGuard", () => {
  it("blocks convening when the same mission step run already has an open huddle", () => {
    const open = candidate(huddle({ status: "open" }), "thread-open", "channel-open");

    expect(evaluateExceptionHuddleReopenGuard(target, [open])).toEqual({
      allowed: false,
      reason: "duplicate_active_huddle",
      existingThreadId: "thread-open",
      existingChannelId: "channel-open",
      existingStatus: "open",
    });
  });

  it("blocks on a timed-out huddle and prefers it over an open huddle", () => {
    const open = candidate(huddle({ status: "open" }), "thread-open", "channel-open");
    const timedOut = candidate(huddle({ status: "timed_out" }), "thread-timed-out", "channel-timed-out");

    expect(evaluateExceptionHuddleReopenGuard(target, [open, timedOut])).toEqual({
      allowed: false,
      reason: "duplicate_active_huddle",
      existingThreadId: "thread-timed-out",
      existingChannelId: "channel-timed-out",
      existingStatus: "timed_out",
    });
  });

  it.each(["decided", "cancelled"] as const)("allows convening when the matching huddle is %s", (status) => {
    const terminal = candidate(huddle({ status }), `thread-${status}`, `channel-${status}`);

    expect(evaluateExceptionHuddleReopenGuard(target, [terminal])).toEqual({ allowed: true });
  });

  it("allows convening when active huddles belong to another source step or workflow run", () => {
    const otherStep = candidate(
      huddle({ sourceStepId: "step-2", status: "open" }),
      "thread-other-step",
      "channel-other-step",
    );
    const otherRun = candidate(
      huddle({ workflowRunId: "run-2", status: "timed_out" }),
      "thread-other-run",
      "channel-other-run",
    );

    expect(evaluateExceptionHuddleReopenGuard(target, [otherStep, otherRun])).toEqual({ allowed: true });
  });

  it("allows convening when no candidates match the target mission and step", () => {
    const otherMission = candidate(
      huddle({ missionId: "mission-2", status: "open" }),
      "thread-other-mission",
      "channel-other-mission",
    );

    expect(evaluateExceptionHuddleReopenGuard(target, [])).toEqual({ allowed: true });
    expect(evaluateExceptionHuddleReopenGuard(target, [otherMission])).toEqual({ allowed: true });
  });

  it("matches every workflow run for the mission step when the target run is omitted", () => {
    const otherRun = candidate(huddle({ workflowRunId: "run-2", status: "open" }), "thread-open", "channel-open");

    expect(evaluateExceptionHuddleReopenGuard(
      { missionId: target.missionId, sourceStepId: target.sourceStepId },
      [otherRun],
    )).toMatchObject({ allowed: false, existingStatus: "open" });
  });

  it("does not mutate the target, candidates, or nested huddle metadata", () => {
    const frozenTarget = { ...target };
    const existing = [candidate(huddle({ status: "timed_out" }), "thread-frozen", "channel-frozen")];
    deepFreeze(frozenTarget);
    deepFreeze(existing);
    const before = JSON.stringify({ target: frozenTarget, existing });

    expect(evaluateExceptionHuddleReopenGuard(frozenTarget, existing)).toEqual({
      allowed: false,
      reason: "duplicate_active_huddle",
      existingThreadId: "thread-frozen",
      existingChannelId: "channel-frozen",
      existingStatus: "timed_out",
    });
    expect(JSON.stringify({ target: frozenTarget, existing })).toBe(before);
  });
});

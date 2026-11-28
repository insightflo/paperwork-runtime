import { describe, expect, it, vi } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  evaluateHuddleTimeout,
  sweepTimedOutExceptionHuddles,
  type ExceptionHuddleTimeoutChairWakeup,
} from "../services/missions/exception-huddle-timeout.js";

const timeoutAt = "2026-11-28T01:05:00.000Z";
const timeout = new Date(timeoutAt);
const expectedIdempotencyKey = `huddle-timeout-chair:run-1:qa-step:${timeoutAt}`;

function huddle(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    sourceStepId: "qa-step",
    sourceIssueId: "issue-1",
    workProductLinks: ["work-product://draft-report"],
    participants: {
      ownerAgentId: "chair",
      producerAgentId: "producer",
      validatorAgentId: "validator",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt,
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function sweepHarness(huddles: ExceptionHuddleMetadata[], markResult: boolean) {
  const listOpenHuddles = vi.fn(async () => huddles);
  const markTimedOut = vi.fn(async (_nextState: ExceptionHuddleMetadata) => markResult);
  const enqueueChairWakeup = vi.fn(async (_wakeup: ExceptionHuddleTimeoutChairWakeup) => undefined);
  return {
    deps: { listOpenHuddles, markTimedOut, enqueueChairWakeup },
    listOpenHuddles,
    markTimedOut,
    enqueueChairWakeup,
  };
}

describe("evaluateHuddleTimeout", () => {
  it("leaves an open huddle untouched before the five-minute deadline", () => {
    const open = huddle();
    const beforeDeadline = new Date(timeout.getTime() - 1);
    expect(evaluateHuddleTimeout(open, beforeDeadline)).toEqual({ expired: false });
  });

  it.each([0, 1])("times out an open huddle at deadline plus %i ms with a deterministic chair wakeup", (offset) => {
    const open = huddle();
    const evaluation = evaluateHuddleTimeout(open, new Date(timeout.getTime() + offset));
    expect(evaluation).toEqual({
      expired: true,
      nextState: { ...open, status: "timed_out" },
      chairWakeup: {
        agentId: "chair",
        idempotencyKey: expectedIdempotencyKey,
        reason: "exception_huddle_timeout_chair_decision_required",
      },
    });
    expect(open.status).toBe("open");
  });

  it.each(["timed_out", "decided", "cancelled"] as const)("skips an already %s huddle", (status) => {
    expect(evaluateHuddleTimeout(huddle({ status }), timeout)).toEqual({ expired: false });
  });
});

describe("sweepTimedOutExceptionHuddles", () => {
  it("does not transition or wake an open huddle before the five-minute deadline", async () => {
    const { deps, markTimedOut, enqueueChairWakeup } = sweepHarness([huddle()], true);
    const result = await sweepTimedOutExceptionHuddles(deps, new Date(timeout.getTime() - 1));
    expect(result).toEqual({ scanned: 1, timedOut: 0, wakeupsEnqueued: 0, skipped: 1 });
    expect(markTimedOut).not.toHaveBeenCalled();
    expect(enqueueChairWakeup).not.toHaveBeenCalled();
  });

  it.each([0, 60_000])("transitions an expired open huddle once and wakes only the owner chair at +%i ms", async (offset) => {
    const open = huddle();
    const { deps, markTimedOut, enqueueChairWakeup } = sweepHarness([open], true);
    const result = await sweepTimedOutExceptionHuddles(deps, new Date(timeout.getTime() + offset));
    expect(result).toEqual({ scanned: 1, timedOut: 1, wakeupsEnqueued: 1, skipped: 0 });
    expect(markTimedOut).toHaveBeenCalledTimes(1);
    expect(markTimedOut).toHaveBeenCalledWith({ ...open, status: "timed_out" });
    expect(enqueueChairWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueChairWakeup).toHaveBeenCalledWith({
      agentId: "chair",
      idempotencyKey: expectedIdempotencyKey,
      reason: "exception_huddle_timeout_chair_decision_required",
    });
  });

  it.each(["timed_out", "decided", "cancelled"] as const)(
    "skips an already %s huddle with zero transitions and zero wakeups",
    async (status) => {
      const { deps, markTimedOut, enqueueChairWakeup } = sweepHarness([huddle({ status })], true);
      const result = await sweepTimedOutExceptionHuddles(deps, timeout);
      expect(result).toEqual({ scanned: 1, timedOut: 0, wakeupsEnqueued: 0, skipped: 1 });
      expect(markTimedOut).not.toHaveBeenCalled();
      expect(enqueueChairWakeup).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue a chair wakeup when the timeout transition loses the race", async () => {
    const open = huddle();
    const { deps, markTimedOut, enqueueChairWakeup } = sweepHarness([open], false);
    const result = await sweepTimedOutExceptionHuddles(deps, timeout);
    expect(result).toEqual({ scanned: 1, timedOut: 0, wakeupsEnqueued: 0, skipped: 1 });
    expect(markTimedOut).toHaveBeenCalledTimes(1);
    expect(markTimedOut).toHaveBeenCalledWith({ ...open, status: "timed_out" });
    expect(enqueueChairWakeup).not.toHaveBeenCalled();
  });
});

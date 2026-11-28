import { describe, expect, it } from "vitest";
import {
  planCooperativePreemption,
  type PreemptionLane,
  type RunningSlotCandidate,
} from "../services/heartbeat-preemption-planner.js";

function candidate(overrides: Partial<RunningSlotCandidate> = {}): RunningSlotCandidate {
  return {
    runId: "run-scheduled",
    lane: "scheduled",
    startedAtMs: 84_000,
    ...overrides,
  };
}

function plan(input: {
  incomingLane?: PreemptionLane;
  running?: readonly RunningSlotCandidate[];
  maxSlots?: number;
  nowMs?: number;
  minAgeForPreemptionMs?: number;
}) {
  return planCooperativePreemption({
    incomingLane: input.incomingLane ?? "interactive",
    running: input.running ?? [candidate()],
    maxSlots: input.maxSlots ?? 1,
    nowMs: input.nowMs ?? 100_000,
    minAgeForPreemptionMs: input.minAgeForPreemptionMs,
  });
}

describe("planCooperativePreemption", () => {
  it("does not preempt when a slot is free", () => {
    expect(plan({ running: [], maxSlots: 1 })).toEqual({
      shouldPreempt: false,
      targetRunId: null,
      reason: "Free slot available",
    });
  });

  it("does not preempt for non-interactive incoming lanes", () => {
    for (const incomingLane of ["recovery", "workflow", "scheduled"] as const) {
      const result = plan({ incomingLane });
      expect(result.shouldPreempt).toBe(false);
      expect(result.targetRunId).toBeNull();
    }
  });

  it("protects scheduled runs in a critical section", () => {
    const result = plan({
      running: [candidate({ inCriticalSection: true })],
    });

    expect(result).toEqual({
      shouldPreempt: false,
      targetRunId: null,
      reason: "No eligible scheduled run available",
    });
  });

  it("protects scheduled runs that already have a yield request", () => {
    const result = plan({
      running: [candidate({ alreadyYieldRequested: true })],
    });

    expect(result).toEqual({
      shouldPreempt: false,
      targetRunId: null,
      reason: "No eligible scheduled run available",
    });
  });

  it("protects scheduled runs younger than the minimum preemption age", () => {
    const tooYoung = plan({
      running: [candidate({ startedAtMs: 85_001 })],
    });
    expect(tooYoung.shouldPreempt).toBe(false);
    expect(tooYoung.targetRunId).toBeNull();

    const exactlyOldEnough = plan({
      running: [candidate({ startedAtMs: 85_000 })],
    });
    expect(exactlyOldEnough).toEqual({
      shouldPreempt: true,
      targetRunId: "run-scheduled",
      reason: "Selected youngest eligible scheduled run",
    });
  });

  it("selects the youngest eligible scheduled run and never targets protected lanes", () => {
    const result = plan({
      running: [
        candidate({ runId: "interactive-old", lane: "interactive", startedAtMs: 0 }),
        candidate({ runId: "recovery-old", lane: "recovery", startedAtMs: 0 }),
        candidate({ runId: "workflow-old", lane: "workflow", startedAtMs: 0 }),
        candidate({ runId: "scheduled-oldest", startedAtMs: 60_000 }),
        candidate({ runId: "scheduled-youngest", startedAtMs: 84_000 }),
      ],
    });

    expect(result).toEqual({
      shouldPreempt: true,
      targetRunId: "scheduled-youngest",
      reason: "Selected youngest eligible scheduled run",
    });
  });

  it("breaks equal-age ties by run id ascending", () => {
    const result = plan({
      running: [
        candidate({ runId: "run-z", startedAtMs: 84_000 }),
        candidate({ runId: "run-a", startedAtMs: 84_000 }),
      ],
      maxSlots: 2,
    });

    expect(result.shouldPreempt).toBe(true);
    expect(result.targetRunId).toBe("run-a");
  });
});

import { describe, expect, it } from "vitest";
import { evaluateSlotRebalance } from "../services/heartbeat-slot-drain-policy.js";

describe("heartbeat slot drain policy", () => {
  it("admits queued runs when scaling up from 1 to 4", () => {
    const decision = evaluateSlotRebalance({
      maxConcurrentRuns: 4,
      runningRunIds: ["run-1"],
      queuedRunIds: ["run-2", "run-3", "run-4", "run-5"],
    });

    expect(decision).toEqual({
      effectiveMaxSlots: 4,
      inFlightCount: 1,
      overCapacityCount: 0,
      admitCount: 3,
      runIdsToAdmit: ["run-2", "run-3", "run-4"],
      mode: "admit",
    });
  });

  it("does not admit queued runs at exact capacity", () => {
    const decision = evaluateSlotRebalance({
      maxConcurrentRuns: 2,
      runningRunIds: ["run-1", "run-2"],
      queuedRunIds: ["run-3", "run-4"],
    });

    expect(decision).toEqual({
      effectiveMaxSlots: 2,
      inFlightCount: 2,
      overCapacityCount: 0,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "at_capacity",
    });
  });

  it("drains excess in-flight runs gracefully after scaling down", () => {
    const decision = evaluateSlotRebalance({
      maxConcurrentRuns: 2,
      runningRunIds: ["run-1", "run-2", "run-3"],
      queuedRunIds: ["run-4", "run-5"],
    });

    expect(decision).toEqual({
      effectiveMaxSlots: 2,
      inFlightCount: 3,
      overCapacityCount: 1,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "draining_excess",
    });
  });

  it("pauses admissions while draining without cancelling in-flight runs", () => {
    const decision = evaluateSlotRebalance({
      maxConcurrentRuns: 4,
      runningRunIds: ["run-1"],
      queuedRunIds: ["run-2", "run-3"],
      draining: true,
    });

    expect(decision).toEqual({
      effectiveMaxSlots: 4,
      inFlightCount: 1,
      overCapacityCount: 0,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "paused_drain",
    });
  });

  it.each([0, -2, 0.5, Number.NaN])(
    "clamps invalid maxConcurrentRuns=%s to one slot",
    (maxConcurrentRuns) => {
      const decision = evaluateSlotRebalance({
        maxConcurrentRuns,
        runningRunIds: [],
        queuedRunIds: ["run-1", "run-2"],
      });

      expect(decision).toEqual({
        effectiveMaxSlots: 1,
        inFlightCount: 0,
        overCapacityCount: 0,
        admitCount: 1,
        runIdsToAdmit: ["run-1"],
        mode: "admit",
      });
    },
  );
});

import { describe, expect, it } from "vitest";
import { evaluateQueueBackpressure } from "../services/heartbeat-backpressure-gate.js";

describe("evaluateQueueBackpressure", () => {
  it.each(["interactive", "recovery"] as const)(
    "always admits the %s lane even under extreme queue depth",
    (lane) => {
      expect(
        evaluateQueueBackpressure({
          lane,
          currentQueuedCount: Number.MAX_SAFE_INTEGER,
          maxSlots: 2,
        }),
      ).toEqual({
        admit: true,
        reason: "always_admit_priority_lane",
        highWaterMark: Infinity,
      });
    },
  );

  it("admits scheduled work below four times maxSlots and sheds at the high-water mark", () => {
    expect(
      evaluateQueueBackpressure({
        lane: "scheduled",
        currentQueuedCount: 11,
        maxSlots: 3,
      }),
    ).toEqual({
      admit: true,
      reason: "ok",
      highWaterMark: 12,
    });

    expect(
      evaluateQueueBackpressure({
        lane: "scheduled",
        currentQueuedCount: 12,
        maxSlots: 3,
      }),
    ).toEqual({
      admit: false,
      reason: "scheduled_backpressure_shed",
      highWaterMark: 12,
    });
  });

  it("admits workflow work below eight times maxSlots and sheds at the high-water mark", () => {
    expect(
      evaluateQueueBackpressure({
        lane: "workflow",
        currentQueuedCount: 23,
        maxSlots: 3,
      }),
    ).toEqual({
      admit: true,
      reason: "ok",
      highWaterMark: 24,
    });

    expect(
      evaluateQueueBackpressure({
        lane: "workflow",
        currentQueuedCount: 24,
        maxSlots: 3,
      }),
    ).toEqual({
      admit: false,
      reason: "workflow_backpressure_shed",
      highWaterMark: 24,
    });
  });

  it("uses custom lane multipliers when provided", () => {
    expect(
      evaluateQueueBackpressure({
        lane: "scheduled",
        currentQueuedCount: 6,
        maxSlots: 4,
        scheduledHighWaterMultiplier: 1.5,
      }),
    ).toEqual({
      admit: false,
      reason: "scheduled_backpressure_shed",
      highWaterMark: 6,
    });

    expect(
      evaluateQueueBackpressure({
        lane: "workflow",
        currentQueuedCount: 9,
        maxSlots: 5,
        workflowHighWaterMultiplier: 2,
      }),
    ).toEqual({
      admit: true,
      reason: "ok",
      highWaterMark: 10,
    });
  });

  it("clamps zero and fractional maxSlots to at least one whole slot", () => {
    expect(
      evaluateQueueBackpressure({
        lane: "scheduled",
        currentQueuedCount: 4,
        maxSlots: 0,
      }),
    ).toEqual({
      admit: false,
      reason: "scheduled_backpressure_shed",
      highWaterMark: 4,
    });

    expect(
      evaluateQueueBackpressure({
        lane: "workflow",
        currentQueuedCount: 7,
        maxSlots: 1.9,
      }),
    ).toEqual({
      admit: true,
      reason: "ok",
      highWaterMark: 8,
    });
  });
});

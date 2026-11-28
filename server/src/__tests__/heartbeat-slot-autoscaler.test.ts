import { describe, expect, it } from "vitest";
import { evaluateSlotAutoscale } from "../services/heartbeat-slot-autoscaler.js";

describe("evaluateSlotAutoscale", () => {
  it("scales up under backlog pressure", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 2, runningCount: 2, queuedCount: 5 })).toEqual({
      action: "scale_up",
      targetSlots: 4,
      delta: 2,
      reason: "queue pressure meets or exceeds current slots",
    });
  });

  it("scales down when the queue is empty and slots are mostly idle", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 4, runningCount: 1, queuedCount: 0 })).toEqual({
      action: "scale_down",
      targetSlots: 3,
      delta: -1,
      reason: "queue empty and running count below half of current slots",
    });
  });

  it.each([
    { burnThrottleActive: true },
    { providerCoolingDown: true },
    { burnThrottleActive: true, providerCoolingDown: true },
  ])("immediately scales down to minimum slots when constrained: %o", (constraint) => {
    expect(
      evaluateSlotAutoscale({ currentSlots: 6, runningCount: 5, queuedCount: 9, ...constraint }),
    ).toEqual({
      action: "scale_down",
      targetSlots: 1,
      delta: -5,
      reason: "burn throttle or provider cooldown active",
    });
  });

  it("holds at minimum slots when a constraint is already fully applied", () => {
    expect(
      evaluateSlotAutoscale({ currentSlots: 1, runningCount: 0, queuedCount: 0, burnThrottleActive: true }),
    ).toEqual({
      action: "hold",
      targetSlots: 1,
      delta: 0,
      reason: "burn throttle or provider cooldown active; already at minimum slots",
    });
  });

  it("holds at steady state", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 4, runningCount: 2, queuedCount: 1 })).toEqual({
      action: "hold",
      targetSlots: 4,
      delta: 0,
      reason: "slot count is steady",
    });
  });

  it("does not scale past maxSlots", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 9, runningCount: 9, queuedCount: 20 })).toEqual({
      action: "scale_up",
      targetSlots: 10,
      delta: 1,
      reason: "queue pressure meets or exceeds current slots",
    });
  });

  it("does not scale below minSlots while idle", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 1, runningCount: 0, queuedCount: 0 })).toEqual({
      action: "hold",
      targetSlots: 1,
      delta: 0,
      reason: "slot count is steady",
    });
  });

  it("honors custom slot bounds", () => {
    expect(
      evaluateSlotAutoscale({
        currentSlots: 3,
        runningCount: 3,
        queuedCount: 8,
        minSlots: 2,
        maxSlots: 5,
      }),
    ).toEqual({
      action: "scale_up",
      targetSlots: 5,
      delta: 2,
      reason: "queue pressure meets or exceeds current slots",
    });

    expect(
      evaluateSlotAutoscale({
        currentSlots: 4,
        runningCount: 0,
        queuedCount: 0,
        minSlots: 2,
        maxSlots: 5,
      }),
    ).toEqual({
      action: "scale_down",
      targetSlots: 3,
      delta: -1,
      reason: "queue empty and running count below half of current slots",
    });
  });

  it("clamps currentSlots into the configured bounds before deciding", () => {
    expect(evaluateSlotAutoscale({ currentSlots: 99, runningCount: 0, queuedCount: 1 })).toEqual({
      action: "hold",
      targetSlots: 10,
      delta: 0,
      reason: "slot count is steady",
    });

    expect(evaluateSlotAutoscale({ currentSlots: 0, runningCount: 0, queuedCount: 1 })).toEqual({
      action: "scale_up",
      targetSlots: 2,
      delta: 1,
      reason: "queue pressure meets or exceeds current slots",
    });
  });
});

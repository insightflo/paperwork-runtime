import { describe, expect, it } from "vitest";
import {
  evaluateQueueRemediation,
  type AgentQueuePressureInput,
} from "../services/heartbeat-starvation-remediator.js";

const baseInput: AgentQueuePressureInput = {
  agentId: "agent-1",
  maxConcurrentRuns: 2,
  runningCount: 2,
  queuedCount: 3,
  oldestQueuedWaitMs: 0,
};

function evaluate(
  overrides: Partial<AgentQueuePressureInput> = {},
  opts?: Parameters<typeof evaluateQueueRemediation>[1],
) {
  return evaluateQueueRemediation({ ...baseInput, ...overrides }, opts);
}

describe("evaluateQueueRemediation", () => {
  it("returns none when there are no queued runs", () => {
    const result = evaluate({ queuedCount: 0, oldestQueuedWaitMs: 600_000 });

    expect(result).toEqual({
      agentId: "agent-1",
      action: "none",
      reason: "No queued runs",
    });
  });

  it("waits during provider cooldown even when queued runs are starving", () => {
    const result = evaluate({
      oldestQueuedWaitMs: 600_000,
      providerCoolingDown: true,
    });

    expect(result).toEqual({
      agentId: "agent-1",
      action: "provider_cooldown_wait",
      reason: "Provider cooldown active; waiting before dispatch",
    });
  });

  it("recommends doubling slots when starvation coincides with saturation", () => {
    const result = evaluate({ oldestQueuedWaitMs: 600_000 });

    expect(result.action).toBe("recommend_slot_increase");
    expect(result.suggestedSlots).toBe(4);
    expect(result.reason).toContain("increase capacity to 4 slots");
  });

  it("caps slot doubling at the default maximum of ten recommended slots", () => {
    const result = evaluate({
      maxConcurrentRuns: 6,
      runningCount: 6,
      oldestQueuedWaitMs: 600_000,
    });

    expect(result.action).toBe("recommend_slot_increase");
    expect(result.suggestedSlots).toBe(10);
  });

  it("promotes an aged run when starvation is saturated at the recommendation cap", () => {
    const result = evaluate({
      maxConcurrentRuns: 10,
      runningCount: 10,
      oldestQueuedWaitMs: 600_000,
    });

    expect(result.action).toBe("promote_aged_run");
    expect(result.suggestedSlots).toBeUndefined();
    expect(result.reason).toContain("recommendation cap");
  });

  it("promotes an aged run when starvation is not saturated", () => {
    const result = evaluate({
      maxConcurrentRuns: 3,
      runningCount: 1,
      oldestQueuedWaitMs: 600_000,
    });

    expect(result.action).toBe("promote_aged_run");
    expect(result.suggestedSlots).toBeUndefined();
    expect(result.reason).toContain("promote the aged run");
  });

  it("returns none while queue wait remains within healthy bounds", () => {
    const result = evaluate({ oldestQueuedWaitMs: 599_999 });

    expect(result).toEqual({
      agentId: "agent-1",
      action: "none",
      reason: "Queue within healthy wait bounds",
    });
  });

  it("honors custom starvation and slot recommendation options", () => {
    const result = evaluate(
      {
        maxConcurrentRuns: 1,
        runningCount: 1,
        oldestQueuedWaitMs: 1_000,
      },
      { starvationThresholdMs: 1_000, maxRecommendedSlots: 3 },
    );

    expect(result.action).toBe("recommend_slot_increase");
    expect(result.suggestedSlots).toBe(2);
  });
});

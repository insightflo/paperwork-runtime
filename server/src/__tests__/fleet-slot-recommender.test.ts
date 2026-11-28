import { describe, expect, it } from "vitest";
import {
  rebalanceFleetSlotBudget,
  type FleetAgentDemand,
} from "../services/fleet-slot-recommender.js";

describe("rebalanceFleetSlotBudget", () => {
  it("returns no allocations for empty input", () => {
    expect(rebalanceFleetSlotBudget([], 12)).toEqual([]);
  });

  it("guarantees one slot per agent when the budget is tighter than the fleet", () => {
    const result = rebalanceFleetSlotBudget([
      { agentId: "agent-b", currentSlots: 4, queuedCount: 9 },
      { agentId: "agent-a", currentSlots: 0, queuedCount: 0 },
      { agentId: "agent-c", currentSlots: 2, queuedCount: 3, maxCap: 1 },
    ], 2);

    expect(result).toEqual([
      { agentId: "agent-b", currentSlots: 4, recommendedSlots: 1, delta: -3 },
      { agentId: "agent-a", currentSlots: 0, recommendedSlots: 1, delta: 1 },
      { agentId: "agent-c", currentSlots: 2, recommendedSlots: 1, delta: -1 },
    ]);
  });

  it("allocates extra budget by demand pressure while idle agents keep only the floor", () => {
    const result = rebalanceFleetSlotBudget([
      { agentId: "busy", currentSlots: 2, queuedCount: 12 },
      { agentId: "idle", currentSlots: 3, queuedCount: 0 },
      { agentId: "helper", currentSlots: 1, queuedCount: 3 },
    ], 7);

    expect(result).toEqual([
      { agentId: "busy", currentSlots: 2, recommendedSlots: 5, delta: 3 },
      { agentId: "idle", currentSlots: 3, recommendedSlots: 1, delta: -2 },
      { agentId: "helper", currentSlots: 1, recommendedSlots: 1, delta: 0 },
    ]);
  });

  it("stops assigning extra slots at each agent maxCap", () => {
    const result = rebalanceFleetSlotBudget([
      { agentId: "capped-heavy", currentSlots: 0, queuedCount: 20, maxCap: 2 },
      { agentId: "quiet", currentSlots: 4, queuedCount: 0 },
      { agentId: "capped-medium", currentSlots: 1, queuedCount: 4, maxCap: 3 },
    ], 10);

    expect(result).toEqual([
      { agentId: "capped-heavy", currentSlots: 0, recommendedSlots: 2, delta: 2 },
      { agentId: "quiet", currentSlots: 4, recommendedSlots: 1, delta: -3 },
      { agentId: "capped-medium", currentSlots: 1, recommendedSlots: 3, delta: 2 },
    ]);
  });

  it("breaks equal-pressure ties by agentId and preserves input order without mutating it", () => {
    const input: FleetAgentDemand[] = [
      { agentId: "gamma", currentSlots: 0, queuedCount: 4 },
      { agentId: "alpha", currentSlots: 0, queuedCount: 4 },
      { agentId: "beta", currentSlots: 0, queuedCount: 4 },
    ];
    const inputSnapshot = input.map((agent) => ({ ...agent }));

    const first = rebalanceFleetSlotBudget(input, 4);
    const second = rebalanceFleetSlotBudget(input, 4);

    expect(first).toEqual(second);
    expect(first).toEqual([
      { agentId: "gamma", currentSlots: 0, recommendedSlots: 1, delta: 1 },
      { agentId: "alpha", currentSlots: 0, recommendedSlots: 2, delta: 2 },
      { agentId: "beta", currentSlots: 0, recommendedSlots: 1, delta: 1 },
    ]);
    expect(input).toEqual(inputSnapshot);
  });
});

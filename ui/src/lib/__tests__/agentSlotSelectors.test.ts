import { describe, expect, it } from "vitest";
import {
  getAgentSlotUsage,
  indexAgentSlotTelemetry,
  sortAgentsByQueuePressure,
  type AgentSlotTelemetryEntry,
} from "../agentSlotSelectors";

function telemetry(
  overrides: Partial<AgentSlotTelemetryEntry> & { agentId: string },
): AgentSlotTelemetryEntry {
  return {
    maxConcurrentRuns: 2,
    runningCount: 0,
    queuedCount: 0,
    utilizationRatio: 0,
    saturated: false,
    oldestQueuedWaitMs: 0,
    starvationWarning: false,
    ...overrides,
  };
}

describe("indexAgentSlotTelemetry", () => {
  it("indexes telemetry entries by agent id", () => {
    const alpha = telemetry({ agentId: "agent-a", runningCount: 1 });
    const beta = telemetry({ agentId: "agent-b", queuedCount: 3 });

    const indexed = indexAgentSlotTelemetry([alpha, beta]);

    expect(indexed.size).toBe(2);
    expect(indexed.get("agent-a")).toBe(alpha);
    expect(indexed.get("agent-b")).toBe(beta);
  });
});

describe("getAgentSlotUsage", () => {
  it("returns live slot usage for an agent present in telemetry", () => {
    const entry = telemetry({
      agentId: "agent-a",
      maxConcurrentRuns: 3,
      runningCount: 2,
      queuedCount: 4,
      starvationWarning: true,
    });
    const indexed = indexAgentSlotTelemetry([entry]);

    expect(getAgentSlotUsage(indexed, "agent-a", 8)).toEqual({
      runningCount: 2,
      maxConcurrentRuns: 3,
      queuedCount: 4,
      starving: true,
    });
  });

  it("returns zero pressure and a clamped fallback slot count for an absent agent", () => {
    const indexed = indexAgentSlotTelemetry([]);

    expect(getAgentSlotUsage(indexed, "missing")).toEqual({
      runningCount: 0,
      maxConcurrentRuns: 1,
      queuedCount: 0,
      starving: false,
    });
    expect(getAgentSlotUsage(indexed, "missing", 0).maxConcurrentRuns).toBe(1);
    expect(getAgentSlotUsage(indexed, "missing", -4).maxConcurrentRuns).toBe(1);
    expect(getAgentSlotUsage(indexed, "missing", 4).maxConcurrentRuns).toBe(4);
  });
});

describe("sortAgentsByQueuePressure", () => {
  it("sorts by starvation, queued count, running count, then display name", () => {
    const entries = [
      telemetry({ agentId: "agent-s", starvationWarning: true }),
      telemetry({ agentId: "agent-q", queuedCount: 6 }),
      telemetry({ agentId: "agent-r", queuedCount: 2, runningCount: 4 }),
      telemetry({ agentId: "agent-z", queuedCount: 2, runningCount: 1 }),
      telemetry({ agentId: "agent-b", queuedCount: 2, runningCount: 1 }),
      telemetry({ agentId: "agent-c", queuedCount: 2, runningCount: 1 }),
    ];
    const agents = [
      { id: "agent-z", name: "Zed" },
      { id: "agent-c", name: "Alpha" },
      { id: "agent-r", name: "Runner" },
      { id: "agent-m", name: "Missing" },
      { id: "agent-s", name: "Starved" },
      { id: "agent-q", name: "Queued" },
      { id: "agent-b", name: "Alpha" },
    ];

    const sorted = sortAgentsByQueuePressure(agents, indexAgentSlotTelemetry(entries));

    expect(sorted.map((agent) => agent.id)).toEqual([
      "agent-s",
      "agent-q",
      "agent-r",
      "agent-b",
      "agent-c",
      "agent-z",
      "agent-m",
    ]);
  });

  it("uses id as the display name when name is absent", () => {
    const agents = [{ id: "zulu" }, { id: "alpha" }];

    const sorted = sortAgentsByQueuePressure(agents, indexAgentSlotTelemetry([]));

    expect(sorted.map((agent) => agent.id)).toEqual(["alpha", "zulu"]);
  });

  it("does not mutate the input array", () => {
    const agents = [
      { id: "agent-b", name: "Beta" },
      { id: "agent-a", name: "Alpha" },
    ];
    const originalOrder = [...agents];

    const sorted = sortAgentsByQueuePressure(agents, indexAgentSlotTelemetry([]));

    expect(sorted).not.toBe(agents);
    expect(agents).toEqual(originalOrder);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-b", "agent-a"]);
  });
});

import { expect, it } from "vitest";
import {
  computeJainFairnessIndex,
  evaluateFleetFairness,
} from "../services/heartbeat-slot-fairness-score.js";

it("scores perfect balance as balanced with a Jain index of 1", () => {
  const result = evaluateFleetFairness([
    { agentId: "agent-a", completedRuns: 4, queuedRuns: 0 },
    { agentId: "agent-b", completedRuns: 4, queuedRuns: 0 },
    { agentId: "agent-c", completedRuns: 4, queuedRuns: 0 },
  ]);

  expect(result).toEqual({
    jainIndex: 1,
    rating: "balanced",
    dominantAgentId: "agent-a",
    starvedAgentIds: [],
  });
});

it("scores moderate skew as skewed", () => {
  const result = evaluateFleetFairness([
    { agentId: "agent-a", completedRuns: 6, queuedRuns: 0 },
    { agentId: "agent-b", completedRuns: 3, queuedRuns: 0 },
    { agentId: "agent-c", completedRuns: 1, queuedRuns: 0 },
  ]);

  expect(result.jainIndex).toBe(0.725);
  expect(result.rating).toBe("skewed");
  expect(result.dominantAgentId).toBe("agent-a");
});

it("scores a single-agent monopoly as monopolized", () => {
  const result = evaluateFleetFairness([
    { agentId: "agent-a", completedRuns: 10, queuedRuns: 0 },
    { agentId: "agent-b", completedRuns: 0, queuedRuns: 0 },
    { agentId: "agent-c", completedRuns: 0, queuedRuns: 0 },
  ]);

  expect(result.jainIndex).toBe(0.333);
  expect(result.rating).toBe("monopolized");
  expect(result.dominantAgentId).toBe("agent-a");
});

it("detects queued agents with no completed runs as starved in ascending order", () => {
  const result = evaluateFleetFairness([
    { agentId: "agent-z", completedRuns: 0, queuedRuns: 2 },
    { agentId: "agent-b", completedRuns: 5, queuedRuns: 0 },
    { agentId: "agent-a", completedRuns: 0, queuedRuns: 1 },
    { agentId: "agent-c", completedRuns: 0, queuedRuns: 0 },
  ]);

  expect(result.starvedAgentIds).toEqual(["agent-a", "agent-z"]);
});

it("returns a Jain index of 1 for empty and all-zero inputs", () => {
  expect(computeJainFairnessIndex([])).toBe(1);
  expect(computeJainFairnessIndex([0, 0, 0])).toBe(1);
  expect(evaluateFleetFairness([])).toEqual({
    jainIndex: 1,
    rating: "balanced",
    dominantAgentId: null,
    starvedAgentIds: [],
  });
});

it("clamps negative inputs to zero before computing the Jain index", () => {
  expect(computeJainFairnessIndex([-2, 1, 1])).toBe(0.667);
});

it("breaks dominant-agent ties by ascending agent id", () => {
  const result = evaluateFleetFairness([
    { agentId: "agent-b", completedRuns: 5, queuedRuns: 0 },
    { agentId: "agent-a", completedRuns: 5, queuedRuns: 0 },
  ]);

  expect(result.dominantAgentId).toBe("agent-a");
});

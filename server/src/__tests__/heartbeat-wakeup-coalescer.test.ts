import { describe, expect, it } from "vitest";
import {
  coalesceWakeupBurst,
  type WakeupEventInput,
} from "../services/heartbeat-wakeup-coalescer.js";

function wakeup(
  id: string,
  requestedAtMs: number,
  overrides: Partial<WakeupEventInput> = {},
): WakeupEventInput {
  return {
    id,
    agentId: "agent-1",
    issueId: "issue-1",
    lane: "scheduled",
    requestedAtMs,
    triggerDetail: null,
    ...overrides,
  };
}

describe("coalesceWakeupBurst", () => {
  it("returns an empty result for empty input", () => {
    expect(coalesceWakeupBurst([])).toEqual([]);
  });

  it("collapses rapid duplicate wakeups within the default window", () => {
    const result = coalesceWakeupBurst([
      wakeup("w3", 9_999, { triggerDetail: null }),
      wakeup("w1", 1_000, { triggerDetail: "first" }),
      wakeup("w2", 2_000, { triggerDetail: "second" }),
    ]);

    expect(result).toEqual([
      {
        primaryId: "w1",
        agentId: "agent-1",
        issueId: "issue-1",
        lane: "scheduled",
        firstRequestedAtMs: 1_000,
        lastRequestedAtMs: 9_999,
        coalescedCount: 3,
        mergedIds: ["w1", "w2", "w3"],
        latestTriggerDetail: "second",
      },
    ]);
  });

  it("splits groups when the gap is greater than the configured window", () => {
    const result = coalesceWakeupBurst(
      [wakeup("w1", 1_000), wakeup("w2", 1_101)],
      { windowMs: 100 },
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      primaryId: "w1",
      firstRequestedAtMs: 1_000,
      lastRequestedAtMs: 1_000,
      coalescedCount: 1,
      mergedIds: ["w1"],
    });
    expect(result[1]).toMatchObject({
      primaryId: "w2",
      firstRequestedAtMs: 1_101,
      lastRequestedAtMs: 1_101,
      coalescedCount: 1,
      mergedIds: ["w2"],
    });
  });

  it("keeps separate agent and issue pairs distinct", () => {
    const result = coalesceWakeupBurst([
      wakeup("a1", 1_000, { agentId: "agent-a", issueId: "issue-1" }),
      wakeup("b1", 1_010, { agentId: "agent-b", issueId: "issue-1" }),
      wakeup("a2", 1_020, { agentId: "agent-a", issueId: "issue-1" }),
      wakeup("a-other-1", 1_030, { agentId: "agent-a", issueId: "issue-2" }),
      wakeup("b2", 1_040, { agentId: "agent-b", issueId: "issue-1" }),
      wakeup("a-other-2", 1_050, { agentId: "agent-a", issueId: "issue-2" }),
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((entry) => [
      entry.agentId,
      entry.issueId,
      entry.coalescedCount,
      entry.mergedIds,
    ])).toEqual([
      ["agent-a", "issue-1", 2, ["a1", "a2"]],
      ["agent-b", "issue-1", 2, ["b1", "b2"]],
      ["agent-a", "issue-2", 2, ["a-other-1", "a-other-2"]],
    ]);
  });

  it("promotes the highest-priority lane across merged events", () => {
    const result = coalesceWakeupBurst([
      wakeup("scheduled-first", 1_000, { lane: "scheduled" }),
      wakeup("interactive-second", 1_100, { lane: "interactive" }),
      wakeup("workflow-third", 1_200, { lane: "workflow" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      primaryId: "scheduled-first",
      lane: "interactive",
      coalescedCount: 3,
      mergedIds: ["scheduled-first", "interactive-second", "workflow-third"],
    });
  });
});

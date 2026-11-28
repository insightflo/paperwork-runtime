import { describe, expect, it } from "vitest";
import { detectWaitDeadlocks } from "../services/heartbeat-deadlock-detector.js";

describe("detectWaitDeadlocks", () => {
  it("returns no cycles for an acyclic DAG", () => {
    expect(
      detectWaitDeadlocks([
        { waiterId: "agent-a", targetId: "agent-b", waitedMs: 10 },
        { waiterId: "agent-b", targetId: "agent-c", waitedMs: 20 },
        { waiterId: "agent-a", targetId: "agent-c", waitedMs: 30 },
      ]),
    ).toEqual([]);
  });

  it("reports a self-loop once", () => {
    const selfLoop = { waiterId: "agent-a", targetId: "agent-a", runId: "run-self", waitedMs: 5 };

    const cycles = detectWaitDeadlocks([selfLoop]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodes).toEqual(["agent-a"]);
    expect(cycles[0]!.edges).toEqual([selfLoop]);
    expect(cycles[0]!.recommendedBreakTarget).toEqual(selfLoop);
  });

  it("reports a two-node cycle in canonical rotation order", () => {
    const ab = { waiterId: "agent-a", targetId: "agent-b", runId: "run-ab", waitedMs: 100 };
    const ba = { waiterId: "agent-b", targetId: "agent-a", runId: "run-ba", waitedMs: 200 };

    const cycles = detectWaitDeadlocks([ba, ab]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodes).toEqual(["agent-a", "agent-b"]);
    expect(cycles[0]!.edges).toEqual([ab, ba]);
    expect(cycles[0]!.recommendedBreakTarget).toEqual(ab);
  });

  it("reports a three-node cycle in canonical rotation order", () => {
    const ab = { waiterId: "agent-a", targetId: "agent-b", waitedMs: 10 };
    const bc = { waiterId: "agent-b", targetId: "agent-c", waitedMs: 20 };
    const ca = { waiterId: "agent-c", targetId: "agent-a", waitedMs: 30 };

    const cycles = detectWaitDeadlocks([ca, bc, ab]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodes).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(cycles[0]!.edges).toEqual([ab, bc, ca]);
    expect(cycles[0]!.recommendedBreakTarget).toEqual(ab);
  });

  it("reports disconnected cycles separately in deterministic order", () => {
    const ab = { waiterId: "agent-a", targetId: "agent-b", waitedMs: 10 };
    const ba = { waiterId: "agent-b", targetId: "agent-a", waitedMs: 20 };
    const xy = { waiterId: "agent-x", targetId: "agent-y", waitedMs: 30 };
    const yz = { waiterId: "agent-y", targetId: "agent-z", waitedMs: 40 };
    const zx = { waiterId: "agent-z", targetId: "agent-x", waitedMs: 50 };

    const cycles = detectWaitDeadlocks([zx, yz, ba, xy, ab]);

    expect(cycles.map((cycle) => cycle.nodes)).toEqual([
      ["agent-a", "agent-b"],
      ["agent-x", "agent-y", "agent-z"],
    ]);
    expect(cycles[0]!.recommendedBreakTarget).toEqual(ab);
    expect(cycles[1]!.recommendedBreakTarget).toEqual(xy);
  });

  it("selects the youngest waiter and breaks waited-time ties by waiter id", () => {
    const ab = { waiterId: "agent-a", targetId: "agent-b", waitedMs: 200 };
    const bc = { waiterId: "agent-b", targetId: "agent-c", waitedMs: 25 };
    const ca = { waiterId: "agent-c", targetId: "agent-a", waitedMs: 25 };

    const cycles = detectWaitDeadlocks([ab, bc, ca]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.recommendedBreakTarget).toEqual(bc);
  });

  it("returns the same cycle report when input edge order changes", () => {
    const edges = [
      { waiterId: "agent-a", targetId: "agent-b", waitedMs: 10 },
      { waiterId: "agent-b", targetId: "agent-c", waitedMs: 20 },
      { waiterId: "agent-c", targetId: "agent-a", waitedMs: 30 },
    ];

    expect(detectWaitDeadlocks([...edges].reverse())).toEqual(detectWaitDeadlocks(edges));
  });
});

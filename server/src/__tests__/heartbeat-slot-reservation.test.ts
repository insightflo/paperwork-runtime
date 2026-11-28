import { describe, expect, it } from "vitest";
import { AgentSlotReservationTracker } from "../services/heartbeat-slot-reservation.js";

describe("AgentSlotReservationTracker", () => {
  it.each([1, 2, 4])("reserves up to %i slots and rejects over-capacity", (maxSlots) => {
    const tracker = new AgentSlotReservationTracker();

    for (let index = 0; index < maxSlots; index += 1) {
      const result = tracker.tryReserve({
        agentId: "agent-1",
        runId: `run-${index}`,
        issueId: `issue-${index}`,
        maxSlots,
        nowMs: 1_000,
        ttlMs: 5_000,
      });
      expect(result).toMatchObject({ reserved: true });
    }

    expect(tracker.activeCount("agent-1", 1_000)).toBe(maxSlots);
    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-over-capacity",
      issueId: "issue-over-capacity",
      maxSlots,
      nowMs: 1_000,
    })).toEqual({ reserved: false, reason: "at_capacity" });
  });

  it("rejects a duplicate runId", () => {
    const tracker = new AgentSlotReservationTracker();
    const input = {
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      maxSlots: 2,
      nowMs: 1_000,
    };

    expect(tracker.tryReserve(input)).toMatchObject({ reserved: true });
    expect(tracker.tryReserve({ ...input, issueId: "issue-2" })).toEqual({
      reserved: false,
      reason: "run_already_reserved",
    });
  });

  it("rejects a duplicate issueId for the same agent while allowing different issues", () => {
    const tracker = new AgentSlotReservationTracker();

    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      maxSlots: 2,
      nowMs: 1_000,
    })).toMatchObject({ reserved: true });
    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-2",
      issueId: "issue-2",
      maxSlots: 2,
      nowMs: 1_000,
    })).toMatchObject({ reserved: true });
    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-3",
      issueId: "issue-1",
      maxSlots: 3,
      nowMs: 1_000,
    })).toEqual({ reserved: false, reason: "issue_already_reserved" });
    expect(tracker.tryReserve({
      agentId: "agent-2",
      runId: "run-4",
      issueId: "issue-1",
      maxSlots: 1,
      nowMs: 1_000,
    })).toMatchObject({ reserved: true });
  });

  it("releases a reserved slot", () => {
    const tracker = new AgentSlotReservationTracker();

    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      maxSlots: 1,
      nowMs: 1_000,
    })).toMatchObject({ reserved: true });
    expect(tracker.release("run-1")).toBe(true);
    expect(tracker.release("run-1")).toBe(false);
    expect(tracker.activeCount("agent-1", 1_000)).toBe(0);
    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-2",
      issueId: "issue-1",
      maxSlots: 1,
      nowMs: 1_000,
    })).toMatchObject({ reserved: true });
  });

  it("prunes expired reservations and reports the removed count", () => {
    const tracker = new AgentSlotReservationTracker();

    tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-expired",
      issueId: "issue-expired",
      maxSlots: 2,
      nowMs: 1_000,
      ttlMs: 100,
    });
    tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-active",
      issueId: "issue-active",
      maxSlots: 2,
      nowMs: 1_000,
      ttlMs: 200,
    });

    expect(tracker.pruneExpired(1_100)).toBe(1);
    expect(tracker.activeCount("agent-1", 1_100)).toBe(1);
    expect(tracker.pruneExpired(1_100)).toBe(0);
  });

  it("recovers capacity automatically when a reservation reaches its TTL", () => {
    const tracker = new AgentSlotReservationTracker({ defaultTtlMs: 100 });

    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      maxSlots: 1,
      nowMs: 1_000,
    })).toMatchObject({
      reserved: true,
      entry: {
        runId: "run-1",
        agentId: "agent-1",
        issueId: "issue-1",
        reservedAtMs: 1_000,
        expiresAtMs: 1_100,
      },
    });
    expect(tracker.activeCount("agent-1", 1_099)).toBe(1);
    expect(tracker.tryReserve({
      agentId: "agent-1",
      runId: "run-2",
      issueId: "issue-2",
      maxSlots: 1,
      nowMs: 1_100,
    })).toMatchObject({ reserved: true });
    expect(tracker.activeCount("agent-1", 1_100)).toBe(1);
  });
});

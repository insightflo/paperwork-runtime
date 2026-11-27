import { describe, expect, it } from "vitest";
import {
  branchTimelineAtCheckpoint,
  editQueueItem,
  evaluateContextUsage,
  evaluateMidTurnSteer,
  reorderQueueItem,
  splitQueueItemToSideTask,
  type QueuedTurnItem,
} from "../services/turn-queue-and-branch.js";

function item(overrides: Partial<QueuedTurnItem> & { id: string }): QueuedTurnItem {
  return {
    actorType: "user",
    body: `body-${overrides.id}`,
    createdAtMs: 1_000,
    sideTaskId: null,
    ...overrides,
  };
}

const baseQueue: QueuedTurnItem[] = [
  item({ id: "q1" }),
  item({ id: "q2", actorType: "agent" }),
  item({ id: "q3", body: "third" }),
];

describe("reorderQueueItem — live queue reorder", () => {
  it("moves an item to a later index without mutating the source", () => {
    const next = reorderQueueItem(baseQueue, "q1", 2);
    expect(next.map((i) => i.id)).toEqual(["q2", "q3", "q1"]);
    expect(baseQueue.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
  });

  it("moves an item to an earlier index", () => {
    expect(reorderQueueItem(baseQueue, "q3", 0).map((i) => i.id)).toEqual(["q3", "q1", "q2"]);
  });

  it("clamps out-of-range target indexes to valid bounds", () => {
    expect(reorderQueueItem(baseQueue, "q1", -5).map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
    expect(reorderQueueItem(baseQueue, "q1", 99).map((i) => i.id)).toEqual(["q2", "q3", "q1"]);
  });

  it("returns the queue unchanged when the id is missing", () => {
    const next = reorderQueueItem(baseQueue, "missing", 1);
    expect(next.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
    expect(baseQueue.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
  });
});

describe("editQueueItem — live queue body edit", () => {
  it("replaces the body of the target item immutably", () => {
    const next = editQueueItem(baseQueue, "q2", "rewritten");
    expect(next.find((i) => i.id === "q2")?.body).toBe("rewritten");
    expect(baseQueue.find((i) => i.id === "q2")?.body).toBe("body-q2");
    expect(next.filter((i) => i.id !== "q2")).toEqual(baseQueue.filter((i) => i.id !== "q2"));
  });

  it("rejects an empty trimmed body fail-closed", () => {
    expect(() => editQueueItem(baseQueue, "q1", "")).toThrow(/queue_edit_empty_body/);
    expect(() => editQueueItem(baseQueue, "q1", "   ")).toThrow(/queue_edit_empty_body/);
  });

  it("returns the queue unchanged when the id is missing", () => {
    const next = editQueueItem(baseQueue, "missing", "x");
    expect(next.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
    expect(baseQueue.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
  });
});

describe("splitQueueItemToSideTask — queue → side-task split", () => {
  it("removes the item from the main queue and tags it with the side task id", () => {
    const result = splitQueueItemToSideTask(baseQueue, "q2", "side-7");
    expect(result).not.toBeNull();
    expect(result?.mainQueue.map((i) => i.id)).toEqual(["q1", "q3"]);
    expect(result?.sideTaskItem.id).toBe("q2");
    expect(result?.sideTaskItem.sideTaskId).toBe("side-7");
  });

  it("returns null fail-closed when the id is missing", () => {
    expect(splitQueueItemToSideTask(baseQueue, "missing", "side-7")).toBeNull();
  });
});

describe("evaluateMidTurnSteer — human-safe #personTurn gate", () => {
  it("falls back to queue when the adapter does not support steer", () => {
    expect(
      evaluateMidTurnSteer({ activeTurnActorType: "user", steerActorType: "user", adapterSupportsSteer: false }),
    ).toEqual({ allowed: false, fallbackAction: "queue", reason: "adapter_steer_unsupported" });
  });

  it("protects a human-initiated turn from agent steering", () => {
    expect(
      evaluateMidTurnSteer({ activeTurnActorType: "user", steerActorType: "agent", adapterSupportsSteer: true }),
    ).toEqual({ allowed: false, fallbackAction: "queue", reason: "person_turn_protected" });
  });

  it("allows either actor to steer an agent-initiated turn", () => {
    expect(
      evaluateMidTurnSteer({ activeTurnActorType: "agent", steerActorType: "user", adapterSupportsSteer: true }),
    ).toEqual({ allowed: true, fallbackAction: "steer", reason: "ok" });
    expect(
      evaluateMidTurnSteer({ activeTurnActorType: "agent", steerActorType: "agent", adapterSupportsSteer: true }),
    ).toEqual({ allowed: true, fallbackAction: "steer", reason: "ok" });
  });

  it("allows a user to steer their own turn", () => {
    expect(
      evaluateMidTurnSteer({ activeTurnActorType: "user", steerActorType: "user", adapterSupportsSteer: true }),
    ).toEqual({ allowed: true, fallbackAction: "steer", reason: "ok" });
  });
});

type TimelineMessage = { id: string; role: string };

const timeline: TimelineMessage[] = [
  { id: "m1", role: "user" },
  { id: "m2", role: "assistant" },
  { id: "m3", role: "user" },
  { id: "m4", role: "assistant" },
];

describe("branchTimelineAtCheckpoint — session branching", () => {
  it("keeps messages up to and including the checkpoint and counts the truncated tail", () => {
    expect(branchTimelineAtCheckpoint(timeline, "m2")).toEqual({
      branchMessages: [
        { id: "m1", role: "user" },
        { id: "m2", role: "assistant" },
      ],
      truncatedCount: 2,
    });
  });

  it("branches at the last message with zero truncation", () => {
    expect(branchTimelineAtCheckpoint(timeline, "m4")).toEqual({ branchMessages: timeline, truncatedCount: 0 });
  });

  it("returns null when the checkpoint message is missing", () => {
    expect(branchTimelineAtCheckpoint(timeline, "missing")).toBeNull();
  });
});

describe("evaluateContextUsage — context usage gauge", () => {
  it("reports ok below the default 80% threshold", () => {
    expect(evaluateContextUsage({ usedTokens: 400, maxTokens: 1_000 })).toEqual({
      usedPct: 40,
      shouldCompact: false,
      severity: "ok",
    });
  });

  it("marks warn + shouldCompact from the 80% threshold upward", () => {
    expect(evaluateContextUsage({ usedTokens: 800, maxTokens: 1_000 })).toEqual({
      usedPct: 80,
      shouldCompact: true,
      severity: "warn",
    });
  });

  it("marks critical at >= 92%", () => {
    expect(evaluateContextUsage({ usedTokens: 920, maxTokens: 1_000 })).toEqual({
      usedPct: 92,
      shouldCompact: true,
      severity: "critical",
    });
  });

  it("honors a custom compact threshold while keeping the 92% critical floor", () => {
    expect(evaluateContextUsage({ usedTokens: 880, maxTokens: 1_000, compactThresholdPct: 90 })).toEqual({
      usedPct: 88,
      shouldCompact: false,
      severity: "ok",
    });
    expect(evaluateContextUsage({ usedTokens: 900, maxTokens: 1_000, compactThresholdPct: 90 }).severity).toBe("warn");
  });

  it("fails closed on non-positive max tokens", () => {
    expect(evaluateContextUsage({ usedTokens: 10, maxTokens: 0 })).toEqual({
      usedPct: 100,
      shouldCompact: true,
      severity: "critical",
    });
  });
});

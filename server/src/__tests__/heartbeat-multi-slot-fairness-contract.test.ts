import { describe, expect, it } from "vitest";
import {
  classifyQueueLane,
  selectNextQueuedRuns,
  type QueuedRunCandidate,
} from "../services/heartbeat-queue-fairness.js";
import {
  FRESH_PROMOTION_HANDOFF_GRACE_MS,
  latestQueueActivityMs,
} from "../services/heartbeat-queued-stale-recovery.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const SAME_TIME = "2026-01-01T11:59:00.000Z";
const SLOT_COUNTS = [1, 2, 4, 8] as const;

function run(id: string, input?: Partial<QueuedRunCandidate>): QueuedRunCandidate {
  return {
    id,
    createdAt: SAME_TIME,
    ...input,
  };
}

function ids(candidates: readonly QueuedRunCandidate[]) {
  return candidates.map((candidate) => candidate.id);
}

function issueIds(candidates: readonly QueuedRunCandidate[]) {
  return candidates
    .map((candidate) => candidate.issueId)
    .filter((issueId): issueId is string => typeof issueId === "string");
}

function duplicatedIssueRows(distinctIssues: number) {
  const rows: QueuedRunCandidate[] = [];
  for (let index = 0; index < distinctIssues; index += 1) {
    rows.push(
      run(`primary-${index}`, { invocationSource: "on_demand", issueId: `issue-${index}` }),
      run(`duplicate-${index}`, { invocationSource: "on_demand", issueId: `issue-${index}` }),
    );
  }
  return rows;
}

describe("multi-slot heartbeat queue fairness contracts", () => {
  it("classifies the lanes used by the slot-capacity matrix", () => {
    expect(classifyQueueLane({ invocationSource: "on_demand" })).toBe("interactive");
    expect(classifyQueueLane({ triggerDetail: "handoff_recovery" })).toBe("recovery");
    expect(classifyQueueLane({ invocationSource: "assignment" })).toBe("workflow");
    expect(classifyQueueLane({ invocationSource: "timer" })).toBe("scheduled");
  });

  it.each(SLOT_COUNTS)("serializes duplicate issues while distinct issues fill %i slots", (availableSlots) => {
    const selected = selectNextQueuedRuns(duplicatedIssueRows(12), {
      availableSlots,
      now: NOW,
    });

    expect(selected).toHaveLength(availableSlots);
    const selectedIssueIds = issueIds(selected);
    expect(selectedIssueIds).toHaveLength(availableSlots);
    expect(new Set(selectedIssueIds).size).toBe(availableSlots);
  });

  it.each(SLOT_COUNTS)("interactive and recovery lanes preempt fresh scheduled runs with %i slots", (availableSlots) => {
    const candidates = [
      run("fresh-scheduled", { invocationSource: "timer", issueId: "scheduled-issue" }),
      run("interactive", { invocationSource: "on_demand", issueId: "interactive-issue" }),
      ...Array.from({ length: 7 }, (_, index) => run(`recovery-${index}`, {
        triggerDetail: "handoff_recovery",
        issueId: `recovery-issue-${index}`,
      })),
    ];

    const selected = selectNextQueuedRuns(candidates, { availableSlots, now: NOW });

    expect(selected).toHaveLength(availableSlots);
    expect(ids(selected)).not.toContain("fresh-scheduled");
    expect(ids(selected)[0]).toBe("interactive");
    expect(selected.every((candidate) => ["interactive", "recovery"].includes(classifyQueueLane(candidate)))).toBe(true);
  });

  it.each(SLOT_COUNTS)("promotes aged scheduled work ahead of brand-new interactive runs with %i slots", (availableSlots) => {
    const agedScheduled = run("aged-scheduled", {
      createdAt: "2026-01-01T11:50:00.000Z",
      invocationSource: "timer",
      issueId: "aged-scheduled-issue",
    });
    const candidates = [
      ...Array.from({ length: 8 }, (_, index) => run(`new-interactive-${index}`, {
        createdAt: NOW.toISOString(),
        invocationSource: "on_demand",
        issueId: `new-interactive-issue-${index}`,
      })),
      agedScheduled,
    ];

    const selected = selectNextQueuedRuns(candidates, { availableSlots, now: NOW });

    expect(classifyQueueLane(agedScheduled)).toBe("scheduled");
    expect(selected).toHaveLength(availableSlots);
    expect(ids(selected)[0]).toBe("aged-scheduled");
  });

  it.each(SLOT_COUNTS)("activeIssueIds blocks in-flight issues without starving queued work with %i slots", (availableSlots) => {
    const activeIssueIds = new Set(["issue-0", "issue-1"]);
    const selected = selectNextQueuedRuns(duplicatedIssueRows(12), {
      availableSlots,
      now: NOW,
      activeIssueIds,
    });

    expect(selected).toHaveLength(availableSlots);
    const selectedIssueIds = issueIds(selected);
    expect(selectedIssueIds.some((issueId) => activeIssueIds.has(issueId))).toBe(false);
    expect(new Set(selectedIssueIds).size).toBe(selectedIssueIds.length);
  });

  it("keeps lease activity and handoff grace slot-agnostic at the 30 second resilience floor", () => {
    const createdAt = new Date("2026-01-01T11:58:00.000Z");
    expect(FRESH_PROMOTION_HANDOFF_GRACE_MS).toBeGreaterThanOrEqual(30_000);
    expect(latestQueueActivityMs(null, null)).toBeNull();

    for (const availableSlots of SLOT_COUNTS) {
      const updatedAt = new Date(NOW.getTime() - (30_000 - availableSlots * 1_000));
      const activityMs = latestQueueActivityMs(createdAt, updatedAt);
      expect(activityMs).toBe(updatedAt.getTime());
      expect(latestQueueActivityMs(updatedAt, createdAt)).toBe(updatedAt.getTime());
      expect(NOW.getTime() - (activityMs ?? 0)).toBeLessThanOrEqual(FRESH_PROMOTION_HANDOFF_GRACE_MS);
    }
  });
});

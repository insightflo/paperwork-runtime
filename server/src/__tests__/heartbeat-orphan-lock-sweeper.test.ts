import { describe, expect, it, vi } from "vitest";
import {
  shouldRetryProcessLostRun,
  sweepOrphanedLocks,
  type ReleasedOrphanIssue,
} from "../services/heartbeat-orphan-lock-sweeper.js";

function createFakeSweepDb(config: {
  phantomCandidates?: Array<{ id: string }>;
  demotedIds?: string[];
  orphanCandidates?: Array<{ issueId: string; checkoutRunId: string | null }>;
  updatedIssues?: Array<{ id: string; companyId: string; assigneeAgentId: string | null } | undefined>;
}) {
  let selectCall = 0;
  let updateCall = 0;
  const phantomCandidates = config.phantomCandidates ?? [];
  const demotedIds = config.demotedIds ?? phantomCandidates.map((c) => c.id);
  const orphanCandidates = config.orphanCandidates ?? [];
  const updatedIssues = config.updatedIssues ?? [];

  const db = {
    select: vi.fn(() => {
      selectCall += 1;
      const callNum = selectCall;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: async () => (callNum === 1 ? phantomCandidates : orphanCandidates),
      };
      return chain;
    }),
    update: vi.fn(() => {
      updateCall += 1;
      const idx = updateCall;
      const phantomCount = phantomCandidates.length;
      const chain = {
        set: () => chain,
        where: () => chain,
        returning: async () => {
          if (idx <= phantomCount) {
            const id = demotedIds[idx - 1];
            return id ? [{ id }] : [];
          }
          const issueIdx = idx - phantomCount - 1;
          const row = updatedIssues[issueIdx];
          return row ? [row] : [];
        },
      };
      return chain;
    }),
  };
  return db;
}

describe("heartbeat-orphan-lock-sweeper", () => {
  it("allows 1 automatic retry for null-PID process_lost runs on tracked local adapters", () => {
    expect(shouldRetryProcessLostRun(true, 0)).toBe(true);
    expect(shouldRetryProcessLostRun(true, null)).toBe(true);
    expect(shouldRetryProcessLostRun(true, undefined)).toBe(true);
    expect(shouldRetryProcessLostRun(true, 1)).toBe(false);
    expect(shouldRetryProcessLostRun(true, 2)).toBe(false);
    expect(shouldRetryProcessLostRun(false, 0)).toBe(false);
  });

  it("demotes phantom-running agents and releases orphan issue checkouts with preserved non-null checkoutRunId", async () => {
    const db = createFakeSweepDb({
      phantomCandidates: [{ id: "agent-stuck-1" }],
      demotedIds: ["agent-stuck-1"],
      orphanCandidates: [
        { issueId: "issue-orphan-1", checkoutRunId: "run-dead-1" },
        { issueId: "issue-concurrent-2", checkoutRunId: "run-dead-2" },
      ],
      updatedIssues: [
        { id: "issue-orphan-1", companyId: "comp-1", assigneeAgentId: "agent-stuck-1" },
        // Second issue's atomic guard (status/executionRunId changed concurrently) returns empty
        undefined,
      ],
    });

    const releasedCallbacks: ReleasedOrphanIssue[] = [];
    const result = await sweepOrphanedLocks(db as never, {
      now: new Date("2026-11-23T09:00:00Z"),
      graceMs: 120_000,
      onIssueReleased: async (released) => {
        releasedCallbacks.push(released);
      },
    });

    expect(result.demotedAgentIds).toEqual(["agent-stuck-1"]);
    expect(result.releasedIssues).toEqual([
      {
        issueId: "issue-orphan-1",
        companyId: "comp-1",
        assigneeAgentId: "agent-stuck-1",
        releasedCheckoutRunId: "run-dead-1",
      },
    ]);
    // Explicitly assert onIssueReleased received the non-null original checkoutRunId (not cleared NULL)
    expect(releasedCallbacks).toHaveLength(1);
    expect(releasedCallbacks[0]).toEqual({
      issueId: "issue-orphan-1",
      companyId: "comp-1",
      assigneeAgentId: "agent-stuck-1",
      releasedCheckoutRunId: "run-dead-1",
    });
  });

  it("isolates onIssueReleased callback errors per issue and continues sweeping", async () => {
    const db = createFakeSweepDb({
      phantomCandidates: [],
      orphanCandidates: [
        { issueId: "issue-1", checkoutRunId: "run-1" },
        { issueId: "issue-2", checkoutRunId: "run-2" },
      ],
      updatedIssues: [
        { id: "issue-1", companyId: "comp-1", assigneeAgentId: "agent-1" },
        { id: "issue-2", companyId: "comp-1", assigneeAgentId: "agent-2" },
      ],
    });

    const seen: string[] = [];
    const result = await sweepOrphanedLocks(db as never, {
      onIssueReleased: async (r) => {
        seen.push(r.releasedCheckoutRunId);
        if (r.issueId === "issue-1") throw new Error("wakeup transient error");
      },
    });

    expect(result.releasedIssues.map((r) => r.releasedCheckoutRunId)).toEqual(["run-1", "run-2"]);
    expect(seen).toEqual(["run-1", "run-2"]);
  });
});

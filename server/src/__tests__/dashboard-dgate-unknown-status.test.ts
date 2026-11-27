import { describe, expect, it } from "vitest";
import {
  buildControlPlaneSnapshotFromRows,
  type ControlPlaneOutcomeRow,
} from "../services/dashboard-dgate.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((acc, value) => acc + value, 0);
}

function buildOutcomes(outcomeRows: ControlPlaneOutcomeRow[]) {
  return buildControlPlaneSnapshotFromRows({
    now: NOW,
    agentCounts: [],
    workerRuns: [],
    runModels: [],
    activeRunCounts: { running: 0, queued: 0 },
    outcomeRows,
    providerRows: [],
    pendingApprovalsCount: 0,
    pendingDecisionsCount: 0,
    openBudgetIncidentsCount: 0,
    pendingWorktreeProposalsCount: 0,
    approvalRows: [],
    decisionRows: [],
    worktreeProposalRows: [],
    budgetIncidentRows: [],
    activityRows: [],
  }).outcomes;
}

describe("dgate outcomes accounting with unknown run statuses", () => {
  it("keeps sum(byAdapter) === total for the six contract statuses", () => {
    const outcomes = buildOutcomes([
      { status: "succeeded", adapterType: "claude_local", count: 6 },
      { status: "succeeded", adapterType: "codex_local", count: 2 },
      { status: "failed", adapterType: "claude_local", count: 1 },
      { status: "timed_out", adapterType: "codex_local", count: 1 },
      { status: "cancelled", adapterType: "codex_local", count: 1 },
      { status: "running", adapterType: "claude_local", count: 1 },
      { status: "queued", adapterType: "codex_local", count: 2 },
    ]);

    expect(outcomes).toMatchObject({
      total: 14,
      succeeded: 8,
      failed: 1,
      cancelled: 1,
      timedOut: 1,
      running: 1,
      queued: 2,
      byAdapter: { claude_local: 8, codex_local: 6 },
    });
    expect(sumValues(outcomes.byAdapter)).toBe(outcomes.total);
  });

  it("excludes unknown statuses from byAdapter so the invariant still holds", () => {
    const outcomes = buildOutcomes([
      { status: "succeeded", adapterType: "claude_local", count: 3 },
      { status: "failed", adapterType: "claude_local", count: 1 },
      // Out-of-contract / legacy statuses must not leak into adapter totals.
      { status: "paused", adapterType: "claude_local", count: 5 },
      { status: "error", adapterType: "codex_local", count: 2 },
      { status: "Succeeded", adapterType: "codex_local", count: 1 },
      { status: "", adapterType: null, count: 4 },
    ]);

    expect(outcomes.total).toBe(4);
    expect(outcomes.succeeded).toBe(3);
    expect(outcomes.failed).toBe(1);
    expect(outcomes.byAdapter).toEqual({ claude_local: 4 });
    expect(sumValues(outcomes.byAdapter)).toBe(outcomes.total);
  });

  it("ignores non-positive counts and falls back to the process adapter key", () => {
    const outcomes = buildOutcomes([
      { status: "succeeded", adapterType: "  ", count: 2 },
      { status: "queued", adapterType: null, count: 1 },
      { status: "running", adapterType: "claude_local", count: 0 },
      { status: "failed", adapterType: "claude_local", count: -3 },
      { status: "unknown_status", adapterType: "claude_local", count: 7 },
    ]);

    expect(outcomes.total).toBe(3);
    expect(outcomes.byAdapter).toEqual({ process: 3 });
    expect(sumValues(outcomes.byAdapter)).toBe(outcomes.total);
  });

  it("holds the invariant across every status mixed with unknown ones", () => {
    const statuses = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"];
    const outcomeRows = statuses.flatMap((status, idx) => [
      { status, adapterType: idx % 2 === 0 ? "claude_local" : "codex_local", count: idx + 1 },
      { status: "legacy_unknown", adapterType: "claude_local", count: 10 },
    ]);
    const outcomes = buildOutcomes(outcomeRows);

    expect(outcomes.total).toBe(21);
    expect(outcomes.byAdapter).toEqual({ claude_local: 9, codex_local: 12 });
    expect(sumValues(outcomes.byAdapter)).toBe(outcomes.total);
  });
});

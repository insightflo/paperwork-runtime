import { describe, expect, it, vi } from "vitest";
import {
  buildControlPlaneSnapshotFromRows,
  dashboardDgateService,
  type ControlPlaneActivityRow,
  type ControlPlaneWorkerRunRow,
} from "../services/dashboard-dgate.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const MINUTE = 60_000;
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MINUTE).toISOString();

function emptyInput() {
    return {
      now: NOW, agentCounts: [], workerRuns: [], runModels: [], activeRunCounts: { running: 0, queued: 0 }, outcomeRows: [], providerRows: [],
      pendingApprovalsCount: 0, pendingDecisionsCount: 0, openBudgetIncidentsCount: 0, pendingWorktreeProposalsCount: 0,
      approvalRows: [], decisionRows: [], worktreeProposalRows: [], budgetIncidentRows: [], activityRows: [],
    };
}

function expectNoNaN(result: unknown): void {
  expect(JSON.stringify(result)).not.toContain("NaN");
}

// Records per-select chain usage so query-level ordering/caps can be asserted.
function createFakeDb(responses: unknown[][] = []) {
  const selects: Array<{ limit: unknown[]; orderByCalls: number }> = [];
  const select = vi.fn(() => {
    const record = { limit: [] as unknown[], orderByCalls: 0 };
    selects.push(record);
    const rows = responses[selects.length - 1] ?? [];
    const chain: Record<string, any> = {
      from: vi.fn(() => chain), leftJoin: vi.fn(() => chain), where: vi.fn(() => chain), groupBy: vi.fn(() => chain),
      orderBy: vi.fn(() => { record.orderByCalls += 1; return chain; }),
      limit: vi.fn((n: unknown) => { record.limit.push(n); return chain; }),
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  });
  return { db: { select } as any, selects, select };
}

describe("dashboard-dgate empty company state", () => {
  it("builder returns paperwork_internal with zero counts and empty arrays", () => {
    const result = buildControlPlaneSnapshotFromRows(emptyInput());
    expect(result).toEqual({
      connected: true, source: "paperwork_internal", timestamp: NOW.toISOString(), workers: [], recentEvents: [],
      summary: {
        activeRuns: 0, queuedRuns: 0, activeAgents: 0, totalAgents: 0, pendingApprovals: 0, pendingDecisions: 0,
        openBudgetIncidents: 0, pendingWorktreeProposals: 0, passRatePct: 0,
      },
      gates: { approvals: [], operatorDecisions: [], worktreeProposals: [], budgetIncidents: [] },
      outcomes: {
        windowHours: 24, total: 0, succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, running: 0, queued: 0, byAdapter: {}, byProvider: {},
      },
    });
    expectNoNaN(result);
  });

  it("zero/null counts and non-terminal outcomes never produce NaN or div-by-zero", () => {
    const result = buildControlPlaneSnapshotFromRows({
      ...emptyInput(),
      agentCounts: [{ status: "running", count: 0 }, { status: "idle", count: null as unknown as number }],
      outcomeRows: [
        { status: "succeeded", adapterType: null, count: 0 }, { status: "cancelled", adapterType: "  ", count: 2 },
        { status: "running", adapterType: "codex_local", count: 3 },
      ],
      providerRows: [{ provider: null, count: 0 }],
    });
    expect(result.summary).toMatchObject({ totalAgents: 0, activeAgents: 0, passRatePct: 0 });
    expect(result.outcomes).toMatchObject({ total: 5, byAdapter: { process: 2, codex_local: 3 }, byProvider: {} });
    expectNoNaN(result);
  });

  it("service skips the run-model lookup when there are no worker runs", async () => {
    const { db, select } = createFakeDb();
    const result = await dashboardDgateService(db, { now: () => NOW }).getSnapshot("company-empty");
    expect(select).toHaveBeenCalledTimes(14);
    expect(result.source).toBe("paperwork_internal");
    expect(result.summary.passRatePct).toBe(0);
    expect(result.workers).toEqual([]);
    expect(result.gates.approvals).toEqual([]);
    expect(result.recentEvents).toEqual([]);
    expectNoNaN(result);
  });

  it("service returns zeroed snapshot when aggregate rows are missing or null", async () => {
    const responses: unknown[][] = [];
    responses[6] = [{ count: null }]; // pendingDecisionsAgg
    responses[7] = [{ count: 3 }]; // openBudgetIncidentsAgg
    const { db } = createFakeDb(responses);
    const result = await dashboardDgateService(db, { now: () => NOW }).getSnapshot("company-empty");
    expect(result.summary).toMatchObject({
      pendingApprovals: 0, pendingDecisions: 0, openBudgetIncidents: 3, pendingWorktreeProposals: 0,
      activeRuns: 0, queuedRuns: 0, totalAgents: 0,
    });
    expectNoNaN(result);
  });
});

describe("dashboard-dgate mixed outcomes and gate metrics", () => {
  const workerRuns: ControlPlaneWorkerRunRow[] = [
    {
      runId: "run-neg", status: "running", agentId: "agent-1", agentName: "  ", agentRole: "", adapterType: null,
      adapterConfig: null, usageJson: { model: "   " }, invocationSource: "timer", triggerDetail: "  ",
      issueIdentifier: null, issueTitle: null, startedAt: new Date(NOW.getTime() + 5 * MINUTE),
      finishedAt: new Date(NOW.getTime() - 5 * MINUTE), createdAt: NOW,
    },
    {
      runId: "run-null", status: "succeeded", agentId: "agent-2", agentName: "Builder", agentRole: "engineer",
      adapterType: "codex_local", adapterConfig: { model: "gpt-5" }, usageJson: null, invocationSource: "assignment",
      triggerDetail: null, issueIdentifier: "PAP-1", issueTitle: "Ship it", startedAt: null, finishedAt: null, createdAt: NOW,
    },
  ];
  const approvalRows = [
    { id: "a1", type: "deploy_prod", status: "pending", payload: { title: "Rollout" }, createdAt: NOW },
    { id: "a2", type: "hire_agent", status: "pending", payload: { name: "  " }, createdAt: NOW },
  ];
  const decisionRows = [
    { id: "d1", title: "  ", status: "pending", priority: "urgent", createdAt: NOW },
    { id: "d2", title: "Decide", status: "pending", priority: "critical", createdAt: NOW },
  ];
  const budgetIncidentRows = [
    { id: "b1", scopeType: "company", metric: "cost", thresholdType: "hard", amountLimit: 10, amountObserved: 12, status: "open", createdAt: NOW },
    { id: "b2", scopeType: "agent", metric: "tokens", thresholdType: "soft", amountLimit: 10, amountObserved: 11, status: "open", createdAt: NOW },
  ];

  it("computes outcome distribution, pass rate, adapters, providers, and gate severities", () => {
    const result = buildControlPlaneSnapshotFromRows({
      ...emptyInput(),
      agentCounts: [{ status: "active", count: 1 }, { status: "paused", count: 2 }],
      workerRuns,
      runModels: [{ heartbeatRunId: "run-null", model: null }],
      activeRunCounts: { running: 1, queued: 4 },
      outcomeRows: [
        { status: "succeeded", adapterType: "claude_local", count: 5 }, { status: "failed", adapterType: "claude_local", count: 2 },
        { status: "cancelled", adapterType: null, count: 1 }, { status: "timed_out", adapterType: "  ", count: 1 },
        { status: "running", adapterType: "codex_local", count: 3 }, { status: "queued", adapterType: "codex_local", count: 2 },
        { status: "succeeded", adapterType: "claude_local", count: -4 },
      ],
      providerRows: [{ provider: "anthropic", count: 4 }, { provider: "", count: 1 }, { provider: "openai", count: 0 }],
      pendingApprovalsCount: 2, pendingDecisionsCount: 2, openBudgetIncidentsCount: 2, pendingWorktreeProposalsCount: 1,
      approvalRows, decisionRows, budgetIncidentRows,
    });

    // passRatePct = 5 / (5 + 2 + 1) = 62.5 ; cancelled/running/queued/negative excluded
    expect(result.summary).toMatchObject({ activeAgents: 1, totalAgents: 3, passRatePct: 62.5, activeRuns: 1, queuedRuns: 4 });
    expect(result.outcomes).toMatchObject({
      total: 14, succeeded: 5, failed: 2, cancelled: 1, timedOut: 1, running: 3, queued: 2,
      byAdapter: { claude_local: 7, process: 2, codex_local: 5 }, byProvider: { anthropic: 4, unknown: 1 },
    });
    expect(result.workers).toMatchObject([
      { runId: "run-neg", agentName: "agent-1", role: "general", adapterType: "process", model: null, durationMs: 0, contextLabel: "timer" },
      { runId: "run-null", role: "engineer", adapterType: "codex_local", model: "gpt-5", durationMs: 0, contextLabel: "PAP-1 · Ship it" },
    ]);
    expect(result.gates.approvals.map((g) => [g.id, g.severity, g.title])).toEqual([["a1", "critical", "deploy_prod: Rollout"], ["a2", "high", "Approval: hire_agent"]]);
    expect(result.gates.operatorDecisions.map((g) => [g.id, g.severity, g.title])).toEqual([["d1", "medium", "Operator decision"], ["d2", "critical", "Decide"]]);
    expect(result.gates.budgetIncidents.map((g) => [g.id, g.severity, g.linkPath])).toEqual([["b1", "critical", "/costs"], ["b2", "high", "/costs"]]);
    expect(result.gates.budgetIncidents[0].title).toBe("company hard budget threshold (cost: 12/10)");
    expectNoNaN(result);
  });

  it("service derives active runs from the active-run aggregate, not outcome rows", async () => {
    const responses: unknown[][] = [];
    responses[1] = [{ status: "running", count: 2 }, { status: "queued", count: 0 }];
    responses[3] = [{ status: "running", adapterType: "claude_local", count: 9 }];
    const { db } = createFakeDb(responses);
    const result = await dashboardDgateService(db, { now: () => NOW }).getSnapshot("company-1");
    expect(result.summary.activeRuns).toBe(2);
    expect(result.summary.queuedRuns).toBe(0);
    expect(result.outcomes.running).toBe(9);
  });
});

describe("dashboard-dgate recent events ordering and caps", () => {
  function makeEvents(count: number): ControlPlaneActivityRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `evt-${i}`, action: "run.updated", entityType: "heartbeat_run", entityId: `run-${i}`, actorType: "system",
      details: i % 2 === 0 ? { status: `s${i}` } : { reason: "", title: "   " },
      createdAt: new Date(NOW.getTime() - i * MINUTE),
    }));
  }

  it("builder preserves newest-first input order and builds summaries from safe detail keys", () => {
    const long = {
      id: "evt-long", action: "issue.created", entityType: "issue", entityId: "issue-1", actorType: "agent",
      details: { title: `T${"x".repeat(100)}` }, createdAt: NOW,
    };
    const result = buildControlPlaneSnapshotFromRows({ ...emptyInput(), activityRows: [...makeEvents(3), long] });
    expect(result.recentEvents.map((e) => e.id)).toEqual(["evt-0", "evt-1", "evt-2", "evt-long"]);
    expect(result.recentEvents.map((e) => e.createdAt)).toEqual([iso(0), iso(1), iso(2), iso(0)]);
    expect(result.recentEvents.map((e) => e.summary)).toEqual([
      "run.updated (heartbeat_run): s0", "run.updated (heartbeat_run)", "run.updated (heartbeat_run): s2",
      `issue.created (issue): T${"x".repeat(78)}…`,
    ]);
  });

  it("service caps recent events and gates at 20 and workers at 25 via ordered queries", async () => {
    const responses: unknown[][] = [];
    responses[2] = Array.from({ length: 25 }, (_, i) => ({ runId: `r${i}` }));
    responses[9] = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, type: "hire_agent", status: "pending", createdAt: NOW }));
    responses[13] = makeEvents(20);
    const { db, selects } = createFakeDb(responses);
    const result = await dashboardDgateService(db, { now: () => NOW }).getSnapshot("company-1");
    expect(result.recentEvents).toHaveLength(20);
    expect(result.recentEvents[0].id).toBe("evt-0");
    expect(result.recentEvents[19].id).toBe("evt-19");
    expect(result.gates.approvals).toHaveLength(20);
    expect(result.workers).toHaveLength(25);
    // activity log query (index 13): newest first, then capped
    expect(selects[13]).toMatchObject({ orderByCalls: 1, limit: [20] });
    for (const gateIndex of [9, 10, 11, 12]) expect(selects[gateIndex]).toMatchObject({ orderByCalls: 1, limit: [20] });
    expect(selects[2].limit).toEqual([25]);
    // run-model lookup (index 14) runs only because worker runs exist
    expect(selects).toHaveLength(15);
  });
});

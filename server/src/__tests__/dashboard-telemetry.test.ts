import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import {
  buildControlPlaneSnapshotFromRows,
  type ControlPlaneActivityRow,
  type ControlPlaneAgentCountRow,
  type ControlPlaneApprovalRow,
  type ControlPlaneBudgetIncidentRow,
  type ControlPlaneDecisionRow,
  type ControlPlaneOutcomeRow,
  type ControlPlaneProviderCountRow,
  type ControlPlaneRunModelRow,
  type ControlPlaneWorkerRunRow,
  type ControlPlaneWorktreeProposalRow,
} from "../services/dashboard-dgate.js";
import {
  buildDashboardTelemetryFromRows,
  parseTelemetryWindow,
  type TelemetryCostEventRow,
  type TelemetryRunCostAggRow,
  type TelemetryRunRow,
} from "../services/dashboard-telemetry.js";

function createFakeDb(config?: {
  costRows?: TelemetryCostEventRow[];
  runRows?: TelemetryRunRow[];
  runCostRows?: TelemetryRunCostAggRow[];
}) {
  const costRows = config?.costRows ?? [];
  const runRows = config?.runRows ?? [];
  const runCostRows = config?.runCostRows ?? [];

  const select = vi.fn(() => {
    let hasLeftJoin = false;
    const chain: Record<string, any> = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => {
        hasLeftJoin = true;
        return chain;
      }),
      where: vi.fn(() => {
        // Query 1 (cost_events with leftJoin) resolves at where(), unless orderBy/groupBy is chained.
        if (hasLeftJoin) {
          const thenable = Object.assign(Promise.resolve(costRows), {
            orderBy: vi.fn(() => chain),
          });
          return thenable;
        }
        return chain;
      }),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(runRows)),
      groupBy: vi.fn(() => Promise.resolve(runCostRows)),
    };
    return chain;
  });

  return { select } as any;
}

function createApp(
  db: any,
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", dashboardRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("dashboard telemetry aggregation", () => {
  it("parses valid telemetry windows and falls back to 6h for invalid values", () => {
    expect(parseTelemetryWindow("10m")).toBe("10m");
    expect(parseTelemetryWindow("1h")).toBe("1h");
    expect(parseTelemetryWindow("6h")).toBe("6h");
    expect(parseTelemetryWindow("24h")).toBe("24h");
    expect(parseTelemetryWindow(undefined)).toBe("6h");
    expect(parseTelemetryWindow("7d")).toBe("6h");
    expect(parseTelemetryWindow(123)).toBe("6h");
  });

  it("returns clean zeroed structures when tables are empty across all windows", () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const expectedBuckets: Record<"10m" | "1h" | "6h" | "24h", number> = {
      "10m": 10,
      "1h": 12,
      "6h": 12,
      "24h": 24,
    };

    for (const [window, bucketCount] of Object.entries(expectedBuckets) as Array<
      ["10m" | "1h" | "6h" | "24h", number]
    >) {
      const result = buildDashboardTelemetryFromRows({
        window,
        now,
        costRows: [],
        runRows: [],
        runCostRows: [],
      });
      expect(result.window).toBe(window);
      expect(result.generatedAt).toBe(now.toISOString());
      expect(result.buckets).toHaveLength(bucketCount);
      expect(result.models).toEqual([]);
      expect(result.projectShares).toEqual([]);
      expect(result.agentShares).toEqual([]);
      expect(result.sessions).toEqual([]);
      expect(result.velocity).toEqual({
        tokensPerHour: 0,
        peakTokensPerHour: 0,
        totalTokens: 0,
        avgTokensPerBucket: 0,
        totalCostCents: 0,
        activeSessions: 0,
        idleSessions: 0,
      });
      expect(result.host.activeRuns).toBe(0);
    }
  });

  it("aggregates buckets, top 5 models + other, shares, velocity, and live sessions", () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const costRows: TelemetryCostEventRow[] = [
      {
        id: "c1",
        agentId: "a1",
        agentName: "Planner",
        projectId: "p1",
        projectName: "Core",
        heartbeatRunId: "r1",
        provider: "anthropic",
        model: "claude-opus-4",
        inputTokens: 3000,
        cachedInputTokens: 1000,
        outputTokens: 2000,
        costCents: 120,
        occurredAt: new Date("2026-11-26T11:55:00.000Z"),
      },
      {
        id: "c2",
        agentId: "a2",
        agentName: "Builder",
        projectId: "p2",
        projectName: "UI",
        heartbeatRunId: "r2",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 2000,
        cachedInputTokens: 0,
        outputTokens: 1000,
        costCents: 80,
        occurredAt: new Date("2026-11-26T11:52:00.000Z"),
      },
      {
        id: "c3",
        agentId: "a2",
        agentName: "Builder",
        projectId: "p2",
        projectName: "UI",
        heartbeatRunId: "r2",
        provider: "google",
        model: "gemini-2.5-pro",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
        costCents: 30,
        occurredAt: new Date("2026-11-26T11:40:00.000Z"),
      },
      {
        id: "c4",
        agentId: "a1",
        agentName: "Planner",
        projectId: "p1",
        projectName: "Core",
        heartbeatRunId: null,
        provider: "openai",
        model: "o3",
        inputTokens: 800,
        cachedInputTokens: 0,
        outputTokens: 200,
        costCents: 20,
        occurredAt: new Date("2026-11-26T11:20:00.000Z"),
      },
      {
        id: "c5",
        agentId: "a1",
        agentName: "Planner",
        projectId: "p1",
        projectName: "Core",
        heartbeatRunId: null,
        provider: "anthropic",
        model: "claude-sonnet-4",
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 10,
        occurredAt: new Date("2026-11-26T11:10:00.000Z"),
      },
      {
        id: "c6",
        agentId: "a1",
        agentName: "Planner",
        projectId: "p1",
        projectName: "Core",
        heartbeatRunId: null,
        provider: "xai",
        model: "grok-3",
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 5,
        occurredAt: new Date("2026-11-26T11:05:00.000Z"),
      },
    ];

    const runRows: TelemetryRunRow[] = [
      {
        runId: "r1",
        status: "running",
        agentId: "a1",
        agentName: "Planner",
        adapterType: "claude_local",
        projectId: "p1",
        projectName: "Core",
        issueId: "i1",
        issueIdentifier: "PAP-101",
        issueTitle: "Build telemetry",
        usageJson: null,
        startedAt: new Date("2026-11-26T11:50:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-11-26T11:50:00.000Z"),
      },
      {
        runId: "r2",
        status: "succeeded",
        agentId: "a2",
        agentName: "Builder",
        adapterType: "codex_local",
        projectId: "p2",
        projectName: "UI",
        issueId: "i2",
        issueIdentifier: "PAP-102",
        issueTitle: "Wire charts",
        usageJson: null,
        startedAt: new Date("2026-11-26T11:30:00.000Z"),
        finishedAt: new Date("2026-11-26T11:55:00.000Z"),
        createdAt: new Date("2026-11-26T11:30:00.000Z"),
      },
    ];

    const runCostRows: TelemetryRunCostAggRow[] = [
      {
        heartbeatRunId: "r1",
        totalTokens: 6000,
        outputTokens: 2000,
        costCents: 120,
        model: "claude-opus-4",
        provider: "anthropic",
      },
      {
        heartbeatRunId: "r2",
        totalTokens: 4500,
        outputTokens: 1500,
        costCents: 110,
        model: "gpt-5",
        provider: "openai",
      },
    ];

    const result = buildDashboardTelemetryFromRows({
      window: "1h",
      now,
      costRows,
      runRows,
      runCostRows,
    });

    expect(result.buckets).toHaveLength(12);
    expect(result.models).toEqual([
      "claude-opus-4",
      "gpt-5",
      "gemini-2.5-pro",
      "o3",
      "claude-sonnet-4",
      "other",
    ]);

    // Total tokens = 6000 + 3000 + 1500 + 1000 + 600 + 400 = 12500
    expect(result.velocity.totalTokens).toBe(12500);
    expect(result.velocity.tokensPerHour).toBe(12500);
    expect(result.velocity.totalCostCents).toBe(265);
    expect(result.velocity.activeSessions).toBe(1);
    expect(result.velocity.idleSessions).toBe(1);
    expect(result.host.activeRuns).toBe(1);

    // grok-3 (400 tokens) should be rolled into "other" in bucket 1 (11:05)
    expect(result.buckets[1]?.byModel.other).toBe(400);

    // Shares: Core/Planner = 8000 (64.0%), UI/Builder = 4500 (36.0%)
    expect(result.projectShares).toEqual([
      { id: "p1", name: "Core", kind: "project", tokens: 8000, costCents: 155, sharePct: 64 },
      { id: "p2", name: "UI", kind: "project", tokens: 4500, costCents: 110, sharePct: 36 },
    ]);
    expect(result.agentShares).toEqual([
      { id: "a1", name: "Planner", kind: "agent", tokens: 8000, costCents: 155, sharePct: 64 },
      { id: "a2", name: "Builder", kind: "agent", tokens: 4500, costCents: 110, sharePct: 36 },
    ]);

    // Active session r1: 10 minutes elapsed, 6000 tokens -> 36000 tok/hr
    expect(result.sessions[0]).toMatchObject({
      runId: "r1",
      isActive: true,
      recentTokens: 6000,
      totalTokens: 6000,
      outputTokens: 2000,
      costCents: 120,
      elapsedMs: 10 * 60_000,
      burnRateTokPerHour: 36000,
    });
    expect(result.sessions[1]).toMatchObject({
      runId: "r2",
      isActive: false,
      recentTokens: 4500,
      totalTokens: 4500,
      elapsedMs: 25 * 60_000,
    });
  });
});

function createControlPlaneFakeDb(responses: unknown[][]) {
  let callIndex = 0;
  const select = vi.fn(() => {
    const rows = responses[callIndex] ?? [];
    callIndex += 1;

    const thenable: Record<string, any> = {
      from: vi.fn(() => thenable),
      leftJoin: vi.fn(() => thenable),
      where: vi.fn(() => thenable),
      orderBy: vi.fn(() => thenable),
      limit: vi.fn(() => thenable),
      groupBy: vi.fn(() => thenable),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return thenable;
  });

  return { select } as any;
}

describe("internal control-plane snapshot builder", () => {
  it("returns clean zeroed connected snapshot when tables are empty", () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const result = buildControlPlaneSnapshotFromRows({
      now,
      agentCounts: [],
      workerRuns: [],
      runModels: [],
      activeRunCounts: { running: 0, queued: 0 },
      outcomeRows: [],
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
    });

    expect(result).toEqual({
      connected: true,
      source: "paperwork_internal",
      timestamp: now.toISOString(),
      summary: {
        activeRuns: 0,
        queuedRuns: 0,
        activeAgents: 0,
        totalAgents: 0,
        pendingApprovals: 0,
        pendingDecisions: 0,
        openBudgetIncidents: 0,
        pendingWorktreeProposals: 0,
        passRatePct: 0,
      },
      workers: [],
      gates: {
        approvals: [],
        operatorDecisions: [],
        worktreeProposals: [],
        budgetIncidents: [],
      },
      outcomes: {
        windowHours: 24,
        total: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        queued: 0,
        byAdapter: {},
        byProvider: {},
      },
      recentEvents: [],
    });
  });

  it("computes summary, workers, gates, 24h outcomes, and recent events without leaking secrets", () => {
    const now = new Date("2026-11-26T12:00:00.000Z");

    const agentCounts: ControlPlaneAgentCountRow[] = [
      { status: "running", count: 2 },
      { status: "idle", count: 3 },
      { status: "paused", count: 1 },
      { status: "error", count: 1 },
    ];

    const workerRuns: ControlPlaneWorkerRunRow[] = [
      {
        runId: "run-1",
        status: "running",
        agentId: "agent-1",
        agentName: "Planner",
        agentRole: "lead",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-4", apiKey: "sk-ant-SECRET-VALUE" },
        usageJson: null,
        invocationSource: "assignment",
        triggerDetail: null,
        issueIdentifier: "PAP-201",
        issueTitle: "Ship internal control plane",
        startedAt: new Date("2026-11-26T11:55:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-11-26T11:55:00.000Z"),
      },
      {
        runId: "run-2",
        status: "succeeded",
        agentId: "agent-2",
        agentName: "Builder",
        agentRole: "engineer",
        adapterType: "codex_local",
        adapterConfig: { env: { OPENAI_API_KEY: "sk-openai-SECRET-VALUE" } },
        usageJson: { model: "gpt-5" },
        invocationSource: "timer",
        triggerDetail: "scheduled_sweep",
        issueIdentifier: null,
        issueTitle: null,
        startedAt: new Date("2026-11-26T11:40:00.000Z"),
        finishedAt: new Date("2026-11-26T11:50:00.000Z"),
        createdAt: new Date("2026-11-26T11:40:00.000Z"),
      },
    ];

    const runModels: ControlPlaneRunModelRow[] = [
      { heartbeatRunId: "run-1", model: "claude-sonnet-4" },
    ];

    const outcomeRows: ControlPlaneOutcomeRow[] = [
      { status: "succeeded", adapterType: "claude_local", count: 6 },
      { status: "succeeded", adapterType: "codex_local", count: 2 },
      { status: "failed", adapterType: "claude_local", count: 1 },
      { status: "timed_out", adapterType: "codex_local", count: 1 },
      { status: "cancelled", adapterType: "codex_local", count: 1 },
      { status: "running", adapterType: "claude_local", count: 1 },
      { status: "queued", adapterType: "codex_local", count: 2 },
    ];

    const providerRows: ControlPlaneProviderCountRow[] = [
      { provider: "anthropic", count: 9 },
      { provider: "openai", count: 4 },
    ];

    const approvalRows: ControlPlaneApprovalRow[] = [
      {
        id: "app-1",
        type: "hire_agent",
        status: "pending",
        payload: { title: "Approve QA Agent", token: "secret-approval-token" },
        createdAt: new Date("2026-11-26T11:30:00.000Z"),
      },
    ];

    const decisionRows: ControlPlaneDecisionRow[] = [
      {
        id: "dec-1",
        title: "Confirm production rollout",
        status: "pending",
        priority: "critical",
        createdAt: new Date("2026-11-26T11:20:00.000Z"),
      },
    ];

    const worktreeProposalRows: ControlPlaneWorktreeProposalRow[] = [
      {
        id: "wt-1",
        rationale: "Restrict branch cleanup to merged worktrees only",
        status: "proposed",
        createdAt: new Date("2026-11-26T11:10:00.000Z"),
      },
    ];

    const budgetIncidentRows: ControlPlaneBudgetIncidentRow[] = [
      {
        id: "bi-1",
        scopeType: "company",
        metric: "billed_cents",
        thresholdType: "hard",
        amountLimit: 10000,
        amountObserved: 10500,
        status: "open",
        createdAt: new Date("2026-11-26T11:00:00.000Z"),
      },
    ];

    const activityRows: ControlPlaneActivityRow[] = [
      {
        id: "act-1",
        action: "approval.created",
        entityType: "approval",
        entityId: "app-1",
        actorType: "agent",
        details: { title: "Approve QA Agent", secretKey: "super-secret-value" },
        createdAt: new Date("2026-11-26T11:30:00.000Z"),
      },
    ];

    const result = buildControlPlaneSnapshotFromRows({
      now,
      agentCounts,
      workerRuns,
      runModels,
      activeRunCounts: { running: 1, queued: 2 },
      outcomeRows,
      providerRows,
      pendingApprovalsCount: 1,
      pendingDecisionsCount: 1,
      openBudgetIncidentsCount: 1,
      pendingWorktreeProposalsCount: 1,
      approvalRows,
      decisionRows,
      worktreeProposalRows,
      budgetIncidentRows,
      activityRows,
    });

    expect(result.connected).toBe(true);
    expect(result.source).toBe("paperwork_internal");
    expect(result.timestamp).toBe(now.toISOString());

    // passRatePct = 8 / (8 + 1 + 1) = 80%
    expect(result.summary).toEqual({
      activeRuns: 1,
      queuedRuns: 2,
      activeAgents: 5,
      totalAgents: 7,
      pendingApprovals: 1,
      pendingDecisions: 1,
      openBudgetIncidents: 1,
      pendingWorktreeProposals: 1,
      passRatePct: 80,
    });

    expect(result.workers).toEqual([
      {
        agentId: "agent-1",
        agentName: "Planner",
        role: "lead",
        adapterType: "claude_local",
        model: "claude-sonnet-4",
        status: "running",
        runId: "run-1",
        startedAt: "2026-11-26T11:55:00.000Z",
        durationMs: 5 * 60_000,
        contextLabel: "PAP-201 · Ship internal control plane",
      },
      {
        agentId: "agent-2",
        agentName: "Builder",
        role: "engineer",
        adapterType: "codex_local",
        model: "gpt-5",
        status: "succeeded",
        runId: "run-2",
        startedAt: "2026-11-26T11:40:00.000Z",
        durationMs: 10 * 60_000,
        contextLabel: "scheduled_sweep",
      },
    ]);

    expect(result.gates.approvals).toHaveLength(1);
    expect(result.gates.approvals[0]).toMatchObject({
      id: "app-1",
      kind: "approval",
      title: "hire_agent: Approve QA Agent",
      status: "pending",
      severity: "high",
      linkPath: "/approvals/app-1",
    });

    expect(result.gates.operatorDecisions[0]).toMatchObject({
      id: "dec-1",
      kind: "operator_decision",
      title: "Confirm production rollout",
      severity: "critical",
      linkPath: "/decisions/dec-1",
    });

    expect(result.gates.worktreeProposals[0]).toMatchObject({
      id: "wt-1",
      kind: "worktree_proposal",
      status: "proposed",
      severity: "medium",
      linkPath: "/worktrees",
    });

    expect(result.gates.budgetIncidents[0]).toMatchObject({
      id: "bi-1",
      kind: "budget_incident",
      status: "open",
      severity: "critical",
      linkPath: "/costs",
    });

    expect(result.outcomes).toEqual({
      windowHours: 24,
      total: 14,
      succeeded: 8,
      failed: 1,
      cancelled: 1,
      timedOut: 1,
      running: 1,
      queued: 2,
      byAdapter: {
        claude_local: 8,
        codex_local: 6,
      },
      byProvider: {
        anthropic: 9,
        openai: 4,
      },
    });

    expect(result.recentEvents).toEqual([
      {
        id: "act-1",
        action: "approval.created",
        entityType: "approval",
        entityId: "app-1",
        actorType: "agent",
        createdAt: "2026-11-26T11:30:00.000Z",
        summary: "approval.created (approval): Approve QA Agent",
      },
    ]);

    // Ensure no secret values ever appear anywhere in serialized response
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-ant-SECRET-VALUE");
    expect(serialized).not.toContain("sk-openai-SECRET-VALUE");
    expect(serialized).not.toContain("secret-approval-token");
    expect(serialized).not.toContain("super-secret-value");
  });
});

describe("dashboard telemetry & internal control-plane routes", () => {
  it("serves GET /api/companies/:companyId/dashboard/telemetry with window parsing", async () => {
    const app = createApp(createFakeDb());
    const res = await request(app).get("/api/companies/company-1/dashboard/telemetry?window=10m");

    expect(res.status).toBe(200);
    expect(res.body.window).toBe("10m");
    expect(res.body.buckets).toHaveLength(10);
    expect(res.body.velocity.totalTokens).toBe(0);

    const fallbackRes = await request(app).get("/api/companies/company-1/dashboard/telemetry?window=invalid");
    expect(fallbackRes.status).toBe(200);
    expect(fallbackRes.body.window).toBe("6h");
    expect(fallbackRes.body.buckets).toHaveLength(12);
  });

  it("enforces company access on telemetry and internal control-plane endpoints", async () => {
    const unauthApp = createApp(createControlPlaneFakeDb([]), { type: "none" });
    const res401 = await request(unauthApp).get("/api/companies/company-1/dashboard/telemetry");
    expect(res401.status).toBe(401);

    const dgate401 = await request(unauthApp).get("/api/companies/company-1/dashboard/dgate");
    expect(dgate401.status).toBe(401);

    const wrongCompanyApp = createApp(createControlPlaneFakeDb([]), {
      type: "board",
      userId: "user-1",
      companyIds: ["company-other"],
      source: "session",
      isInstanceAdmin: false,
    });
    const dgate403 = await request(wrongCompanyApp).get("/api/companies/company-1/dashboard/dgate");
    expect(dgate403.status).toBe(403);
  });

  it("serves GET /api/companies/:companyId/dashboard/dgate from Paperwork DB and removes POST /dgate/snapshot", async () => {
    const fakeDb = createControlPlaneFakeDb([
      [{ status: "running", count: 1 }, { status: "idle", count: 2 }], // agentCounts
      [{ status: "running", count: 1 }], // activeRunRows
      [
        {
          runId: "run-live-1",
          status: "running",
          agentId: "agent-1",
          agentName: "OpsLead",
          agentRole: "lead",
          adapterType: "claude_local",
          adapterConfig: { model: "claude-opus-4" },
          usageJson: null,
          invocationSource: "assignment",
          triggerDetail: null,
          issueIdentifier: "PAP-900",
          issueTitle: "Control plane live check",
          startedAt: new Date("2026-11-26T11:58:00.000Z"),
          finishedAt: null,
          createdAt: new Date("2026-11-26T11:58:00.000Z"),
        },
      ], // workerRuns
      [
        { status: "succeeded", adapterType: "claude_local", count: 4 },
        { status: "running", adapterType: "claude_local", count: 1 },
      ], // outcomeRows
      [{ provider: "anthropic", count: 5 }], // providerRows
      [{ count: 1 }], // pendingApprovalsAgg
      [{ count: 0 }], // pendingDecisionsAgg
      [{ count: 0 }], // openBudgetIncidentsAgg
      [{ count: 0 }], // pendingWorktreeProposalsAgg
      [
        {
          id: "app-live-1",
          type: "budget_override",
          status: "pending",
          payload: { title: "Increase cap" },
          createdAt: new Date("2026-11-26T11:50:00.000Z"),
        },
      ], // approvalRows
      [], // decisionRows
      [], // worktreeProposalRows
      [], // budgetIncidentRows
      [
        {
          id: "evt-1",
          action: "run.started",
          entityType: "heartbeat_run",
          entityId: "run-live-1",
          actorType: "system",
          details: { status: "running" },
          createdAt: new Date("2026-11-26T11:58:00.000Z"),
        },
      ], // activityRows
      [{ heartbeatRunId: "run-live-1", model: "claude-opus-4" }], // runModels
    ]);

    const app = createApp(fakeDb);
    const getRes = await request(app).get("/api/companies/company-1/dashboard/dgate");

    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      connected: true,
      source: "paperwork_internal",
      summary: {
        activeRuns: 1,
        queuedRuns: 0,
        activeAgents: 3,
        totalAgents: 3,
        pendingApprovals: 1,
        pendingDecisions: 0,
        openBudgetIncidents: 0,
        pendingWorktreeProposals: 0,
        passRatePct: 100,
      },
      outcomes: {
        windowHours: 24,
        total: 5,
        succeeded: 4,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 1,
        queued: 0,
        byAdapter: { claude_local: 5 },
        byProvider: { anthropic: 5 },
      },
    });
    expect(typeof getRes.body.timestamp).toBe("string");
    expect(getRes.body.workers).toHaveLength(1);
    expect(getRes.body.workers[0]).toMatchObject({
      agentId: "agent-1",
      agentName: "OpsLead",
      role: "lead",
      adapterType: "claude_local",
      model: "claude-opus-4",
      status: "running",
      runId: "run-live-1",
      contextLabel: "PAP-900 · Control plane live check",
    });
    expect(getRes.body.gates.approvals).toHaveLength(1);
    expect(getRes.body.gates.approvals[0]).toMatchObject({
      id: "app-live-1",
      kind: "approval",
      severity: "critical",
      linkPath: "/approvals/app-live-1",
    });
    expect(getRes.body.recentEvents).toHaveLength(1);
    expect(getRes.body.recentEvents[0]).toMatchObject({
      id: "evt-1",
      action: "run.started",
      entityType: "heartbeat_run",
      entityId: "run-live-1",
      actorType: "system",
      summary: "run.started (heartbeat_run): running",
    });

    // Legacy Mac push endpoint must no longer exist
    const postRes = await request(app)
      .post("/api/companies/company-1/dashboard/dgate/snapshot")
      .send({ ok: true });
    expect(postRes.status).toBe(404);
  });
});

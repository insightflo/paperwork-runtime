import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import {
  buildDashboardTelemetryFromRows,
  clearDgateSnapshotCache,
  dashboardTelemetryService,
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

describe("dgate bridge service", () => {
  beforeEach(() => {
    clearDgateSnapshotCache();
  });

  afterEach(() => {
    clearDgateSnapshotCache();
  });

  it("returns available:false when DGATE_WEB_URL is unset and no snapshot was pushed", async () => {
    const svc = dashboardTelemetryService(createFakeDb(), {
      dgateWebUrl: () => undefined,
    });
    const res = await svc.getDgateSnapshot("company-1");
    expect(res).toMatchObject({
      available: false,
      source: "none",
      stale: false,
      fetchedAt: null,
      snapshot: null,
    });
    expect(res.reason).toBeTruthy();
  });

  it("handles push -> fresh -> stale (>15s) -> expired (>60s) transitions", async () => {
    let nowMs = Date.parse("2026-11-26T12:00:00.000Z");
    const svc = dashboardTelemetryService(createFakeDb(), {
      now: () => new Date(nowMs),
      dgateWebUrl: () => undefined,
    });

    const pushed = svc.pushDgateSnapshot("company-1", { workers: 3, activeForks: 1 });
    expect(pushed).toEqual({ ok: true, fetchedAt: "2026-11-26T12:00:00.000Z" });

    // 5s later -> fresh
    nowMs += 5_000;
    const fresh = await svc.getDgateSnapshot("company-1");
    expect(fresh).toEqual({
      available: true,
      source: "push",
      stale: false,
      fetchedAt: "2026-11-26T12:00:00.000Z",
      snapshot: { workers: 3, activeForks: 1 },
    });

    // 20s later -> stale
    nowMs += 15_000;
    const stale = await svc.getDgateSnapshot("company-1");
    expect(stale).toEqual({
      available: true,
      source: "push",
      stale: true,
      fetchedAt: "2026-11-26T12:00:00.000Z",
      snapshot: { workers: 3, activeForks: 1 },
    });

    // 65s later -> expired
    nowMs += 45_000;
    const expired = await svc.getDgateSnapshot("company-1");
    expect(expired).toMatchObject({
      available: false,
      source: "none",
      stale: false,
      fetchedAt: null,
      snapshot: null,
    });
  });

  it("polls DGATE_WEB_URL when configured and falls back to push cache on poll failure", async () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ workers: 5, sourceTag: "live" }),
    });

    const svc = dashboardTelemetryService(createFakeDb(), {
      now: () => now,
      fetchImpl: fetchMock as unknown as typeof fetch,
      dgateWebUrl: () => "http://127.0.0.1:4199/",
    });

    const polled = await svc.getDgateSnapshot("company-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4199/api/snapshot",
      expect.objectContaining({ method: "GET" }),
    );
    expect(polled).toEqual({
      available: true,
      source: "poll",
      stale: false,
      fetchedAt: now.toISOString(),
      snapshot: { workers: 5, sourceTag: "live" },
    });

    // Push a fallback snapshot, then simulate poll failure
    svc.pushDgateSnapshot("company-1", { workers: 2, fallback: true });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const fallback = await svc.getDgateSnapshot("company-1");
    expect(fallback).toEqual({
      available: true,
      source: "push",
      stale: false,
      fetchedAt: now.toISOString(),
      snapshot: { workers: 2, fallback: true },
    });
  });
});

describe("dashboard telemetry & dgate routes", () => {
  const originalDgateUrl = process.env.DGATE_WEB_URL;

  beforeEach(() => {
    delete process.env.DGATE_WEB_URL;
    clearDgateSnapshotCache();
  });

  afterEach(() => {
    if (originalDgateUrl === undefined) {
      delete process.env.DGATE_WEB_URL;
    } else {
      process.env.DGATE_WEB_URL = originalDgateUrl;
    }
    clearDgateSnapshotCache();
  });

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

  it("enforces company access on telemetry and dgate endpoints", async () => {
    const unauthApp = createApp(createFakeDb(), { type: "none" });
    const res401 = await request(unauthApp).get("/api/companies/company-1/dashboard/telemetry");
    expect(res401.status).toBe(401);

    const wrongCompanyApp = createApp(createFakeDb(), {
      type: "board",
      userId: "user-1",
      companyIds: ["company-other"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res403 = await request(wrongCompanyApp)
      .post("/api/companies/company-1/dashboard/dgate/snapshot")
      .send({ ok: true });
    expect(res403.status).toBe(403);
  });

  it("validates POST /dgate/snapshot payloads and serves them on GET /dgate", async () => {
    const app = createApp(createFakeDb());

    const arrayRes = await request(app)
      .post("/api/companies/company-1/dashboard/dgate/snapshot")
      .send([1, 2, 3]);
    expect(arrayRes.status).toBe(400);

    const oversizedRes = await request(app)
      .post("/api/companies/company-1/dashboard/dgate/snapshot")
      .send({ blob: "x".repeat(520 * 1024) });
    expect(oversizedRes.status).toBe(413);

    const pushRes = await request(app)
      .post("/api/companies/company-1/dashboard/dgate/snapshot")
      .send({ activeWorkers: 4, queueDepth: 1 });
    expect(pushRes.status).toBe(200);
    expect(pushRes.body.ok).toBe(true);
    expect(typeof pushRes.body.fetchedAt).toBe("string");

    const getRes = await request(app).get("/api/companies/company-1/dashboard/dgate");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      available: true,
      source: "push",
      stale: false,
      snapshot: { activeWorkers: 4, queueDepth: 1 },
    });
  });
});

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  createWorkflowHarnessFleetRouter,
  type WorkflowHarnessFleetDeps,
  type WorkflowHarnessFleetStepRun,
} from "../routes/workflow-harness-fleet.js";
import type { HarnessSummaryRun } from "../services/workflow/harness-summary.js";

/**
 * Read-only fleet route contract: auth is checked before any loader runs (401/403),
 * an empty fleet is a 200 with zeroed counts, and a mixed fleet aggregates the
 * per-run harness summaries (healthy / stalled / timed out / sharp / escalate / gates).
 */

const NOW = new Date("2025-01-01T12:00:00.000Z");
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PATH = `/api/companies/${COMPANY}/workflows/harness-fleet`;

type TestActor =
  | { type: "none"; source: "none" }
  | { type: "agent"; agentId: string; companyId: string }
  | { type: "board"; source: "session"; userId: string; companyIds: string[] }
  | { type: "board"; source: "local_implicit"; userId: string };

const minutesAgo = (min: number) => new Date(NOW.getTime() - min * 60_000);

function makeRun(id: string, overrides: Partial<HarnessSummaryRun> = {}): HarnessSummaryRun {
  return { id, status: "running", startedAt: minutesAgo(30), createdAt: minutesAgo(30), ...overrides };
}

function makeStep(runId: string, overrides: Partial<WorkflowHarnessFleetStepRun> = {}): WorkflowHarnessFleetStepRun {
  return {
    id: `${runId}-step`, workflowRunId: runId, status: "running", startedAt: minutesAgo(30), completedAt: null,
    retryCount: 0, lastDispatchErrorAt: null, lastDispatchAcceptedAt: null, lastDispatchAttemptAt: null,
    ...overrides,
  };
}

function createApp(deps: Partial<WorkflowHarnessFleetDeps>, actor: TestActor) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", createWorkflowHarnessFleetRouter(deps as WorkflowHarnessFleetDeps));
  app.use(errorHandler);
  return app;
}

describe("workflow harness fleet route", () => {
  it("blocks unauthenticated and cross-company actors before loading any run", async () => {
    const deps = { listRuns: vi.fn(), listStepRuns: vi.fn(), now: () => NOW };
    const anonymous = await request(createApp(deps, { type: "none", source: "none" })).get(PATH);
    expect(anonymous.status).toBe(401);

    const foreignAgent = await request(createApp(deps, { type: "agent", agentId: "agent-1", companyId: OTHER })).get(PATH);
    expect(foreignAgent.status).toBe(403);

    const foreignBoard = await request(createApp(deps, { type: "board", source: "session", userId: "u1", companyIds: [OTHER] })).get(PATH);
    expect(foreignBoard.status).toBe(403);

    expect(deps.listRuns).not.toHaveBeenCalled();
    expect(deps.listStepRuns).not.toHaveBeenCalled();
  });

  it("returns 200 with zeroed counts for a company without runs", async () => {
    const deps = { listRuns: vi.fn().mockResolvedValue([]), listStepRuns: vi.fn().mockResolvedValue([]), now: () => NOW };
    const res = await request(createApp(deps, { type: "board", source: "local_implicit", userId: "board" })).get(PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companyId: COMPANY, evaluatedAt: NOW.toISOString(), totalRuns: 0, healthyRuns: 0, stalledRuns: 0, timedOutRuns: 0,
      sharpRuns: 0, splitRuns: 0, escalatedRuns: 0, pendingAdvisorGates: 0, challengedAdvisorGates: 0,
      avgSuccessRatePct: null, worstStallRunId: null, maxIdleMs: 0, runs: [],
    });
    expect(deps.listRuns).toHaveBeenCalledWith(COMPANY, 200);
    expect(deps.listStepRuns).toHaveBeenCalledWith([]);
  });

  it("aggregates healthy, stalled, timed-out and escalated runs for a company member", async () => {
    const runs = [
      makeRun("healthy"), makeRun("stalled"), makeRun("timed-out"),
      makeRun("done", { status: "completed" }), makeRun("pending", { status: "pending" }),
    ];
    const steps = [
      makeStep("healthy", { lastDispatchAcceptedAt: minutesAgo(1) }),
      // idle 20m >= 10m stall, retried into the same error twice -> g2 challenge
      makeStep("stalled", { lastDispatchAcceptedAt: minutesAgo(20), retryCount: 2, lastDispatchErrorAt: minutesAgo(20) }),
      // recent activity but 61m elapsed >= 60m max
      makeStep("timed-out", { startedAt: minutesAgo(61), lastDispatchAcceptedAt: minutesAgo(1) }),
      makeStep("done", { status: "completed", completedAt: minutesAgo(5) }),
      // "pending" has no steps yet -> planning gate g1
    ];
    const deps = {
      listRuns: vi.fn().mockResolvedValue(runs),
      listStepRuns: vi.fn().mockResolvedValue([...steps, makeStep("orphan")]),
      now: () => NOW,
    };
    const actor: TestActor = { type: "board", source: "session", userId: "u1", companyIds: [OTHER, COMPANY] };
    const res = await request(createApp(deps, actor)).get(PATH);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: COMPANY, totalRuns: 5, healthyRuns: 3, stalledRuns: 1, timedOutRuns: 1,
      sharpRuns: 1, splitRuns: 2, escalatedRuns: 2, pendingAdvisorGates: 1, challengedAdvisorGates: 1,
      avgSuccessRatePct: 100, worstStallRunId: "timed-out", maxIdleMs: 20 * 60_000,
    });
    expect(res.body.runs.map((run: { runId: string }) => run.runId))
      .toEqual(["healthy", "stalled", "timed-out", "done", "pending"]);
    expect(deps.listStepRuns).toHaveBeenCalledWith(["healthy", "stalled", "timed-out", "done", "pending"]);
  });
});

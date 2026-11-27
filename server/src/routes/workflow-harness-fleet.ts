// server/src/routes/workflow-harness-fleet.ts
//
// Standalone, read-only workflow harness fleet route. It folds the recent runs of
// one company through `buildWorkflowRunHarnessSummary` and returns aggregate
// stall / route / advisor-gate counts. It never touches execution control.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { desc, eq, inArray } from "drizzle-orm";
import {
  buildWorkflowRunHarnessSummary,
  type HarnessSummaryRun,
  type HarnessSummaryStepRun,
  type WorkflowRunHarnessSummary,
} from "../services/workflow/harness-summary.js";
import { assertCompanyAccess } from "./authz.js";

/** Step rows are grouped back to their run, so the run id travels with each row. */
export type WorkflowHarnessFleetStepRun = HarnessSummaryStepRun & { workflowRunId: string };

export interface WorkflowHarnessFleetDeps {
  /** Used only when a loader is not injected. */
  db?: Db;
  listRuns?: (companyId: string, limit: number) => Promise<HarnessSummaryRun[]>;
  /** Batch loader; rows whose run is outside the loaded set are ignored. */
  listStepRuns?: (runIds: string[]) => Promise<WorkflowHarnessFleetStepRun[]>;
  /** One instant for the whole fleet so counts describe a single snapshot. */
  now?: () => Date;
  /** Recent-run window; clamped to 1..500. */
  limit?: number;
}

export interface WorkflowHarnessFleetSummary {
  totalRuns: number;
  healthyRuns: number;
  stalledRuns: number;
  timedOutRuns: number;
  sharpRuns: number;
  splitRuns: number;
  escalatedRuns: number;
  /** Runs waiting on the planning gate (g1). */
  pendingAdvisorGates: number;
  /** Runs blocked on the retry challenge gate (g2). */
  challengedAdvisorGates: number;
  /** Mean of runs with terminal step evidence; `null` when no run has any. */
  avgSuccessRatePct: number | null;
  /** Worst stalled or timed-out run; `null` when every run is healthy. */
  worstStallRunId: string | null;
  maxIdleMs: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const STALL_RANK: Record<WorkflowRunHarnessSummary["stallStatus"], number> = { healthy: 0, stalled: 1, timed_out: 2 };

async function listRunsFromDb(db: Db, companyId: string, limit: number): Promise<HarnessSummaryRun[]> {
  return db
    .select({ id: workflowRuns.id, status: workflowRuns.status, startedAt: workflowRuns.startedAt, createdAt: workflowRuns.createdAt })
    .from(workflowRuns)
    .where(eq(workflowRuns.companyId, companyId))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(limit);
}

async function listStepRunsFromDb(db: Db, runIds: string[]): Promise<WorkflowHarnessFleetStepRun[]> {
  if (runIds.length === 0) return [];
  const t = workflowStepRuns;
  return db
    .select({
      id: t.id, workflowRunId: t.workflowRunId, status: t.status, startedAt: t.startedAt, completedAt: t.completedAt,
      retryCount: t.retryCount, lastDispatchErrorAt: t.lastDispatchErrorAt,
      lastDispatchAcceptedAt: t.lastDispatchAcceptedAt, lastDispatchAttemptAt: t.lastDispatchAttemptAt,
    })
    .from(t)
    .where(inArray(t.workflowRunId, runIds));
}

/** Pure fold of per-run summaries into the fleet counts. */
export function aggregateWorkflowHarnessFleet(summaries: WorkflowRunHarnessSummary[]): WorkflowHarnessFleetSummary {
  const fleet: WorkflowHarnessFleetSummary = {
    totalRuns: summaries.length, healthyRuns: 0, stalledRuns: 0, timedOutRuns: 0,
    sharpRuns: 0, splitRuns: 0, escalatedRuns: 0, pendingAdvisorGates: 0, challengedAdvisorGates: 0,
    avgSuccessRatePct: null, worstStallRunId: null, maxIdleMs: 0,
  };
  let worst: WorkflowRunHarnessSummary | null = null;
  let rateSum = 0;
  let rateCount = 0;
  for (const summary of summaries) {
    if (summary.stallStatus === "healthy") fleet.healthyRuns += 1;
    else if (summary.stallStatus === "stalled") fleet.stalledRuns += 1;
    else fleet.timedOutRuns += 1;
    if (summary.route === "sharp") fleet.sharpRuns += 1;
    else if (summary.route === "split") fleet.splitRuns += 1;
    else fleet.escalatedRuns += 1;
    if (summary.advisorGate === "g1_pending") fleet.pendingAdvisorGates += 1;
    if (summary.advisorGate === "g2_challenge") fleet.challengedAdvisorGates += 1;
    if (summary.successRatePct !== null) {
      rateSum += summary.successRatePct;
      rateCount += 1;
    }
    fleet.maxIdleMs = Math.max(fleet.maxIdleMs, summary.idleMs);
    if (summary.stallStatus !== "healthy" && (!worst
      || STALL_RANK[summary.stallStatus] > STALL_RANK[worst.stallStatus]
      || (STALL_RANK[summary.stallStatus] === STALL_RANK[worst.stallStatus] && summary.idleMs > worst.idleMs))) {
      worst = summary;
    }
  }
  fleet.avgSuccessRatePct = rateCount > 0 ? Math.round((rateSum / rateCount) * 10) / 10 : null;
  fleet.worstStallRunId = worst?.runId ?? null;
  return fleet;
}

export function createWorkflowHarnessFleetRouter(deps: WorkflowHarnessFleetDeps) {
  const { db } = deps;
  const listRuns = deps.listRuns ?? (db ? (companyId: string, limit: number) => listRunsFromDb(db, companyId, limit) : null);
  const listStepRuns = deps.listStepRuns ?? (db ? (runIds: string[]) => listStepRunsFromDb(db, runIds) : null);
  if (!listRuns || !listStepRuns) {
    throw new TypeError("createWorkflowHarnessFleetRouter requires either loaders or db");
  }
  const limit = Math.max(1, Math.min(Math.floor(deps.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.get("/companies/:companyId/workflows/harness-fleet", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const runs = await listRuns(companyId, limit);
    const stepRows = await listStepRuns(runs.map((run) => run.id));
    const stepsByRun = new Map<string, WorkflowHarnessFleetStepRun[]>();
    for (const row of stepRows) {
      const bucket = stepsByRun.get(row.workflowRunId);
      if (bucket) bucket.push(row);
      else stepsByRun.set(row.workflowRunId, [row]);
    }
    const evaluatedAt = now();
    const summaries = runs.map((run) => buildWorkflowRunHarnessSummary(run, stepsByRun.get(run.id) ?? [], evaluatedAt));
    res.json({ companyId, evaluatedAt: evaluatedAt.toISOString(), ...aggregateWorkflowHarnessFleet(summaries), runs: summaries });
  });

  return router;
}

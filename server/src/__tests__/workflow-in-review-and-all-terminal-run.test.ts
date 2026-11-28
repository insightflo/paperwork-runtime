import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, instanceSettings, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables, seedBoundaryWorld, seedHeartbeatRun, type BoundaryWorld } from "./helpers/run-terminal-boundary-fixture.js";
import { syncStepRunsFromIssueState } from "../services/workflow/workflow-issue-state-sync.js";
import { resetUnlaunchedTerminalStepRuns } from "../services/workflow/workflow-step-run-maintenance.js";
import { finalizeWorkflowRunState } from "../services/workflow/workflow-run-finalization.js";
import { normalizeRecord } from "../services/workflow/dag-metadata-helpers.js";
import type { WorkflowExecutionContext, WorkflowStep } from "../services/workflow/dag-engine.js";
import { syncWorkflowRunState } from "../services/workflow/workflow-run-sync-core.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping W4 PostgreSQL cases: ${support.reason}`);
const describePG = support.supported ? describe : describe.skip;

describePG("workflow inactive review and all-terminal convergence", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("s35-w4-settlement-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterEach(async () => { await db.delete(instanceSettings); await cleanupTerminalBoundaryTables(db); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await pg.cleanup(); });

  const rows = (w: BoundaryWorld) => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, w.runId));
  async function world(status = "in_review") {
    const w = await seedBoundaryWorld(db, { stepIssueStatus: status });
    // No mission cleanup or external worker invocation belongs in this settlement fixture.
    await db.update(workflowRuns).set({ missionId: null }).where(eq(workflowRuns.id, w.runId));
    return w;
  }
  async function converge(w: BoundaryWorld, stepRuns: Awaited<ReturnType<typeof rows>>, boundary: boolean) {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, w.workflowId));
    const steps = stepRuns.map(s => ({ id: s.stepId, name: s.stepId, type: "agent", agentId: w.agentId, dependencies: [] })) as WorkflowStep[];
    const context = { run, definition, steps, stepRuns } as WorkflowExecutionContext;
    return finalizeWorkflowRunState(db, context, stepRuns, boundary, true, {
      normalizeRecord, getDynamicLaunchStepIds: () => undefined,
      buildWorkflowDefinitionExecutionShape: () => ({ name: definition.name, steps }),
    });
  }

  it.each([false, true])("inactive in_review fails closed and parent settles (boundary=%s)", async boundary => {
    const w = await world();
    const synced = await syncStepRunsFromIssueState(db, await rows(w));
    expect(synced[0]).toMatchObject({ status: "failed", completedAt: expect.any(Date) });
    expect((await converge(w, synced, boundary)).status).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, w.stepIssueId));
    expect(issue.status).toBe("in_review"); // Review never invents an approved completion.
  });

  it.each(["queued", "running"])("in_review preserves a %s heartbeat", async status => {
    const w = await world();
    await seedHeartbeatRun(db, w, { status });
    const synced = await syncStepRunsFromIssueState(db, await rows(w));
    expect(synced[0]).toMatchObject({ status: "running", completedAt: null });
    expect((await converge(w, synced, false)).status).toBe("running");
  });

  it("in_review preserves an accepted wake before the heartbeat is created", async () => {
    const w = await world();
    await db.insert(agentWakeupRequests).values({ companyId: w.companyId, agentId: w.agentId,
      issueId: w.stepIssueId, source: "test", status: "queued" });
    expect((await syncStepRunsFromIssueState(db, await rows(w)))[0].status).toBe("running");
  });

  it("a finished heartbeat does not keep in_review running", async () => {
    const w = await world();
    const id = await seedHeartbeatRun(db, w, { status: "succeeded" });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, id));
    expect((await syncStepRunsFromIssueState(db, await rows(w)))[0].status).toBe("failed");
  });

  it.each([false, true])("v1 terminal heartbeat preserves review only until settled (settled=%s)", async settled => {
    const w = await world();
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } });
    const id = await seedHeartbeatRun(db, w, { status: "succeeded" });
    await db.update(heartbeatRuns).set({ finalizationVersion: 1, finishedAt: new Date(),
      settledAt: settled ? new Date() : null }).where(eq(heartbeatRuns.id, id));
    expect((await syncStepRunsFromIssueState(db, await rows(w)))[0].status).toBe(settled ? "failed" : "running");
  });

  it("active in_progress is untouched", async () => {
    const w = await world("in_progress");
    await seedHeartbeatRun(db, w, { status: "running" });
    const synced = await syncStepRunsFromIssueState(db, await rows(w));
    expect(synced[0]).toMatchObject({ status: "running", completedAt: null });
    expect((await converge(w, synced, false)).status).toBe("running");
  });

  it.each([false, true])("normal done/completed still completes (boundary=%s)", async boundary => {
    const w = await world("done");
    const synced = await syncStepRunsFromIssueState(db, await rows(w));
    expect(synced[0].status).toBe("completed");
    expect((await converge(w, synced, boundary)).status).toBe("completed");
  });

  for (const boundary of [false, true]) it(`all terminal failed + six skipped settles (boundary=${boundary})`, async () => {
    const w = await world("blocked");
    await db.update(workflowStepRuns).set({ status: "failed", issueId: null, completedAt: new Date() })
      .where(eq(workflowStepRuns.id, w.stepRunId));
    await db.insert(workflowStepRuns).values(Array.from({ length: 6 }, (_, i) => ({
      workflowRunId: w.runId, stepId: `skip-${i}`, status: "skipped", completedAt: new Date(),
    })));
    // Exercise the actual reset-before-finalization path, including rows without skip sentinels.
    const before = await rows(w);
    const maintained = await resetUnlaunchedTerminalStepRuns(db, before);
    expect(maintained.map(s => s.status)).toEqual(before.map(s => s.status));
    expect(await converge(w, maintained, boundary)).toMatchObject({ status: "failed", completedAt: expect.any(Date) });
    expect((await rows(w)).every(s => ["completed", "failed", "skipped", "cancelled"].includes(s.status))).toBe(true);
  });

  it.each([false, true])("terminal cancelled projection converges (boundary=%s)", async boundary => {
    const w = await world();
    // The current DB CHECK excludes cancelled steps; exercise the reader contract without invalid DDL/data.
    await db.update(workflowStepRuns).set({ status: "skipped", issueId: null }).where(eq(workflowStepRuns.id, w.stepRunId));
    const projected = (await rows(w)).map(s => ({ ...s, status: "cancelled" }));
    expect(await resetUnlaunchedTerminalStepRuns(db, projected)).toEqual(projected);
    expect((await converge(w, projected, boundary)).status).toBe("cancelled");
  });

  it("cancelled issue retains the canonical failed-step mapping", async () => {
    const w = await world("cancelled");
    const synced = await syncStepRunsFromIssueState(db, await rows(w));
    expect(synced[0].status).toBe("failed");
    expect((await converge(w, synced, false)).status).toBe("failed");
  });

  it("full sync settles a failed step and six unlaunched skips without reopening them", async () => {
    const w = await world("blocked");
    const steps = Array.from({ length: 7 }, (_, i) => ({ id: i ? `skip-${i}` : "step-a",
      name: `Step ${i}`, type: "agent", agentId: w.agentId, dependencies: i ? ["step-a"] : [] }));
    await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, w.workflowId));
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowStepRuns.id, w.stepRunId));
    await db.insert(workflowStepRuns).values(steps.slice(1).map(s => ({ workflowRunId: w.runId,
      stepId: s.id, status: "skipped", completedAt: new Date() })));
    for (let i = 0; i < 2; i++) {
      expect((await syncWorkflowRunState(db, w.runId)).status).toBe("failed");
      expect((await rows(w)).filter(s => s.status === "skipped")).toHaveLength(6);
    }
  });

  it("a failed step with a running sibling does not finalize the parent", async () => {
    const w = await world("blocked");
    await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, w.stepRunId));
    await db.insert(workflowStepRuns).values({ workflowRunId: w.runId, stepId: "active", status: "running" });
    expect((await converge(w, await rows(w), false)).status).toBe("running");
  });

  it("completed prerequisites still recover never-launched legacy failure placeholders", async () => {
    const w = await world("done");
    await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, w.stepRunId));
    await db.insert(workflowStepRuns).values({ workflowRunId: w.runId, stepId: "legacy", status: "failed" });
    const maintained = await resetUnlaunchedTerminalStepRuns(db, await rows(w));
    expect(maintained.find(s => s.stepId === "legacy")?.status).toBe("pending");
    expect((await converge(w, maintained, false)).status).toBe("running");
  });
});

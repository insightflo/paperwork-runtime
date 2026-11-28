import { createDb, heartbeatRuns, issues, workflowRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { anchors, sourceRun, unblockWorld, type UnblockWorld } from "./helpers/unblock-nesting-fixture.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { createRunMainExecutorSupervision } from "../services/missions/supervision-main.js";
import { qualityService } from "../services/quality.js";
import { createMissionWorkSettlement } from "../services/missions/mission-work-settlement.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

describe("supervision skips ineligible unblock sources without producer conflicts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s41-supervision-unblock-"); db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });
  async function supervise(w: UnblockWorld) {
    await db.insert(issues).values({ companyId: w.companyId, missionId: w.missionId,
      title: "Oversight", originKind: "mission_main_executor_oversight", assigneeAgentId: w.agentId, status: "todo" })
      .onConflictDoNothing();
    const ownerActions = createOwnerActions({ db, deps: {} });
    const ensure = vi.spyOn(ownerActions, "ensureMainExecutorUnblockIssue");
    const run = createRunMainExecutorSupervision({ db, deps: {}, ownerActions, qSvc: qualityService(db),
      settleResolvedOwnerActionsAndFindOpenWork: createMissionWorkSettlement(db) });
    for (let tick = 0; tick < 2; tick++) {
      await run({ missionId: w.missionId, staleAfterMinutes: 1, now: new Date("2027-01-01T00:00:00Z") });
    }
    return ensure;
  }
  it.each(["blocked", "todo", "in_progress"])("skips manual [Unblock]/[PLAN] and control origins when %s", async (status) => {
    const w = await unblockWorld(db, { title: " [uNbLoCk] QA source", status });
    for (const [originKind, title] of [["manual", " [PLAN] QA source"], ["mission_main_executor_plan", "QA source"],
      ["mission_main_executor_oversight", "QA oversight"], ["mission_main_executor_unblock", "QA anchor"]]) {
      await db.insert(issues).values({ companyId: w.companyId, missionId: w.missionId, originKind, title, status,
        assigneeAgentId: w.agentId, createdAt: new Date("2026-11-01T00:00:00Z") });
    }
    const ensure = await supervise(w);
    expect(ensure).not.toHaveBeenCalled(); expect(await anchors(db, w)).toHaveLength(0);
  });
  it.each(["completed", "cancelled", "superseded"])("skips blocked and stale issues from %s runs", async (kind) => {
    const w = await unblockWorld(db), run = await sourceRun(db, w, kind === "superseded" ? "failed" : kind);
    for (const status of ["todo", "in_progress"]) {
      const [source] = await db.insert(issues).values({ companyId: w.companyId, missionId: w.missionId,
        title: "QA stale source", originKind: "manual", originRunId: run.id, status, assigneeAgentId: w.agentId,
        createdAt: new Date("2026-11-01T00:00:00Z") }).returning();
      await db.insert(heartbeatRuns).values({ companyId: w.companyId, agentId: w.agentId, issueId: source!.id,
        status: "failed", settledAt: new Date(), errorCode: "adapter_failed" });
    }
    if (kind === "superseded") await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
      workflowId: w.definition.id, status: "running", triggeredBy: "test", createdAt: new Date(run.createdAt.getTime() + 1) });
    const ensure = await supervise(w);
    expect(ensure).not.toHaveBeenCalled(); expect(await anchors(db, w)).toHaveLength(0);
  });
  it("still creates an anchor for a blocked source on the latest failed run", async () => {
    const w = await unblockWorld(db); await sourceRun(db, w, "failed");
    const ensure = await supervise(w);
    expect(ensure).toHaveBeenCalled(); expect(await anchors(db, w)).toHaveLength(1);
  });
});

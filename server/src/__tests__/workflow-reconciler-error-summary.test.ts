// [purpose] workflow_reconciler 정산(running/queued step_run → failed) 시 lastDispatchErrorSummary 가
//   비어 있으면 진단 요약을 채운다. (1) 링크 이슈가 done + step metadata.graphWorkProductRequired=true
//   + 활성 워크프로덕트 0개면 "issue_done_without_required_work_product", (2) 그 외 "step_settled_failed",
//   (3) 기존 비어 있지 않은 요약은 절대 덮어쓰지 않는다. 접두사는 실제 정산 source 를 따른다.
//   기존 테스트 파일은 수정하지 않는다.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { settleRunningStepRunsForTerminalRun } from "../services/workflow/workflow-sync-source.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping workflow-reconciler-error-summary tests: ${support.reason ?? "unsupported host"}`);
}

describeEP("workflow_reconciler settlement error summary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("reconciler-error-summary-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // issue_work_products 는 issues.onDelete cascade 로 정리되지만 명시 삭제로 순서를 고정한다.
    await db.delete(issueWorkProducts);
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const stepOf = async (runId: string) =>
    await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows[0]);

  const settleReconciler = (world: BoundaryWorld) =>
    settleRunningStepRunsForTerminalRun(db, {
      companyId: world.companyId,
      runId: world.runId,
      missionId: world.missionId,
      decision: "failed",
      now: new Date(),
      discovery: "stuck_diagnostic",
    });

  it("issue done + graphWorkProductRequired + 0 active work products → issue_done_without_required_work_product", async () => {
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: { graphWorkProductRequired: true },
      stepIssueStatus: "done",
    });

    const settled = await settleReconciler(world);

    expect(settled).toBe(1);
    const step = await stepOf(world.runId);
    expect(step?.status).toBe("failed");
    expect(step?.metadata).toHaveProperty("terminalRunSettlement");
    expect(step?.lastDispatchErrorSummary).toBe(
      "workflow_reconciler: issue_done_without_required_work_product",
    );
  });

  it("without the required-work-product condition → generic step_settled_failed", async () => {
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: {},
      stepIssueStatus: "in_progress",
    });

    await settleReconciler(world);

    const step = await stepOf(world.runId);
    expect(step?.lastDispatchErrorSummary).toBe("workflow_reconciler: step_settled_failed");
  });

  it("issue done + flag true + registered active work product → generic step_settled_failed", async () => {
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: { graphWorkProductRequired: true },
      stepIssueStatus: "done",
    });
    await db.insert(issueWorkProducts).values({
      companyId: world.companyId,
      issueId: world.stepIssueId,
      type: "artifact",
      provider: "paperclip",
      title: "registered deliverable",
      status: "active",
    });

    await settleReconciler(world);

    const step = await stepOf(world.runId);
    expect(step?.lastDispatchErrorSummary).toBe("workflow_reconciler: step_settled_failed");
  });

  it("never overwrites an existing non-empty lastDispatchErrorSummary", async () => {
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: { graphWorkProductRequired: true },
      stepIssueStatus: "done",
    });
    await db.update(workflowStepRuns)
      .set({ lastDispatchErrorSummary: "adapter crashed: 429" })
      .where(eq(workflowStepRuns.id, world.stepRunId));

    await settleReconciler(world);

    const step = await stepOf(world.runId);
    expect(step?.lastDispatchErrorSummary).toBe("adapter crashed: 429");
  });

  it("deadlock settlement keeps the real source prefix", async () => {
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: { graphWorkProductRequired: true },
      stepIssueStatus: "done",
    });

    await settleRunningStepRunsForTerminalRun(db, {
      companyId: world.companyId,
      runId: world.runId,
      missionId: world.missionId,
      decision: "failed",
      now: new Date(),
      discovery: "deadlock_detection",
    });

    const step = await stepOf(world.runId);
    expect(step?.lastDispatchErrorSummary).toBe(
      "workflow_deadlock_reconciler: issue_done_without_required_work_product",
    );
  });
});

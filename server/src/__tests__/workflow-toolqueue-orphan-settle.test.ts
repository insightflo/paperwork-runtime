// [purpose] fc0194ed 회귀 — terminal run 정산과 정기 reconciler 가 terminal tool step 의
//   orphaned toolQueue queued/claimed 잔여를 settled 로 치유하는지 검증한다. live running step 은
//   절대 바꾸지 않는다.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { settleRunningStepRunsForTerminalRun } from "../services/workflow/workflow-sync-source.js";
import { reconcileWorkflow } from "../services/workflow/reconciler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping workflow-toolqueue-orphan-settle tests: ${support.reason ?? "unsupported host"}`);
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describeEP("workflow toolQueue orphan settlement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("toolqueue-orphan-settle-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("terminal run settlement settles a claimed toolQueue in the same failed-step transition", async () => {
    const queuedAt = "2026-11-28T08:00:00.000Z";
    const claimedAt = "2026-11-28T08:00:05.000Z";
    const world = await seedBoundaryWorld(db, {
      runStatus: "failed",
      stepRunMetadata: {
        toolQueue: {
          status: "claimed",
          queuedAt,
          claimedAt,
          heartbeatRunId: "hb-orphaned",
        },
        toolInvocation: { requestId: "req-orphaned", toolName: "execute_tool", args: {} },
      },
    });
    const now = new Date("2026-11-28T08:05:00.000Z");

    const settled = await settleRunningStepRunsForTerminalRun(db, {
      companyId: world.companyId,
      runId: world.runId,
      missionId: world.missionId,
      decision: "failed",
      now,
      discovery: "stuck_diagnostic",
    });

    expect(settled).toBe(1);
    const [step] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, world.stepRunId));
    expect(step?.status).toBe("failed");
    expect(step?.completedAt?.toISOString()).toBe(now.toISOString());
    const metadata = metadataRecord(step?.metadata);
    expect(metadata.terminalRunSettlement).toMatchObject({
      decision: "failed",
      source: "workflow_reconciler",
      settledAt: now.toISOString(),
    });
    expect(metadata.toolQueue).toMatchObject({
      status: "settled",
      queuedAt,
      claimedAt,
      heartbeatRunId: "hb-orphaned",
      settledAt: now.toISOString(),
    });
    expect(Date.parse(metadataRecord(metadata.toolQueue).settledAt as string))
      .toBe(step?.completedAt?.getTime());
  });

  it("reconcileWorkflow heals terminal orphaned claims and leaves live running claims untouched", async () => {
    const now = Date.now();
    const completedAt = new Date(now - 10 * 60_000);
    const world = await seedBoundaryWorld(db, { runStatus: "failed" });
    await db.update(workflowStepRuns)
      .set({
        status: "failed",
        completedAt,
        metadata: {
          terminalRunSettlement: {
            decision: "failed",
            source: "workflow_reconciler",
            settledAt: completedAt.toISOString(),
          },
          toolQueue: {
            status: "claimed",
            queuedAt: new Date(now - 20 * 60_000).toISOString(),
            claimedAt: new Date(now - 19 * 60_000).toISOString(),
          },
        },
      })
      .where(eq(workflowStepRuns.id, world.stepRunId));
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: world.runId,
        stepId: "step-live",
        status: "running",
        metadata: {
          toolQueue: {
            status: "claimed",
            queuedAt: new Date(now - 20 * 60_000).toISOString(),
            claimedAt: new Date(now - 19 * 60_000).toISOString(),
          },
        },
      },
      {
        workflowRunId: world.runId,
        stepId: "step-recent-terminal",
        status: "failed",
        completedAt: new Date(now),
        metadata: {
          toolQueue: {
            status: "claimed",
            queuedAt: new Date(now - 20 * 60_000).toISOString(),
            claimedAt: new Date(now - 19 * 60_000).toISOString(),
          },
        },
      },
    ]);

    const result = await reconcileWorkflow(db, { timeoutMinutes: 60 });

    expect(result.terminalToolQueueClaimsSettled).toBe(1);
    const rows = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, world.runId));
    const orphaned = rows.find((row) => row.id === world.stepRunId);
    const live = rows.find((row) => row.stepId === "step-live");
    const recentTerminal = rows.find((row) => row.stepId === "step-recent-terminal");
    const orphanedQueue = metadataRecord(metadataRecord(orphaned?.metadata).toolQueue);
    expect(orphaned?.status).toBe("failed");
    expect(orphanedQueue.status).toBe("settled");
    expect(orphanedQueue.settledAt).toBe(completedAt.toISOString());
    expect(Date.parse(orphanedQueue.settledAt as string)).toBe(orphaned?.completedAt?.getTime());
    expect(metadataRecord(metadataRecord(live?.metadata).toolQueue)).toMatchObject({
      status: "claimed",
    });
    expect(metadataRecord(metadataRecord(live?.metadata).toolQueue).settledAt).toBeUndefined();
    expect(live?.status).toBe("running");
    expect(metadataRecord(metadataRecord(recentTerminal?.metadata).toolQueue).status).toBe("claimed");
  });
});

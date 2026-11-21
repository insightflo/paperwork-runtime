import { randomUUID } from "node:crypto";
import { createDb, agents, agentWakeupRequests, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ execute: vi.fn(async () => ({})) })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported)
  console.warn(
    `Skipping issue self-block tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );

type Db = ReturnType<typeof createDb>;

async function seedTwoLinkedRuns(db: Db) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const selfRunId = randomUUID();
  const otherRunId = randomUUID();
  const selfWakeId = randomUUID();
  const otherWakeId = randomUUID();
  const prefix = `SB${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  const now = new Date();

  await db.insert(companies).values({
    id: companyId,
    name: "Self block guard",
    issuePrefix: prefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Oversight",
    role: "engineer",
    status: "running",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    identifier: `${prefix}-1`,
    title: "Issue reported blocked",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
    issueNumber: 1,
  });
  for (const [runId, wakeId] of [[selfRunId, selfWakeId], [otherRunId, otherWakeId]] as const) {
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: wakeId,
      contextSnapshot: { issueId },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.update(issues)
    .set({ checkoutRunId: selfRunId, executionRunId: selfRunId })
    .where(eq(issues.id, issueId));
  return { companyId, agentId, issueId, selfRunId, otherRunId, selfWakeId, otherWakeId };
}

async function getRun(db: Db, runId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function getWake(db: Db, wakeId: string) {
  return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0] ?? null);
}

describeEmbeddedPostgres("issue self-block no self-cancel", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-self-block-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("skips the excluded run while still cancelling other linked runs on blocked", async () => {
    const fixture = await seedTwoLinkedRuns(db);
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId: fixture.issueId,
      companyId: fixture.companyId,
      status: "blocked",
      linkedRunIds: [fixture.selfRunId],
      excludeRunId: fixture.selfRunId,
    });

    expect(result.finalized).toBe(1);
    expect(result.runIds).toEqual([fixture.otherRunId]);

    const selfRun = await getRun(db, fixture.selfRunId);
    expect(selfRun).toMatchObject({ status: "running", errorCode: null, finishedAt: null });
    const otherRun = await getRun(db, fixture.otherRunId);
    expect(otherRun).toMatchObject({
      status: "cancelled",
      errorCode: "issue_status_blocked",
      finishedAt: expect.any(Date),
    });

    const selfWake = await getWake(db, fixture.selfWakeId);
    expect(selfWake?.status).toBe("claimed");
    const otherWake = await getWake(db, fixture.otherWakeId);
    expect(otherWake).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
  });

  it("still cancels every active linked run on blocked when excludeRunId is omitted", async () => {
    const fixture = await seedTwoLinkedRuns(db);
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId: fixture.issueId,
      companyId: fixture.companyId,
      status: "blocked",
      linkedRunIds: [fixture.selfRunId],
    });

    expect(result.finalized).toBe(2);
    expect(result.runIds.sort()).toEqual([fixture.otherRunId, fixture.selfRunId].sort());
    for (const runId of [fixture.selfRunId, fixture.otherRunId]) {
      const run = await getRun(db, runId);
      expect(run).toMatchObject({
        status: "cancelled",
        errorCode: "issue_status_blocked",
        finishedAt: expect.any(Date),
      });
    }
  });
});

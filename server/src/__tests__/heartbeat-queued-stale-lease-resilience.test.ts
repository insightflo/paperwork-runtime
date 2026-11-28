import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, heartbeatRuns } from "@paperclipai/db";
import {
  createHeartbeatQueuedStaleRecovery,
  FRESH_PROMOTION_HANDOFF_GRACE_MS,
  latestQueueActivityMs,
} from "../services/heartbeat-queued-stale-recovery.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

const THRESHOLD_MS = 60_000;
const staleAt = () => new Date(Date.now() - THRESHOLD_MS * 2);

let db!: Db;
let opened!: Awaited<ReturnType<typeof terminalDatabase>>;

beforeAll(async () => {
  opened = await terminalDatabase();
  db = opened.db;
}, 60_000);

afterEach(async () => {
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(agents);
  await db.delete(companies);
});

afterAll(async () => {
  await opened?.close();
});

async function seedAgent(maxConcurrentRuns = 1) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Queue lease resilience",
    issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Lease runner",
    role: "engineer",
    status: "active",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { maxConcurrentRuns } },
    permissions: {},
  });
  return { companyId, agentId };
}

async function insertQueuedRun(companyId: string, agentId: string, queuedAt: Date) {
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "queued",
    contextSnapshot: {},
    startedAt: null,
    processPid: null,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  return runId;
}

async function insertRunningRun(companyId: string, agentId: string, input: { createdAt: Date; startedAt: Date }) {
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "manual",
    payload: {},
    status: "claimed",
    runId,
    claimedAt: input.startedAt,
    createdAt: input.createdAt,
    updatedAt: input.startedAt,
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    wakeupRequestId,
    contextSnapshot: {},
    startedAt: input.startedAt,
    createdAt: input.createdAt,
    updatedAt: input.startedAt,
  });
  return { runId, wakeupRequestId };
}

async function insertOrphanWake(companyId: string, agentId: string, queuedAt: Date) {
  const wakeupRequestId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "manual",
    payload: {},
    status: "queued",
    runId: null,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  return wakeupRequestId;
}

function makeRecovery(overrides?: {
  liveRunIds?: ReadonlySet<string>;
  startNextQueuedRunForAgent?: (agentId: string) => Promise<unknown>;
}) {
  return createHeartbeatQueuedStaleRecovery({
    db,
    activeExecutionTimeoutMs: 0,
    withAgentStartLock: (_agentId, fn) => fn(),
    startNextQueuedRunForAgent: async (agentId) => overrides?.startNextQueuedRunForAgent?.(agentId) ?? [],
    countActiveRunsForAgent: async (agentId) => (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))).length,
    maxConcurrentRuns: (agent) => {
      const config = agent.runtimeConfig as Record<string, unknown>;
      return Number((config.heartbeat as Record<string, unknown> | undefined)?.maxConcurrentRuns ?? 1);
    },
    hasActiveExecution: () => false,
    hasLiveTrackedChild: (runId) => overrides?.liveRunIds?.has(runId) ?? false,
    resolveActiveExecutionTimeoutMs: async () => 0,
    setRunStatus: async (conn, runId, status, patch, opts) => await conn.update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, opts.expectedStatuses)))
      .returning().then((rows) => rows[0] ?? null),
    publishRunStatus: () => {},
    nextRunEventSeq: async () => 1,
    appendRunEvent: async () => {},
    releaseIssueExecutionAndPromote: async () => ({}),
    getRun: (runId) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
    settleHeartbeatAfterExecution: async () => ({}),
    finalizeAgentStatus: async () => ({}),
    recordQueueTransitionEvent: async () => ({}),
  });
}

async function runRow(runId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function wakeRow(wakeupRequestId: string) {
  return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)).then((rows) => rows[0] ?? null);
}

describe("heartbeat queued-stale lease resilience", () => {
  it("uses the newer updatedAt timestamp as the queue lease activity", () => {
    const createdAt = new Date(Date.now() - 120_000);
    const updatedAt = new Date(Date.now() - 5_000);
    expect(latestQueueActivityMs(createdAt, updatedAt)).toBe(updatedAt.getTime());
    expect(latestQueueActivityMs(updatedAt, createdAt)).toBe(updatedAt.getTime());
    expect(latestQueueActivityMs(null, null)).toBeNull();
  });

  it("preserves a stale queued run untouched while live capacity is full", async () => {
    const { companyId, agentId } = await seedAgent(1);
    const oldAt = staleAt();
    const active = await insertRunningRun(companyId, agentId, { createdAt: oldAt, startedAt: oldAt });
    const queuedRunId = await insertQueuedRun(companyId, agentId, oldAt);

    const result = await makeRecovery({ liveRunIds: new Set([active.runId]) }).recover(THRESHOLD_MS);

    expect(result.reapedRunIds).toEqual([]);
    const queued = await runRow(queuedRunId);
    expect(queued).toMatchObject({ status: "queued", errorCode: null, finishedAt: null });
  });

  it("counts a freshly promoted running row during handoff before its child PID is tracked", async () => {
    const { companyId, agentId } = await seedAgent(1);
    const oldAt = staleAt();
    await insertRunningRun(companyId, agentId, {
      createdAt: oldAt,
      startedAt: new Date(Date.now() - Math.floor(FRESH_PROMOTION_HANDOFF_GRACE_MS / 2)),
    });
    const queuedRunId = await insertQueuedRun(companyId, agentId, oldAt);

    const result = await makeRecovery().recover(THRESHOLD_MS);

    expect(result.reapedRunIds).toEqual([]);
    const queued = await runRow(queuedRunId);
    expect(queued).toMatchObject({ status: "queued", errorCode: null, finishedAt: null });
  });

  it("preserves a stale orphan wakeup untouched while live capacity is full", async () => {
    const { companyId, agentId } = await seedAgent(1);
    const oldAt = staleAt();
    const active = await insertRunningRun(companyId, agentId, { createdAt: oldAt, startedAt: oldAt });
    const wakeupRequestId = await insertOrphanWake(companyId, agentId, oldAt);

    const result = await makeRecovery({ liveRunIds: new Set([active.runId]) }).recover(THRESHOLD_MS);

    expect(result.reapedRunIds).toEqual([]);
    const wake = await wakeRow(wakeupRequestId);
    expect(wake).toMatchObject({ status: "queued", runId: null, finishedAt: null, error: null });
  });

  it("still fails a stale queued run when capacity is empty and promotion cannot start it", async () => {
    const { companyId, agentId } = await seedAgent(1);
    const queuedRunId = await insertQueuedRun(companyId, agentId, staleAt());

    const result = await makeRecovery().recover(THRESHOLD_MS);

    expect(result.reapedRunIds).toEqual([queuedRunId]);
    expect(await runRow(queuedRunId)).toMatchObject({ status: "failed", errorCode: "stale_queued" });
  });
});

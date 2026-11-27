// [queued-stale promote-first 경계] 오래된 queued run 을 failed/stale_queued 로 전환하기 전에
// capacity 가 비어 있으면 promoter 승격을 먼저 시도하고, 승격이 시작으로 이어지지 않은 이유를
// 구조화 메타데이터(queue transition event + run event payload)로 남기는 경계를 검증한다.
// 실행 권한은 promoter 의 실제 DB 전이가 가진다 — 이벤트 payload 는 관측용이다.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns } from "@paperclipai/db";
import { createHeartbeatQueuedStaleRecovery } from "../services/heartbeat-queued-stale-recovery.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db!: Db;
let opened!: Awaited<ReturnType<typeof terminalDatabase>>;

beforeAll(async () => {
  opened = await terminalDatabase();
  db = opened.db;
}, 60_000);

afterAll(async () => {
  await opened?.close();
});

type QueueEventInput = Parameters<
  Parameters<typeof createHeartbeatQueuedStaleRecovery>[0]["recordQueueTransitionEvent"]
>[0];

type Effects = {
  promoterCalls: number;
  releases: number;
  queueEvents: QueueEventInput[];
  runEventPayloads: Array<Record<string, unknown>>;
};

async function seedStaleQueuedRun(input?: { maxConcurrentRuns?: number; agentStatus?: string }) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const staleAt = new Date(Date.now() - 60_000);
  await db.insert(companies).values({
    id: companyId,
    name: "Stale promotion boundary",
    issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Stale runner",
    role: "engineer",
    status: input?.agentStatus ?? "active",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: input?.maxConcurrentRuns === undefined
      ? {}
      : { heartbeat: { maxConcurrentRuns: input.maxConcurrentRuns } },
    permissions: {},
  });
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
    createdAt: staleAt,
    updatedAt: staleAt,
  });
  return { companyId, agentId, runId };
}

function makeRecovery(overrides?: {
  startNextQueuedRunForAgent?: (agentId: string) => Promise<unknown>;
}) {
  const effects: Effects = { promoterCalls: 0, releases: 0, queueEvents: [], runEventPayloads: [] };
  const recovery = createHeartbeatQueuedStaleRecovery({
    db,
    activeExecutionTimeoutMs: 0,
    withAgentStartLock: (_agentId, fn) => fn(),
    startNextQueuedRunForAgent: async (agentId: string) => {
      effects.promoterCalls += 1;
      return overrides?.startNextQueuedRunForAgent?.(agentId);
    },
    countActiveRunsForAgent: async (agentId: string) => (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))).length,
    maxConcurrentRuns: (agent) => {
      const config = agent.runtimeConfig as Record<string, unknown>;
      return Number((config.heartbeat as Record<string, unknown> | undefined)?.maxConcurrentRuns ?? 1);
    },
    hasActiveExecution: () => false,
    hasLiveTrackedChild: () => false,
    resolveActiveExecutionTimeoutMs: async () => 0,
    // setRunStatus 는 반드시 전달받은 conn(tx)으로 써야 한다. PGlite 는 단일 커넥션이라
    // tx 가 열려 있는 동안 외부 db 로 쿼리하면 큐 대기 → 콜백 대기 순환으로 데드락이 난다.
    setRunStatus: async (conn, runId, status, patch, opts) => await conn.update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, opts.expectedStatuses)))
      .returning().then((rows) => rows[0] ?? null),
    publishRunStatus: () => {},
    nextRunEventSeq: async () => 1,
    appendRunEvent: async (_run, _seq, event) => {
      effects.runEventPayloads.push(event.payload ?? {});
    },
    releaseIssueExecutionAndPromote: async () => {
      effects.releases += 1;
    },
    getRun: (runId) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
    settleHeartbeatAfterExecution: async () => ({}),
    finalizeAgentStatus: async () => ({}),
    recordQueueTransitionEvent: async (input) => {
      effects.queueEvents.push(input);
      return input;
    },
  });
  return { recovery, effects };
}

async function runRow(runId: string) {
  return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0] ?? null;
}

describe("heartbeat queued-stale recovery promote-first boundary", () => {
  it("starts the stale queued run through promote-first instead of failing it", async () => {
    const seeded = await seedStaleQueuedRun();
    const { recovery, effects } = makeRecovery({
      // promoter 가 실제로 run 을 시작하는 시나리오(좀비 회수 직후 빈 슬롯).
      startNextQueuedRunForAgent: async () => {
        await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, seeded.runId));
      },
    });
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual([]);
    expect(await runRow(seeded.runId)).toMatchObject({ status: "running", errorCode: null, finishedAt: null });
    expect(effects.queueEvents).toHaveLength(0);
    expect(effects.releases).toBe(0);
  });

  it("fails with structured promote-first metadata when the promoter cannot start the run", async () => {
    const seeded = await seedStaleQueuedRun();
    const { recovery, effects } = makeRecovery();
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual([seeded.runId]);
    expect(await runRow(seeded.runId)).toMatchObject({ status: "failed", errorCode: "stale_queued" });
    expect(effects.queueEvents).toHaveLength(1);
    expect(effects.queueEvents[0]).toMatchObject({
      companyId: seeded.companyId,
      heartbeatRunId: seeded.runId,
      eventType: "run_stale_queued",
      layer: "heartbeat",
      decision: "failed",
      reasonCode: "stale_queued",
      idempotencyKey: `run-stale-queued:${seeded.runId}`,
    });
    expect(effects.queueEvents[0]?.payload).toMatchObject({ promoteFirst: { outcome: "promoted_not_started" } });
    expect(effects.runEventPayloads[0]).toMatchObject({ promoteFirst: "promoted_not_started" });
  });

  it("skips promote-first without capacity and records the skip reason", async () => {
    const seeded = await seedStaleQueuedRun();
    // running run 이 슬롯을 점유(countActiveRunsForAgent=1, maxConcurrentRuns=1 → slots=0).
    // 단, 살아있는 자식이 없어 capacityIsPositivelyFull 은 false → 실패 전환은 계속된다.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    const { recovery, effects } = makeRecovery();
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual([seeded.runId]);
    expect(await runRow(seeded.runId)).toMatchObject({ status: "failed", errorCode: "stale_queued" });
    expect(effects.queueEvents[0]?.payload).toMatchObject({ promoteFirst: { outcome: "skipped_no_capacity" } });
  });

  it("records skipped_agent_unavailable without attempting promotion for a paused agent", async () => {
    const seeded = await seedStaleQueuedRun({ agentStatus: "paused" });
    const { recovery, effects } = makeRecovery();
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual([seeded.runId]);
    expect(effects.queueEvents[0]?.payload).toMatchObject({ promoteFirst: { outcome: "skipped_agent_unavailable" } });
  });

  it("is bounded: one promote-first attempt per agent per sweep", async () => {
    const first = await seedStaleQueuedRun();
    const second = await seedStaleQueuedRun();
    expect(second.agentId).not.toBe(first.agentId);
    // 같은 에이전트에 두 번째 stale run 추가(첫 run 의 agent 재사용).
    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId: first.companyId,
      agentId: first.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
      startedAt: null,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    });
    const { recovery, effects } = makeRecovery();
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual(expect.arrayContaining([first.runId, second.runId, secondRunId]));
    const outcomes = effects.queueEvents
      .map((event) => (event.payload as { promoteFirst: { outcome: string } }).promoteFirst.outcome)
      .sort();
    // 같은 agent 의 두 run 중 하나만 promote-first 시도 → 나머지는 bounded_already_attempted.
    // 다른 agent(second)의 run은 별도 시도 기회를 가진다.
    expect(outcomes).toEqual(["bounded_already_attempted", "promoted_not_started", "promoted_not_started"]);
  });

  it("records promotion_error and still fails the run when the promoter throws", async () => {
    const seeded = await seedStaleQueuedRun();
    const { recovery, effects } = makeRecovery({
      startNextQueuedRunForAgent: async () => {
        throw new Error("promoter boom");
      },
    });
    const result = await recovery.recover(1_000);
    expect(result.reapedRunIds).toEqual([seeded.runId]);
    expect(await runRow(seeded.runId)).toMatchObject({ status: "failed", errorCode: "stale_queued" });
    expect(effects.queueEvents[0]?.payload).toMatchObject({
      promoteFirst: { outcome: "promotion_error", promoterError: "promoter boom" },
    });
  });
});

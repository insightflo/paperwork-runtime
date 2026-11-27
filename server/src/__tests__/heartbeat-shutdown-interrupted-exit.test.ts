// [shutdown-interrupted exit] 서버 종료 비행 중 종료 신호(exit 130/143)로 끝난 자식의 완료 경로 분류 계약.
// (a) 술어 경계 (b) 평상시 런타임 exit 130 → 기존 동작 유지(commandcode_missing_result + 에이전트 error)
// (c) 종료 비행 중 exit 130 → failed+shutdown_interrupted + 정확히 1회 process_lost_retry 후계,
//     에이전트 error 마킹·이슈 차단 없음.
// (d) 종료 비행 중 exit 143 → 동일 계약.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import type { RuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const state = vi.hoisted(() => ({
  lifecycle: null as RuntimeExecutionLifecycle | null,
  execute: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: state.execute }),
  runningProcesses: new Map(),
}));

vi.mock("../services/runtime-execution-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/runtime-execution-lifecycle.js")>();
  return {
    ...actual,
    runtimeExecutionLifecycle: {
      createScope: (...args: Parameters<RuntimeExecutionLifecycle["createScope"]>) =>
        state.lifecycle!.createScope(...args),
      beginShutdown: (...args: Parameters<RuntimeExecutionLifecycle["beginShutdown"]>) =>
        state.lifecycle!.beginShutdown(...args),
      shutdownState: () => state.lifecycle!.shutdownState(),
    },
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import {
  isShutdownSignalExit,
  resolveShutdownInterruptedFlushDeadlineMs,
} from "../services/shutdown-flush.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function interruptedExitResult(exitCode: number, signal: string | null) {
  return {
    exitCode,
    signal,
    timedOut: false,
    errorCode: "commandcode_missing_result",
    errorMessage: `Command Code exited (code ${exitCode}) without a final result line; treating the run as failed.`,
    usage: null,
    provider: "commandcode_local",
    model: "test",
    resultJson: null,
    runtimeServices: [],
  };
}

async function seedAgentAndIssue(db: Db) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const now = new Date();
  await db.insert(companies).values({
    id: companyId,
    name: "Code130Co",
    issuePrefix: `${issuePrefix}${Math.floor(Math.random() * 10000)}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "ExitRunner",
    role: "engineer",
    status: "active",
    adapterType: "commandcode_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Survive code 130",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
    lastOperatorInstructionAt: now,
    lastOperatorInstructionCommentId: randomUUID(),
  });
  return { companyId, agentId, issueId };
}

describe("shutdown-flush predicates", () => {
  it("(a) isShutdownSignalExit — 신호 필드와 shell 변환 exit 130/143 만 인정", () => {
    expect(isShutdownSignalExit(130, null)).toBe(true);
    expect(isShutdownSignalExit(143, null)).toBe(true);
    expect(isShutdownSignalExit(null, "SIGINT")).toBe(true);
    expect(isShutdownSignalExit(null, "SIGTERM")).toBe(true);
    expect(isShutdownSignalExit(7, "SIGTERM")).toBe(true);
    expect(isShutdownSignalExit(0, null)).toBe(false);
    expect(isShutdownSignalExit(1, null)).toBe(false);
    expect(isShutdownSignalExit(8, null)).toBe(false);
    expect(isShutdownSignalExit(137, null)).toBe(false);
    expect(isShutdownSignalExit(null, "SIGKILL")).toBe(false);
    expect(isShutdownSignalExit(null, null)).toBe(false);
  });

  it("(a) resolveShutdownInterruptedFlushDeadlineMs — config.shutdownFlushTimeoutMs 와 동일 clamp", () => {
    const prev = process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS;
    try {
      delete process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS;
      expect(resolveShutdownInterruptedFlushDeadlineMs()).toBe(3000);
      process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS = "0";
      expect(resolveShutdownInterruptedFlushDeadlineMs()).toBe(0);
      process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS = "999999";
      expect(resolveShutdownInterruptedFlushDeadlineMs()).toBe(60000);
      process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS = "not-a-number";
      expect(resolveShutdownInterruptedFlushDeadlineMs()).toBe(3000);
    } finally {
      if (prev === undefined) delete process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS;
      else process.env.PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS = prev;
    }
  });
});

describeEP("heartbeat shutdown-interrupted exit classification", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-code130-exit-");
    db = createDb(tempDb.connectionString);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: {} }).onConflictDoNothing();
  }, 60_000);

  afterEach(async () => {
    await waitForHeartbeatExecutionsToDrain(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("(b) exit 130 in normal runtime keeps legacy failure classification", { timeout: 30_000 }, async () => {
    state.lifecycle = createRuntimeExecutionLifecycle();
    const seeded = await seedAgentAndIssue(db);
    state.execute.mockReset().mockResolvedValue(interruptedExitResult(130, null));

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(seeded.agentId, "on_demand", { issueId: seeded.issueId }, "manual", {
      actorType: "system",
      actorId: "test",
    });
    expect(run).toBeTruthy();
    await waitForHeartbeatExecutionsToDrain(db);

    const updated = await heartbeat.getRun(run!.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("commandcode_missing_result");
    const agent = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((r) => r[0]);
    expect(agent?.status).toBe("error");
  });

  it.each([
    { label: "(c)", exitCode: 130, signal: "SIGINT" as const },
    { label: "(d)", exitCode: 143, signal: "SIGTERM" as const },
  ])("$label exit $exitCode during server shutdown is recorded shutdown_interrupted with exactly-once retry", { timeout: 30_000 }, async ({ exitCode, signal }) => {
    state.lifecycle = createRuntimeExecutionLifecycle();
    const seeded = await seedAgentAndIssue(db);
    let finish!: (value: ReturnType<typeof interruptedExitResult>) => void;
    state.execute.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(seeded.agentId, "on_demand", { issueId: seeded.issueId }, "manual", {
      actorType: "system",
      actorId: "test",
    });
    expect(run).toBeTruthy();
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));

    state.lifecycle.beginShutdown(signal);
    finish(interruptedExitResult(exitCode, signal));
    await waitForHeartbeatExecutionsToDrain(db);

    const updated = await heartbeat.getRun(run!.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("shutdown_interrupted");
    expect(updated?.exitCode).toBe(exitCode);

    const successors = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(successors).toHaveLength(1);
    expect(successors[0]?.status).toBe("queued");
    expect(successors[0]?.contextSnapshot).toMatchObject({
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    });

    const agent = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((r) => r[0]);
    expect(agent?.status).not.toBe("error");

    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((r) => r[0]);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(successors[0]?.id ?? null);
  });
});

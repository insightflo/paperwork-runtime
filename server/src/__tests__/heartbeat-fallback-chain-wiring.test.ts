import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { agents, Db, heartbeatRuns } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { enqueueAdapterFallbackRun, type HeartbeatRetryEnqueueDeps } from "../services/heartbeat-retry-enqueue.js";
import {
  resolveAdapterFallbackAdapterType,
  resolveAdapterFallbackConfig,
  selectNextAdapterFallbackEntry,
} from "../services/heartbeat-adapter-fallback.js";
import { globalUsageLimitGate } from "../services/usage-limit-gate.js";

// enqueueAdapterFallbackRun 의 DB/트랜잭션 의존만 가짜로 대체한다 — 컨텍스트 스냅샷 구성이 검증 대상이다.
const enqueueMocks = vi.hoisted(() => {
  const captured: { insertedRunValues?: Record<string, unknown> } = {};
  const childRunRow = () => ({
    id: "child-run-1", companyId: "company-1", agentId: "agent-1", issueId: null, status: "queued",
    contextSnapshot: captured.insertedRunValues?.contextSnapshot ?? {},
  });
  const fakeTx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          captured.insertedRunValues = values;
          return [childRunRow()];
        },
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => [] }),
    }),
    select: () => ({ from: () => ({ where: async () => [childRunRow()] }) }),
  };
  return { captured, fakeTx };
});

vi.mock("@paperclipai/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTxTimeout: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(enqueueMocks.fakeTx),
}));
vi.mock("../services/heartbeat-retry-context.js", () => ({
  retryContext: async () => ({ missionId: null, workflowRunId: null, stepId: null }),
}));
vi.mock("../services/heartbeat-finalization/producer-identity.js", () => ({
  retryWorkflowIdentity: async () => ({}),
}));
vi.mock("../services/heartbeat-workflow-wake.js", () => ({
  insertWorkflowWakeRequest: async () => [{ id: "wake-1" }],
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/effect-envelope.js", () => ({ resolveNextDispatchGeneration: async () => 7 }));
vi.mock("../services/heartbeat-finalization/authority-transfer.js", () => ({
  maybeTransferHeartbeatAuthorityToChild: async () => undefined,
}));

// instance-settings 라우트가 쓰는 인스턴스 설정 서비스만 대체한다(라우트 검증 대상 아님).
vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ listCompanyIds: async () => [] }),
  logActivity: vi.fn(),
}));

const ADMIN = { type: "board", userId: "admin", source: "local_implicit", isInstanceAdmin: true };
function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

const parentRun = {
  id: "parent-run-1", companyId: "company-1", agentId: "agent-1", issueId: null,
  contextSnapshot: { fallbackAttempt: 1, wakeReason: "adapter_fallback", fallbackOfRunId: "grandparent" },
  processLossRetryCount: 0, retryOfRunId: "grandparent",
} as unknown as typeof heartbeatRuns.$inferSelect;
const parentAgent = { id: "agent-1", name: "Writer" } as unknown as typeof agents.$inferSelect;

describe("GET /instance/settings/usage-limit-gate", () => {
  beforeEach(() => globalUsageLimitGate.clear());

  it("returns the live snapshot of recorded quota limits and provider failures", async () => {
    globalUsageLimitGate.recordQuotaLimit(
      { adapterType: "claude_local", provider: "openai", model: "gpt-x" },
      { resetsAtMs: Date.now() + 60_000, reason: "provider_quota_exhausted" },
    );
    globalUsageLimitGate.recordProviderFailure(
      { adapterType: "codex_local", provider: "anthropic", model: "claude-y" },
      { reason: "provider_overloaded", cooldownMs: 5_000 },
    );
    const res = await request(createApp(ADMIN)).get("/api/instance/settings/usage-limit-gate");
    expect(res.status).toBe(200);
    expect(res.body.limitedModels).toEqual([
      expect.objectContaining({ adapterType: "claude_local", provider: "openai", model: "gpt-x", kind: "limit", reason: "provider_quota_exhausted" }),
    ]);
    expect(res.body.failedModels).toEqual([
      expect.objectContaining({ adapterType: "codex_local", provider: "anthropic", model: "claude-y", kind: "failed", reason: "provider_overloaded" }),
    ]);
  });

  it("reflects recordSuccess clearing immediately", async () => {
    globalUsageLimitGate.recordQuotaLimit({ adapterType: "claude_local", provider: "openai", model: "gpt-x" }, { nowMs: Date.now() });
    globalUsageLimitGate.recordSuccess({ adapterType: "claude_local", provider: "openai", model: "gpt-x" });
    const res = await request(createApp(ADMIN)).get("/api/instance/settings/usage-limit-gate");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ limitedModels: [], failedModels: [] });
  });
});

describe("enqueueAdapterFallbackRun fallback context wiring", () => {
  it("preserves fallbackAdapterType/provider/model/candidateIndex even when fallbackCommand is omitted", async () => {
    const runEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const deps: HeartbeatRetryEnqueueDeps = {
      db: {} as Db,
      resolveSessionBeforeForWakeup: async () => null,
      appendRunEvent: async (_run, _seq, event) => {
        runEvents.push({ eventType: event.eventType, payload: event.payload });
        return {};
      },
    };
    const queued = await enqueueAdapterFallbackRun(deps, parentRun, parentAgent, new Date(), {
      fallbackAdapterType: "codex_local",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-fallback-model",
      fallbackCandidateIndex: 1,
      fallbackReason: "run_failed",
    });
    const snapshot = enqueueMocks.captured.insertedRunValues?.contextSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      wakeReason: "adapter_fallback",
      fallbackAttempt: 2,
      fallbackAdapterType: "codex_local",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-fallback-model",
      fallbackCandidateIndex: 1,
    });
    expect(snapshot.fallbackCommand).toBeUndefined();
    expect(runEvents[0]?.payload).toMatchObject({ fallbackAdapterType: "codex_local", fallbackCandidateIndex: 1 });
    expect(queued.id).toBe("child-run-1");
  });
});

describe("gate-aware ordered fallback chain selection", () => {
  beforeEach(() => globalUsageLimitGate.clear());

  it("skips the quota-limited candidate 1 and picks candidate 2", () => {
    const fallback = resolveAdapterFallbackConfig({
      command: "primary-cmd",
      fallback: {
        order: [
          { provider: "openai", model: "gpt-quota-hit" },
          { adapterType: "claude_local", provider: "anthropic", model: "claude-next" },
        ],
      },
    });
    expect(fallback).not.toBeNull();
    globalUsageLimitGate.recordQuotaLimit(
      { adapterType: "codex_local", provider: "openai", model: "gpt-quota-hit" },
      { nowMs: Date.now() },
    );
    const selected = selectNextAdapterFallbackEntry({
      fallback: fallback!,
      currentAttempt: 0,
      defaultAdapterType: "codex_local",
      defaultCommand: "primary-cmd",
      isCandidateBlocked: (candidate) => globalUsageLimitGate.isBlocked(candidate).blocked,
    });
    expect(selected?.candidateIndex).toBe(1);
    expect(selected?.resolvedAdapterType).toBe("claude_local");
    expect(selected?.resolvedCommand).toBe("primary-cmd");
    expect(selected?.entry).toMatchObject({ provider: "anthropic", model: "claude-next" });

    const fallbackRun = { retryOfRunId: "parent" } as unknown as typeof heartbeatRuns.$inferSelect;
    const resolved = resolveAdapterFallbackAdapterType({
      run: fallbackRun,
      context: { wakeReason: "adapter_fallback", fallbackOfRunId: "parent", fallbackAdapterType: selected!.resolvedAdapterType },
      defaultAdapterType: "codex_local",
    });
    expect(resolved).toBe("claude_local");
    const nonFallbackRun = { retryOfRunId: null } as unknown as typeof heartbeatRuns.$inferSelect;
    expect(resolveAdapterFallbackAdapterType({ run: nonFallbackRun, context: {}, defaultAdapterType: "codex_local" })).toBe("codex_local");
  });
});

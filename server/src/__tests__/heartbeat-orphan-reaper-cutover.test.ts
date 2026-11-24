import { spawn } from "node:child_process";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, operatorDecisions, type Db } from "@paperclipai/db";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { reapOrphanedRuns, type HeartbeatOrphanReaperDeps } from "../services/heartbeat-orphan-reaper.js";
import {
  discoverActiveRunsForReaper,
  STALE_RUNS_CUTOVER_LIMIT,
  STALE_RUNS_MAX_CANDIDATE_IDS,
} from "../services/heartbeat-orphan-reaper-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import { logger } from "../middleware/logger.js";

vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: vi.fn(() => null),
}));

const CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ON = { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "1" };
const NOW = new Date("2026-01-01T00:10:00.000Z");
const UUID_LIKE = /^[0-9a-f-]{36}$/i;
let seq = 0;
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
type RunRow = typeof heartbeatRuns.$inferSelect;
type ActiveRow = { run: RunRow; adapterType: string };
const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, companyId: CO, agentId: AG, issueId: null, status: "running", createdAt: NOW,
  updatedAt: NOW, startedAt: null, processPid: null, processStartedAt: null,
  externalRunId: null, wakeupRequestId: null, errorCode: null, contextSnapshot: null,
  processLossRetryCount: 0, ...over,
}) as unknown as RunRow;
const active = (id: string, over: Record<string, unknown> = {}): ActiveRow =>
  ({ run: run(id, over), adapterType: "claude_local" });
const stale = (id: string) => ({ id, company_id: CO, agent_id: AG, process_pid: null,
  process_loss_retry_count: 0, updated_at: "2020-01-01T00:00:00Z" });
const AGENT_ROW = { id: AG, companyId: CO, status: "active", runtimeConfig: {} } as unknown as typeof agents.$inferSelect;

const dialect = new PgDialect();
type Q = { distinct: boolean; keys: string[] | null; table: unknown; params: unknown[] };
function mockDb(route: (q: Q) => unknown) {
  const chain = (q: Q): any => ({
    innerJoin: () => chain(q), orderBy: () => chain(q), limit: () => chain(q), for: () => chain(q),
    where: (c: any) => (q.params = c === undefined ? [] : dialect.sqlToQuery(c).params, chain(q)),
    then: (res: any, rej: any) => Promise.resolve(route(q)).then(res, rej),
  });
  const sel = (distinct: boolean) => (s?: Record<string, unknown>) => ({
    from: (table: unknown) => chain({ distinct, keys: s ? Object.keys(s) : null, table, params: [] }),
  });
  const db = {
    select: sel(false), selectDistinct: sel(true), transaction: async (cb: any) => cb(db),
    update: () => ({ set: () => {
      const w: any = { returning: async () => [] };
      w.then = (res: any) => Promise.resolve([]).then(res);
      return { where: () => w };
    } }),
  };
  return db as unknown as Db;
}
const byIds = (rows: ActiveRow[], params: unknown[]) => {
  const ids = new Set(params.filter((p): p is string => typeof p === "string" && UUID_LIKE.test(p)));
  return ids.size === 0 ? rows : rows.filter((r) => ids.has(r.run.id));
};
function engineStub(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown) => (calls.push({ method, params }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const discover = (db: Db, over: Record<string, unknown> = {}) =>
  discoverActiveRunsForReaper({ db, now: NOW, staleThresholdMs: 0, activeExecutionTimeoutMs: 0, inMemoryRunIds: [], ...over });

describe("discoverActiveRunsForReaper", () => {
  beforeEach(() => vi.clearAllMocks());
  it("flag OFF takes the TS scan with zero RPCs and no shared-client resolve", async () => {
    const ROW = active(rid());
    const out = await discover(mockDb(() => [ROW]), { staleThresholdMs: 60_000, env: {} });
    expect(out).toEqual([ROW]);
    expect(getSharedPaperworkEngineClient).not.toHaveBeenCalled();
  });
  it("flag ON uses conservative +1ms cutoff, snapshots inMemoryRunIds early, and hydrates union", async () => {
    const [A, B, M, LATE, X] = [rid(), rid(), rid(), rid(), rid()];
    const inMem = new Set([M]);
    const rows = [active(A), active(B), active(M), active(LATE), active(X)];
    const db = mockDb((q) => (q.distinct ? (inMem.add(LATE), [{ companyId: CO }]) : byIds(rows, q.params)));
    const { client, calls } = engineStub(() => ({ runs: [stale(A), stale(B)] }));
    const out = await discover(db, { staleThresholdMs: 60_000, activeExecutionTimeoutMs: 30_000,
      inMemoryRunIds: inMem, engineClient: client, env: ON });
    expect(calls).toEqual([{ method: "heartbeat.list_stale_runs",
      params: { company_id: CO, stale_before: "2026-01-01T00:09:30.001Z", limit: STALE_RUNS_CUTOVER_LIMIT } }]);
    expect(out.map((r) => r.run.id).sort()).toEqual([A, B, M].sort());
  });
  it("flag ON uses full TS scan with zero engine work when staleThresholdMs <= 0", async () => {
    const ROW = active(rid());
    let distinctQueries = 0;
    const db = mockDb((q) => (q.distinct && distinctQueries++, [ROW]));
    const { client, calls } = engineStub(() => ({ runs: [] }));
    expect(await discover(db, { staleThresholdMs: 0, engineClient: client, env: ON })).toEqual([ROW]);
    // engineClient 미주입 경로도 임계 게이트가 공유 getter·회사 쿼리보다 먼저라 엔진 작업 0.
    expect(await discover(db, { staleThresholdMs: 0, env: ON })).toEqual([ROW]);
    expect(calls).toHaveLength(0);
    expect(getSharedPaperworkEngineClient).not.toHaveBeenCalled();
    expect(distinctQueries).toBe(0);
  });
  it("flag ON falls back to the unbounded TS scan when a company result reaches the limit", async () => {
    const FULL_ONLY = active(rid());
    const db = mockDb((q) => (q.distinct ? [{ companyId: CO }] : q.params.length === 1 ? [FULL_ONLY] : []));
    const { client, calls } = engineStub(() => ({
      runs: Array.from({ length: STALE_RUNS_CUTOVER_LIMIT }, () => stale(rid())),
    }));
    const out = await discover(db, { staleThresholdMs: 60_000, engineClient: client, env: ON });
    expect(calls).toHaveLength(1);
    expect(out).toEqual([FULL_ONLY]);
  });
  it("flag ON falls back to TS when aggregate candidate IDs across companies exceed bind budget", async () => {
    const FULL_ONLY = active(rid());
    const companies = Array.from({ length: 55 }, () => ({ companyId: rid() }));
    const db = mockDb((q) => (q.distinct ? companies : q.params.length === 1 ? [FULL_ONLY] : []));
    const { client, calls } = engineStub(() => ({
      runs: Array.from({ length: STALE_RUNS_CUTOVER_LIMIT - 1 }, () => stale(rid())),
    }));
    const out = await discover(db, { staleThresholdMs: 60_000, engineClient: client, env: ON });
    expect(calls.length).toBeLessThan(companies.length);
    expect(calls.length * (STALE_RUNS_CUTOVER_LIMIT - 1)).toBeGreaterThan(STALE_RUNS_MAX_CANDIDATE_IDS);
    expect(out).toEqual([FULL_ONLY]);
  });
  it("flag ON short-circuits to the full TS scan on the first Rust error", async () => {
    const ROW = active(rid());
    const db = mockDb((q) => (q.distinct ? [{ companyId: CO }, { companyId: AG }] : q.params.length === 1 ? [ROW] : []));
    const { client, calls } = engineStub(() => { throw new PaperworkEngineError("timeout", "t"); });
    const out = await discover(db, { staleThresholdMs: 60_000, engineClient: client, env: ON });
    expect(calls).toHaveLength(1);
    expect(out).toEqual([ROW]);
  });
  it("flag ON falls back to TS when engineClient is null or shared getter throws", async () => {
    const ROW = active(rid());
    expect(await discover(mockDb(() => [ROW]), { staleThresholdMs: 60_000, engineClient: null, env: ON })).toEqual([ROW]);
    expect(getSharedPaperworkEngineClient).not.toHaveBeenCalled();
    const warnSpy = vi.spyOn(logger, "warn");
    vi.mocked(getSharedPaperworkEngineClient).mockImplementationOnce(() => { throw new Error("init boom"); });
    expect(await discover(mockDb(() => [ROW]), { staleThresholdMs: 60_000, env: ON })).toEqual([ROW]);
    expect(warnSpy).toHaveBeenCalledWith({ err: expect.any(Error) },
      expect.stringContaining("shared client resolution failed"));
  });
});

describe("reapOrphanedRuns with cutover flag ON", () => {
  it("preserves approval-wait, detached, and queued-stale semantics via engine discovery", async () => {
    const child = spawn("sleep", ["30"]);
    try {
      const now = Date.now();
      const [WAIT, DET, QUE, ISS1, ISS2, DEC] = [rid(), rid(), rid(), rid(), rid(), rid()];
      const waitRun = run(WAIT, { issueId: ISS1, updatedAt: new Date(now - 120_000) });
      const detRun = run(DET, { processPid: child.pid, processStartedAt: new Date(now),
        startedAt: new Date(now), updatedAt: new Date(now - 120_000) });
      const queRun = run(QUE, { issueId: ISS2, status: "queued", updatedAt: new Date(now - 120_000) });
      const deadQue = { ...queRun, status: "failed" };
      let approvalChecked = false;
      const db = mockDb((q) => {
        if (q.table === heartbeatRuns) {
          if (q.distinct) return [{ companyId: CO }];
          if (q.keys?.includes("run")) return byIds(
            [{ run: waitRun, adapterType: "claude_local" }, { run: detRun, adapterType: "claude_local" }],
            q.params,
          );
          if (q.keys?.includes("id")) return [];
          return q.params.includes("queued") ? [queRun] : [];
        }
        if (q.table === operatorDecisions) {
          if (q.params.includes(ISS1)) { approvalChecked = true; return [{ id: DEC, issueId: ISS1 }]; }
          return [];
        }
        return q.table === agents && q.keys === null ? [AGENT_ROW] : [];
      });
      const { client, calls } = engineStub(() => ({ runs: [stale(DET)] }));
      const setRunStatus = vi.fn(async () => null);
      const demote = vi.fn(async () => undefined);
      const setHb = vi.fn(async () => deadQue);
      const result = await reapOrphanedRuns({
        db, engineClient: client, cutoverEnv: ON,
        appendRunEvent: vi.fn(), nextRunEventSeq: vi.fn(async () => 1),
        setRunStatus, setWakeupStatus: vi.fn(), recordQueueTransitionEvent: vi.fn(),
        finalizeAgentStatus: vi.fn(), countRunningRunsForAgent: vi.fn(async () => 0),
        getAgent: vi.fn(async () => AGENT_ROW), getRun: vi.fn(async () => deadQue),
        demoteAgentStuckDetached: demote, startNextQueuedRunForAgent: vi.fn(),
        releaseIssueExecutionAndPromote: vi.fn(),
        resolveRunActiveExecutionTimeoutMs: vi.fn(async (_r: unknown, b: number) => b),
        runTerminalReleaseContinuation: vi.fn(async () => ({ kind: "complete" })),
        retryEnqueueDeps: {}, wikiSvc: { recordFailure: vi.fn(async () => ({})) },
        activeRunExecutions: new Set([WAIT]), terminalContinuationInflight: new Set(),
        getTerminalContinuationScanCursor: () => null, setTerminalContinuationScanCursor: () => {},
        publishHeartbeatRunStatus: vi.fn(), setHeartbeatRunStatus: setHb,
        enqueueProcessLossRetry: vi.fn(async () => null), enqueueAdapterFallbackRun: vi.fn(async () => null),
        settleHeartbeatAfterExecution: vi.fn(), TERMINAL_RELEASE_EVENT_TYPE: "x",
        readTerminalReleaseManifest: vi.fn(async () => ({ kind: "missing" })),
      } as unknown as HeartbeatOrphanReaperDeps,
      { staleThresholdMs: 60_000, activeExecutionTimeoutMs: 60_000, queuedStaleThresholdMs: 60_000 });
      expect(calls.map((c) => c.method)).toEqual(["heartbeat.list_stale_runs"]);
      expect(calls[0]?.params).toMatchObject({ company_id: CO, limit: STALE_RUNS_CUTOVER_LIMIT });
      expect(demote).toHaveBeenCalledWith(detRun, expect.any(Date));
      expect(approvalChecked).toBe(true);
      expect(setRunStatus.mock.calls.every((c) => c[0] !== WAIT)).toBe(true);
      expect(setHb).toHaveBeenCalledWith(expect.anything(), QUE, "failed",
        expect.objectContaining({ errorCode: "stale_queued" }), expect.anything());
      expect(result.runIds).toContain(QUE);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type { WikiEntryRow } from "../services/paperwork-engine-wiki.js";
import {
  closeEntryWithCutover,
  listWikiEntriesWithCutover,
  markResolvedWithCutover,
  recordFailureWithCutover,
  searchRelevantWithCutover,
  WikiCutoverIndeterminateError,
} from "../services/wiki-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import {
  createWikiCutoverHooks,
  getWikiCutoverMetrics,
  resetWikiCutoverMetricsForTests,
  WIKI_WIRED_OPERATIONS,
  wireCloseEntryCutover,
  wireListWikiEntriesCutover,
  wireMarkResolvedCutover,
  wireRecordFailureCutover,
  wireSearchRelevantCutover,
  type WikiCutoverResult,
  type WikiCutoverTelemetryEvent,
  type WikiCutoverWiringOpts,
  type WikiWiredOperation,
} from "../services/wiki-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", () => ({
  getSharedPaperworkEngineClient: vi.fn(),
}));

// Wave 4 어댑터만 vi.fn 으로 교체해 결과를 스크립트한다. 플래그 판정
// (isWikiEngineCutoverEnabled)·WikiCutoverIndeterminateError 는 실구현을 유지한다.
vi.mock("../services/wiki-cutover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/wiki-cutover.js")>();
  return {
    ...actual,
    recordFailureWithCutover: vi.fn(),
    searchRelevantWithCutover: vi.fn(),
    listWikiEntriesWithCutover: vi.fn(),
    markResolvedWithCutover: vi.fn(),
    closeEntryWithCutover: vi.fn(),
  };
});

const adapter = {
  record_failure: vi.mocked(recordFailureWithCutover),
  search_relevant: vi.mocked(searchRelevantWithCutover),
  list: vi.mocked(listWikiEntriesWithCutover),
  mark_resolved: vi.mocked(markResolvedWithCutover),
  close: vi.mocked(closeEntryWithCutover),
};
const warn = vi.mocked(logger.warn);
const sharedClient = vi.mocked(getSharedPaperworkEngineClient);

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_WIKI_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z";
const ENTRY: WikiEntryRow = {
  id: NIL, company_id: NIL, agent_id: U1, mission_id: null,
  pattern: "pattern", cause: "cause", solution: "solution", error_code: "E",
  step_id: "step-1", frequency: 2, status: "active", audience: "agent",
  last_seen_at: T0, resolved_at: null, created_at: T0, updated_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: U1, mission_id: null, pattern: "pattern", cause: "cause",
  solution: "solution", error_code: "E", step_id: "step-1", audience: "agent" as const,
};
const SEARCH = { company_id: NIL, agent_id: U1, now: T0, step_id: "step-1", limit: 3 };
const LIST = { company_id: NIL, limit: 5 };
const IDPARAMS = { entry_id: NIL, company_id: NIL };
const RECORDED = { recorded: true, entry: ENTRY } as const;
const SEARCHED = { entries: [ENTRY] };
const RESOLVED = { resolved: true, entry: ENTRY } as const;
const CLOSED = { closed: true, entry: ENTRY } as const;
const CLIENT = {} as PaperworkEngineClient;

const indeterminate = () => new WikiCutoverIndeterminateError("record_failure",
  { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false },
  new Error("rpc_-32005"));
const hostileError = () => Object.defineProperty(new Error("boom"), "stack",
  { get() { throw new Error("stack-getter-boom"); } });

interface OpCase {
  op: WikiWiredOperation; params: unknown; result: unknown; mock: Mock;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: WikiCutoverWiringOpts) => Promise<WikiCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "record_failure", params: RECORD, result: RECORDED, mock: adapter.record_failure,
    invoke: (f, o) => wireRecordFailureCutover(RECORD, f as never, o) },
  { op: "search_relevant", params: SEARCH, result: SEARCHED, mock: adapter.search_relevant,
    invoke: (f, o) => wireSearchRelevantCutover(SEARCH, f as never, o) },
  { op: "list", params: LIST, result: SEARCHED, mock: adapter.list,
    invoke: (f, o) => wireListWikiEntriesCutover(LIST, f as never, o) },
  { op: "mark_resolved", params: IDPARAMS, result: RESOLVED, mock: adapter.mark_resolved,
    invoke: (f, o) => wireMarkResolvedCutover(IDPARAMS, f as never, o) },
  { op: "close", params: IDPARAMS, result: CLOSED, mock: adapter.close,
    invoke: (f, o) => wireCloseEntryCutover(IDPARAMS, f as never, o) },
];

beforeEach(() => {
  resetWikiCutoverMetricsForTests();
  for (const mock of Object.values(adapter)) mock.mockReset();
  sharedClient.mockReset().mockReturnValue(null);
  warn.mockReset();
});

describe("wiki-cutover-wiring", () => {
  it("flag OFF routes all five ops to tsFallback: zero client resolution, zero adapter calls", async () => {
    const getClient = vi.fn(() => CLIENT);
    for (const env of [OFF, { PAPERWORK_RUST_WIKI_CUTOVER: "0" }, { PAPERWORK_RUST_WIKI_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClient).not.toHaveBeenCalled();
    for (const op of OPS) expect(op.mock).not.toHaveBeenCalled();
    const m = getWikiCutoverMetrics();
    for (const op of WIKI_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
    expect(m.record_failure.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null/throwing getClient or null shared client warns and fails safe to tsBypass", async () => {
    const tsFallback = vi.fn(async () => RECORDED);
    await expect(wireRecordFailureCutover(RECORD, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    await expect(wireRecordFailureCutover(RECORD, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: RECORDED });
    await expect(wireListWikiEntriesCutover(LIST, async () => SEARCHED, { env: ON }))
      .resolves.toEqual({ source: "ts", value: SEARCHED });
    expect(sharedClient).toHaveBeenCalledTimes(1);
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(adapter.record_failure).not.toHaveBeenCalled();
    expect(getWikiCutoverMetrics().record_failure)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
    expect(getWikiCutoverMetrics().list).toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("flag ON + rust result counts rustOk and routes all five ops with timeoutMs/env pass-through", async () => {
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "rust", value: op.result });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => CLIENT, timeoutMs: 1234 }))
        .resolves.toEqual({ source: "rust", value: op.result });
      expect(op.mock).toHaveBeenCalledWith(CLIENT, op.params, tsFallback, { timeoutMs: 1234, env: ON });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(WIKI_WIRED_OPERATIONS).toEqual([
      "record_failure", "search_relevant", "list", "mark_resolved", "close",
    ]);
    const m = getWikiCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0, indeterminate: 0 });
    }
  });

  it("flag ON + ts-sourced adapter result counts fallback with source ts", async () => {
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "ts", value: op.result });
      await expect(op.invoke(vi.fn(), { env: ON, getClient: () => CLIENT }))
        .resolves.toEqual({ source: "ts", value: op.result });
    }
    const m = getWikiCutoverMetrics();
    for (const op of OPS) expect(m[op.op]).toMatchObject({ fallback: 1, rustOk: 0, tsBypass: 0 });
  });

  it("indeterminate adapter error rethrows, counts indeterminate, and never calls tsFallback", async () => {
    const failure = indeterminate();
    adapter.record_failure.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => RECORDED);
    const events: WikiCutoverTelemetryEvent[] = [];
    await expect(wireRecordFailureCutover(RECORD, tsFallback, {
      env: ON, getClient: () => CLIENT, onEvent: (e) => { events.push(e); },
    })).rejects.toBe(failure);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      operation: "record_failure", outcome: "indeterminate", source: null, error: failure,
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(getWikiCutoverMetrics().record_failure)
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0, tsError: 0 });
  });

  it("non-indeterminate adapter throw counts ts_error and rethrows", async () => {
    const failure = new Error("tsFallback failed inside adapter");
    adapter.search_relevant.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => SEARCHED);
    await expect(wireSearchRelevantCutover(SEARCH, tsFallback, { env: ON, getClient: () => CLIENT }))
      .rejects.toBe(failure);
    expect(getWikiCutoverMetrics().search_relevant)
      .toMatchObject({ tsError: 1, rustOk: 0, indeterminate: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws on the bypass path", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async (): Promise<never> => { throw failure; });
    await expect(wireCloseEntryCutover(IDPARAMS, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getWikiCutoverMetrics().close)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("hostile getClient/logger errors cannot mask the bypass outcome", async () => {
    warn.mockImplementation(() => { throw hostileError(); });
    const tsFallback = vi.fn(async () => RECORDED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireRecordFailureCutover(RECORD, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getWikiCutoverMetrics().record_failure).toMatchObject({ tsBypass: 1 });
  });

  it("createWikiCutoverHooks binds defaults, merges per-call opts, owns an independent meter", async () => {
    adapter.record_failure.mockResolvedValueOnce({ source: "rust", value: RECORDED });
    adapter.close.mockResolvedValueOnce({ source: "rust", value: CLOSED });
    const events: WikiCutoverTelemetryEvent[] = [];
    const hooks = createWikiCutoverHooks({
      env: ON, getClient: () => CLIENT, timeoutMs: 4321,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.recordFailure(RECORD, vi.fn())).resolves.toEqual({ source: "rust", value: RECORDED });
    await expect(hooks.closeEntry(IDPARAMS, vi.fn())).resolves.toEqual({ source: "rust", value: CLOSED });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && e.durationMs >= 0)).toBe(true);
    expect(adapter.record_failure)
      .toHaveBeenCalledWith(CLIENT, RECORD, expect.any(Function), { timeoutMs: 4321, env: ON });

    await expect(hooks.listWikiEntries(LIST, async () => SEARCHED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: SEARCHED });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ operation: "list", outcome: "ts_bypass", source: "ts" });

    const m = hooks.getMetrics();
    expect(m.record_failure).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.close).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.list).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(hooks.snapshot()).toEqual(m);
    expect(getWikiCutoverMetrics().record_failure.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireMarkResolvedCutover(IDPARAMS, async () => RESOLVED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: WikiCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: RESOLVED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getWikiCutoverMetrics returns a deep copy; reset zeroes every counter", async () => {
    await wireSearchRelevantCutover(SEARCH, async () => SEARCHED, { env: OFF });
    const snap = getWikiCutoverMetrics();
    Object.assign(snap.search_relevant, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list, { totalCalls: 999 });
    const fresh = getWikiCutoverMetrics();
    expect(fresh.search_relevant).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list.totalCalls).toBe(0);

    resetWikiCutoverMetricsForTests();
    const zeroed = getWikiCutoverMetrics();
    for (const op of WIKI_WIRED_OPERATIONS) {
      expect(zeroed[op]).toMatchObject({
        rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0, tsError: 0,
        totalCalls: 0, totalDurationMs: 0,
      });
    }
  });
});

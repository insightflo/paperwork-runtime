import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { logger } from "../middleware/logger.js";
import {
  CostCutoverIndeterminateError, getCostSpendSnapshotWithCutover,
  listCostEventsWithCutover, recordCostEventWithCutover,
  summarizeCostWindowWithCutover,
} from "../services/cost-cutover.js";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  createCostCutoverHooks, getCostCutoverMetrics, resetCostCutoverMetricsForTests,
  wireGetCostSpendSnapshotCutover, wireListCostEventsCutover,
  wireRecordCostEventCutover, wireSummarizeCostWindowCutover,
  type CostCutoverResult, type CostCutoverTelemetryEvent,
  type CostCutoverWiringOpts, type CostWiredOperation,
} from "../services/cost-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => {
  const mock: Record<string, unknown> = {
    warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(),
  };
  mock.child = vi.fn(() => mock);
  return { logger: mock, httpLogger: vi.fn() };
});

// Wave 4 어댑터만 vi.fn 으로 교체해 결과를 스크립트한다. 플래그 판정
// (isCostEngineCutoverEnabled)·CostCutoverIndeterminateError 는 실구현을 유지한다.
vi.mock("../services/cost-cutover.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/cost-cutover.js")>();
  return {
    ...real,
    recordCostEventWithCutover: vi.fn(),
    listCostEventsWithCutover: vi.fn(),
    summarizeCostWindowWithCutover: vi.fn(),
    getCostSpendSnapshotWithCutover: vi.fn(),
  };
});

const adapter = {
  record_event: vi.mocked(recordCostEventWithCutover),
  list_events: vi.mocked(listCostEventsWithCutover),
  summarize_window: vi.mocked(summarizeCostWindowWithCutover),
  get_spend_snapshot: vi.mocked(getCostSpendSnapshotWithCutover),
};
const warn = vi.mocked(logger.warn);

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_COST_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-02-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null,
  goal_id: null, heartbeat_run_id: null, billing_code: null, provider: "anthropic",
  biller: "anthropic", billing_type: "metered_api", model: "m", input_tokens: 1,
  cached_input_tokens: 0, output_tokens: 2, cost_cents: 3,
  occurred_at: T0, created_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: NIL, provider: "anthropic", model: "m",
  occurred_at: T0, input_tokens: 1, cached_input_tokens: 0, output_tokens: 2,
  cost_cents: 3,
};
const LIST = { company_id: NIL, agent_id: NIL, from: T0, to: T1, limit: 10 };
const WINDOW = { company_id: NIL, from: T0, to: T1 };
const SNAP = { company_id: NIL };
const RECORDED = { recorded: true as const, event: EVENT };
const LISTED = { events: [EVENT] };
const SUMMED = { spend_cents: 7 };
const SNAPSHOT = {
  found: true as const, company_id: NIL,
  budget_monthly_cents: 100, spent_monthly_cents: 50,
};

const CLIENT = {} as PaperworkEngineClient;
const indeterminate = () => new CostCutoverIndeterminateError("record_event",
  { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false },
  new Error("rpc_-32005"));
const hostileError = () => Object.defineProperty(new Error("boom"), "stack",
  { get() { throw new Error("stack-getter-boom"); } });

interface OpCase {
  op: CostWiredOperation; params: unknown; result: unknown; mock: Mock;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: CostCutoverWiringOpts) => Promise<CostCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "record_event", params: RECORD, result: RECORDED, mock: adapter.record_event,
    invoke: (f, o) => wireRecordCostEventCutover(RECORD, f as never, o) },
  { op: "list_events", params: LIST, result: LISTED, mock: adapter.list_events,
    invoke: (f, o) => wireListCostEventsCutover(LIST, f as never, o) },
  { op: "summarize_window", params: WINDOW, result: SUMMED, mock: adapter.summarize_window,
    invoke: (f, o) => wireSummarizeCostWindowCutover(WINDOW, f as never, o) },
  { op: "get_spend_snapshot", params: SNAP, result: SNAPSHOT, mock: adapter.get_spend_snapshot,
    invoke: (f, o) => wireGetCostSpendSnapshotCutover(SNAP, f as never, o) },
];

beforeEach(() => {
  resetCostCutoverMetricsForTests();
  for (const mock of Object.values(adapter)) mock.mockReset();
  warn.mockReset();
});

describe("cost-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all ops to tsFallback: zero getClient, zero adapter calls", async () => {
    const getClient = vi.fn(() => CLIENT);
    for (const env of [OFF, { PAPERWORK_RUST_COST_CUTOVER: "0" }, { PAPERWORK_RUST_COST_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    for (const op of OPS) expect(op.mock).not.toHaveBeenCalled();
    const m = getCostCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
    expect(m.record_event.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient warns and fails safe to tsFallback (tsBypass)", async () => {
    const tsFallback = vi.fn(async () => RECORDED);
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(adapter.record_event).not.toHaveBeenCalled();
    expect(getCostCutoverMetrics().record_event)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
  });

  it("flag ON + rust result counts rustOk and delegates params/timeoutMs/env to the adapter", async () => {
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "rust", value: op.result });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => CLIENT, timeoutMs: 1234 }))
        .resolves.toEqual({ source: "rust", value: op.result });
      expect(op.mock)
        .toHaveBeenCalledWith(CLIENT, op.params, tsFallback, { timeoutMs: 1234, env: ON });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    const m = getCostCutoverMetrics();
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
    const m = getCostCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ fallback: 1, rustOk: 0, tsBypass: 0 });
    }
  });

  it.each(OPS)("$op: indeterminate adapter error rethrows, counts indeterminate, never calls tsFallback", async (op) => {
    const failure = indeterminate();
    op.mock.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(tsFallback, { env: ON, getClient: () => CLIENT })).rejects.toBe(failure);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getCostCutoverMetrics()[op.op])
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0, tsError: 0 });
  });

  it("non-indeterminate adapter throw counts ts_error and rethrows", async () => {
    const failure = new Error("tsFallback failed inside adapter");
    adapter.summarize_window.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => SUMMED);
    await expect(wireSummarizeCostWindowCutover(WINDOW, tsFallback, { env: ON, getClient: () => CLIENT }))
      .rejects.toBe(failure);
    expect(getCostCutoverMetrics().summarize_window)
      .toMatchObject({ tsError: 1, rustOk: 0, indeterminate: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws on the bypass path", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getCostCutoverMetrics().record_event)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("logger.warn throwing inside safeWarn cannot mask the bypass outcome", async () => {
    warn.mockImplementation(() => { throw hostileError(); });
    const res = await wireRecordCostEventCutover(RECORD, async () => RECORDED,
      { env: ON, getClient: () => null });
    expect(res).toEqual({ source: "ts", value: RECORDED });
    expect(getCostCutoverMetrics().record_event).toMatchObject({ tsBypass: 1 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => RECORDED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getCostCutoverMetrics().record_event).toMatchObject({ tsBypass: 1 });
  });

  it("createCostCutoverHooks binds defaults, merges per-call opts, owns an independent meter", async () => {
    adapter.record_event.mockResolvedValueOnce({ source: "rust", value: RECORDED });
    adapter.list_events.mockResolvedValueOnce({ source: "rust", value: LISTED });
    const events: CostCutoverTelemetryEvent[] = [];
    const hooks = createCostCutoverHooks({
      env: ON, getClient: () => CLIENT, timeoutMs: 4321,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.recordCostEvent(RECORD, vi.fn())).resolves.toEqual({ source: "rust", value: RECORDED });
    await expect(hooks.listCostEvents(LIST, vi.fn())).resolves.toEqual({ source: "rust", value: LISTED });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && e.durationMs >= 0)).toBe(true);
    expect(adapter.record_event)
      .toHaveBeenCalledWith(CLIENT, RECORD, expect.any(Function), { timeoutMs: 4321, env: ON });

    // 호출당 opts 는 바인드된 기본값 위에 병합된다.
    await expect(hooks.recordCostEvent(RECORD, async () => RECORDED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ operation: "record_event", outcome: "ts_bypass", source: "ts" });

    const m = hooks.getMetrics();
    expect(m.record_event).toMatchObject({ rustOk: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.list_events).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(hooks.snapshot()).toEqual(m);
    // 훅 미터는 모듈 수준 미터와 독립이다.
    expect(getCostCutoverMetrics().record_event.totalCalls).toBe(0);
  });

  it("onEvent receives the indeterminate outcome with its error; observer throw cannot mask it", async () => {
    const failure = indeterminate();
    adapter.record_event.mockRejectedValueOnce(failure);
    const events: CostCutoverTelemetryEvent[] = [];
    const onEvent = vi.fn((e: CostCutoverTelemetryEvent) => { events.push(e); throw hostileError(); });
    const tsFallback = vi.fn(async () => RECORDED);
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: ON, getClient: () => CLIENT, onEvent }))
      .rejects.toBeInstanceOf(CostCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      operation: "record_event", outcome: "indeterminate", source: null, error: failure,
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getCostCutoverMetrics().record_event).toMatchObject({ indeterminate: 1, fallback: 0 });
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireRecordCostEventCutover(RECORD, async () => RECORDED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: CostCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: RECORDED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getCostCutoverMetrics returns a deep copy; reset zeroes every counter", async () => {
    await wireRecordCostEventCutover(RECORD, async () => RECORDED, { env: OFF });
    const snap = getCostCutoverMetrics();
    Object.assign(snap.record_event, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.get_spend_snapshot, { totalCalls: 999 });
    const fresh = getCostCutoverMetrics();
    expect(fresh.record_event).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.get_spend_snapshot.totalCalls).toBe(0);

    resetCostCutoverMetricsForTests();
    const zeroed = getCostCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });
});

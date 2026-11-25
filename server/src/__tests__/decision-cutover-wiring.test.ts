import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import * as adapter from "../services/decision-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import {
  createDecisionCutoverHooks,
  DECISION_WIRED_OPERATIONS,
  DecisionCutoverIndeterminateError,
  getDecisionCutoverMetrics,
  resetDecisionCutoverMetricsForTests,
  wireCancelDecisionCutover,
  wireCreateDecisionCutover,
  wireGetDecisionByIdCutover,
  wireGetDecisionByRequestKeyCutover,
  wireListDecisionsCutover,
  wireResolveDecisionCutover,
  type DecisionCutoverTelemetryEvent,
  type DecisionCutoverWiringOpts,
  type DecisionWiredOperation,
} from "../services/decision-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", () => ({
  getSharedPaperworkEngineClient: vi.fn(),
}));
vi.mock("../services/decision-cutover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/decision-cutover.js")>();
  return {
    ...actual,
    createDecisionWithCutover: vi.fn(),
    resolveDecisionWithCutover: vi.fn(),
    cancelDecisionWithCutover: vi.fn(),
    listDecisionsWithCutover: vi.fn(),
    getDecisionByIdWithCutover: vi.fn(),
    getDecisionByRequestKeyWithCutover: vi.fn(),
  };
});

type AnyMock = ReturnType<typeof vi.fn>;
const createMock = adapter.createDecisionWithCutover as unknown as AnyMock;
const resolveMock = adapter.resolveDecisionWithCutover as unknown as AnyMock;
const cancelMock = adapter.cancelDecisionWithCutover as unknown as AnyMock;
const listMock = adapter.listDecisionsWithCutover as unknown as AnyMock;
const getIdMock = adapter.getDecisionByIdWithCutover as unknown as AnyMock;
const getKeyMock = adapter.getDecisionByRequestKeyWithCutover as unknown as AnyMock;
const sharedClientMock = getSharedPaperworkEngineClient as unknown as AnyMock;
const warnMock = logger.warn as unknown as AnyMock;
const adapterMocks = [createMock, resolveMock, cancelMock, listMock, getIdMock, getKeyMock];

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_DECISION_CUTOVER: "1" };
const OFF = {};
const CREATE_PARAMS = {
  company_id: NIL, request_key: "rk", request_hash: "rh", priority: "high",
  interaction_type: "single_select", title: "t", description: "d",
  source_type: "agent", source_id: NIL, source_context: {}, definition: {},
  continuation_mode: "none",
};
const RESOLVE_PARAMS = {
  decision_id: NIL, company_id: NIL, result: { ok: true }, resolved_by_user_id: "u",
};
const CANCEL_PARAMS = { decision_id: NIL, company_id: NIL };
const LIST_PARAMS = { company_id: NIL };
const KEY_PARAMS = { company_id: NIL, request_key: "rk" };
const client = { call: vi.fn() } as unknown as PaperworkEngineClient;

type Invoke = (
  tsFallback: () => Promise<unknown>,
  opts?: DecisionCutoverWiringOpts,
) => Promise<unknown>;
interface OpCase {
  op: DecisionWiredOperation;
  params: unknown;
  result: unknown;
  mock: AnyMock;
  invoke: Invoke;
}
const OPS: OpCase[] = [
  { op: "create", params: CREATE_PARAMS, result: { created: true }, mock: createMock,
    invoke: (f, o) => wireCreateDecisionCutover(CREATE_PARAMS as never, f as never, o) },
  { op: "resolve", params: RESOLVE_PARAMS, result: { resolved: true }, mock: resolveMock,
    invoke: (f, o) => wireResolveDecisionCutover(RESOLVE_PARAMS as never, f as never, o) },
  { op: "cancel", params: CANCEL_PARAMS, result: { cancelled: true }, mock: cancelMock,
    invoke: (f, o) => wireCancelDecisionCutover(CANCEL_PARAMS as never, f as never, o) },
  { op: "list", params: LIST_PARAMS, result: [], mock: listMock,
    invoke: (f, o) => wireListDecisionsCutover(LIST_PARAMS as never, f as never, o) },
  { op: "get_by_id", params: CANCEL_PARAMS, result: { decision: null }, mock: getIdMock,
    invoke: (f, o) => wireGetDecisionByIdCutover(CANCEL_PARAMS as never, f as never, o) },
  { op: "get_by_request_key", params: KEY_PARAMS, result: { decision: null }, mock: getKeyMock,
    invoke: (f, o) => wireGetDecisionByRequestKeyCutover(KEY_PARAMS as never, f as never, o) },
];

const collectEvents = () => {
  const events: DecisionCutoverTelemetryEvent[] = [];
  return { events, onEvent: (event: DecisionCutoverTelemetryEvent) => { events.push(event); } };
};

beforeEach(() => {
  vi.resetAllMocks();
  resetDecisionCutoverMetricsForTests();
});

describe("decision-cutover-wiring", () => {
  it("flag OFF routes every operation straight to TS with zero client resolution", async () => {
    const getClient = vi.fn(() => client);
    const envs = [OFF,
      { PAPERWORK_RUST_DECISION_CUTOVER: "0" },
      { PAPERWORK_RUST_DECISION_CUTOVER: "true" }];
    for (const env of envs) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClientMock).not.toHaveBeenCalled();
    for (const mock of adapterMocks) expect(mock).not.toHaveBeenCalled();
    const metrics = getDecisionCutoverMetrics();
    for (const op of OPS) {
      expect(metrics[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
  });

  it("routes all 6 operations to the right adapter function with timeoutMs/env pass-through", async () => {
    const timeoutMs = 4_321;
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "rust", value: op.result });
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => client, timeoutMs }))
        .resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
      expect(op.mock).toHaveBeenCalledTimes(1);
      expect(op.mock).toHaveBeenCalledWith(client, op.params, tsFallback, { timeoutMs, env: ON });
    }
    const metrics = getDecisionCutoverMetrics();
    expect(DECISION_WIRED_OPERATIONS).toEqual([
      "create", "resolve", "cancel", "list", "get_by_id", "get_by_request_key",
    ]);
    for (const op of OPS) expect(metrics[op.op].rustOk).toBe(1);
  });

  it("flag ON resolves the shared client when opts.getClient is absent", async () => {
    sharedClientMock.mockReturnValue(client);
    createMock.mockResolvedValue({ source: "rust", value: { created: true } });
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, vi.fn() as never, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { created: true } });
    expect(sharedClientMock).toHaveBeenCalledTimes(1);
  });

  it("flag ON + null or throwing getClient warns and uses TS bypass", async () => {
    const tsFallback = vi.fn(async () => ({ created: true }));
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, tsFallback as never,
      { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: { created: true } });
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, tsFallback as never, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: { created: true } });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
  });

  it("adapter {source:'ts'} result counts fallback and emits fallback telemetry", async () => {
    const value = { created: false, conflict: "request_key" };
    createMock.mockResolvedValue({ source: "ts", value });
    const { events, onEvent } = collectEvents();
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, vi.fn() as never,
      { env: ON, getClient: () => client, onEvent }))
      .resolves.toEqual({ source: "ts", value });
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, fallback: 1, rustOk: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "create", outcome: "fallback", source: "ts" });
    expect(typeof events[0].durationMs).toBe("number");
  });

  it("IndeterminateError counts indeterminate and rethrows with no TS fallback", async () => {
    const cause = new Error("rpc_-32005");
    const error = new DecisionCutoverIndeterminateError("create",
      { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false }, cause);
    createMock.mockRejectedValue(error);
    const tsFallback = vi.fn(async () => ({ created: true }));
    const { events, onEvent } = collectEvents();
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, tsFallback as never,
      { env: ON, getClient: () => client, onEvent })).rejects.toBe(error);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, indeterminate: 1, fallback: 0, rustOk: 0 });
    expect(events[0]).toMatchObject({ outcome: "indeterminate", source: null, error });
  });

  it("non-indeterminate adapter throws count ts_error and rethrow", async () => {
    const failure = new Error("ts fallback inside adapter failed");
    createMock.mockRejectedValue(failure);
    const { events, onEvent } = collectEvents();
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never, vi.fn() as never,
      { env: ON, getClient: () => client, onEvent })).rejects.toBe(failure);
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, tsError: 1, tsBypass: 0, indeterminate: 0 });
    expect(events[0]).toMatchObject({ outcome: "ts_error", source: null, error: failure });
  });

  it("tsFallback throws in bypass: ts_error is counted and rethrown", async () => {
    const failure = new Error("db gone");
    await expect(wireCreateDecisionCutover(CREATE_PARAMS as never,
      (async () => { throw failure; }) as never, { env: OFF })).rejects.toBe(failure);
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1, rustOk: 0 });
  });

  it("onEvent receives structured events and observer throw/rejection is swallowed", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const sync = await wireCreateDecisionCutover(CREATE_PARAMS as never,
        (async () => ({ created: true })) as never, {
          env: OFF,
          onEvent: () => { throw new Error("observer boom"); },
        });
      expect(sync).toEqual({ source: "ts", value: { created: true } });
      const asyncRes = await wireCreateDecisionCutover(CREATE_PARAMS as never,
        (async () => ({ created: true })) as never, {
          env: OFF,
          onEvent: (async () => { throw new Error("async observer boom"); }) as never,
        });
      expect(asyncRes).toEqual({ source: "ts", value: { created: true } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
      expect(warnMock).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("createDecisionCutoverHooks uses an independent meter and merges per-call opts", async () => {
    createMock.mockResolvedValue({ source: "rust", value: { created: true } });
    const { events, onEvent } = collectEvents();
    const hooks = createDecisionCutoverHooks({ env: ON, getClient: () => client, onEvent });
    await expect(hooks.createDecision(CREATE_PARAMS as never, vi.fn() as never))
      .resolves.toEqual({ source: "rust", value: { created: true } });
    await expect(hooks.createDecision(CREATE_PARAMS as never,
      (async () => ({ created: true })) as never, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { created: true } });
    expect(events.map((event) => event.outcome)).toEqual(["rust_ok", "ts_bypass"]);
    expect(hooks.getMetrics().create).toMatchObject({ totalCalls: 2, rustOk: 1, tsBypass: 1 });
    expect(hooks.snapshot().create.totalCalls).toBe(2);
    expect(getDecisionCutoverMetrics().create.totalCalls).toBe(0);
  });

  it("metrics snapshots are deep copies and reset zeroes every operation", async () => {
    await wireCreateDecisionCutover(CREATE_PARAMS as never,
      (async () => ({ created: true })) as never, { env: OFF });
    const snap = getDecisionCutoverMetrics();
    Object.assign(snap.create, { totalCalls: 999, tsBypass: 999 });
    expect(getDecisionCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, tsBypass: 1 });
    resetDecisionCutoverMetricsForTests();
    const zeroed = getDecisionCutoverMetrics();
    for (const op of DECISION_WIRED_OPERATIONS) {
      expect(zeroed[op]).toMatchObject({ totalCalls: 0, totalDurationMs: 0 });
    }
  });
});

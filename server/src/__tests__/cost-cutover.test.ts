import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  CostCutoverIndeterminateError, getCostSpendSnapshotWithCutover,
  isCostEngineCutoverEnabled, listCostEventsWithCutover,
  recordCostEventWithCutover, summarizeCostWindowWithCutover,
  type CostCutoverCallOpts, type CostCutoverResult,
} from "../services/cost-cutover.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_COST_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-02-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null,
  goal_id: null, heartbeat_run_id: null, billing_code: null, provider: "anthropic",
  biller: "anthropic", billing_type: "metered_api", model: "m", input_tokens: 1,
  cached_input_tokens: 0, output_tokens: 2, cost_cents: 3, occurred_at: T0, created_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: NIL, provider: "anthropic", model: "m", occurred_at: T0,
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, cost_cents: 3,
};
const WINDOW = { company_id: NIL, from: T0, to: T1 };
const LIST = { company_id: NIL, from: T0, to: T1 };
const SNAPSHOT = { company_id: NIL };

type Invoke = (client: PaperworkEngineClient | null, tsFallback: () => Promise<unknown>,
  opts?: CostCutoverCallOpts) => Promise<CostCutoverResult<unknown>>;
const WRITES: { op: string; method: string; params: Readonly<Record<string, unknown>>;
  response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "record_event", method: "cost.record_event", params: RECORD,
    response: { recorded: true, event: EVENT }, result: { recorded: true, event: EVENT },
    invoke: (c, f, o) => recordCostEventWithCutover(c, RECORD, f as never, o) },
];
const READS: { op: string; method: string; response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "list_events", method: "cost.list_events",
    response: { events: [EVENT] }, result: { events: [EVENT] },
    invoke: (c, f, o) => listCostEventsWithCutover(c, LIST, f as never, o) },
  { op: "summarize_window", method: "cost.summarize_window",
    response: { spend_cents: 7 }, result: { spend_cents: 7 },
    invoke: (c, f, o) => summarizeCostWindowWithCutover(c, WINDOW, f as never, o) },
  { op: "get_spend_snapshot", method: "cost.get_spend_snapshot",
    response: { found: false }, result: { found: false },
    invoke: (c, f, o) => getCostSpendSnapshotWithCutover(c, SNAPSHOT, f as never, o) },
];

/** PaperworkEngineClient stub: records calls (incl. callOpts) and runs a script. */
function stub(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `e${code}`, code);
const timeoutOf = (c: { callOpts: unknown }) => (c.callOpts as { timeoutMs: number }).timeoutMs;

describe("isCostEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isCostEngineCutoverEnabled({ PAPERWORK_RUST_COST_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isCostEngineCutoverEnabled({ PAPERWORK_RUST_COST_CUTOVER: v })).toBe(false);
    }
    expect(isCostEngineCutoverEnabled({})).toBe(false);
  });
});

describe("cost write cutover", () => {
  it.each(WRITES)("$op: flag OFF and null client bypass with zero RPC", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it.each(WRITES)("$op: flag ON uses the engine once with snake_case params and write timeout", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: op.method, params: op.params, callOpts: { timeoutMs: expect.any(Number) },
    }]);
    expect(timeoutOf(calls[0])).toBe(17_000);
  });
  it("record_event forwards optional fields and serializes Date occurred_at", async () => {
    const { client, calls } = stub(() => ({ recorded: false }));
    const params = {
      ...RECORD, occurred_at: new Date(T0), issue_id: NIL, project_id: NIL,
      goal_id: NIL, heartbeat_run_id: NIL, billing_code: "B1", biller: "x",
      billing_type: "credits" as const,
    };
    await expect(recordCostEventWithCutover(client, params, vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "rust", value: { recorded: false } });
    expect(calls[0].params).toMatchObject({
      occurred_at: "2026-01-01T00:00:00.000Z", issue_id: NIL, project_id: NIL, goal_id: NIL,
      heartbeat_run_id: NIL, billing_code: "B1", biller: "x", billing_type: "credits",
    });
  });
  it("{recorded:false} is a normal engine result, returned without fallback", async () => {
    const { client, calls } = stub(() => ({ recorded: false }));
    const tsFallback = vi.fn();
    await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { recorded: false } });
    expect(calls).toHaveLength(1);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "record_event not_committed rpc %i warns and falls back to TS", async (code) => {
      const { client } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => ({ recorded: false }));
      await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: { recorded: false } });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    });
  it("record_event indeterminate rpc -32005 throws and NEVER calls tsFallback", async () => {
    const { client } = stub(() => { throw rpc(-32005); });
    const tsFallback = vi.fn();
    await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "CostCutoverIndeterminateError", operation: "record_event",
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
    ["pre-send RangeError", new RangeError("not sent")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn();
    await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
      .rejects.toBeInstanceOf(CostCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("engine-ineligible write input throws indeterminate (client RangeError), never TS fallback", async () => {
    const { client, calls } = stub(() => ({ recorded: false }));
    const tsFallback = vi.fn();
    await expect(recordCostEventWithCutover(client,
      { ...RECORD, company_id: "not-a-uuid" }, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "CostCutoverIndeterminateError", operation: "record_event",
      });
    expect(calls).toHaveLength(0);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const err = await recordCostEventWithCutover(client, RECORD, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(CostCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "record_event", cause: error });
  });
  it.each([[1, 17_000], [17_000.5, 17_000], [600_001, 600_000], [undefined, 17_000], [Number.NaN, 17_000]])(
    "writes clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      const { client, calls } = stub(() => ({ recorded: false }));
      await recordCostEventWithCutover(client, RECORD, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
  it("a throwing logger.warn does not mask the not_committed TS fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("pino boom"); });
    try {
      const { client } = stub(() => { throw rpc(-32003); });
      const tsFallback = vi.fn(async () => ({ recorded: false }));
      await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: { recorded: false } });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("cost read cutover", () => {
  it.each(READS)("$op: flag OFF and null client bypass with zero RPC", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it.each(READS)("$op: flag ON returns engine rows with the 10s read timeout", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: op.method, params: expect.any(Object), callOpts: { timeoutMs: 10_000 },
    }]);
  });
  it.each(READS)("$op: ANY engine error warns and falls back to TS", async (op) => {
    for (const error of [
      rpc(-32005), new PaperworkEngineError("timeout", "t"),
      new PaperworkEngineError("protocol_error", "p"), new Error("x"),
    ]) {
      const { client } = stub(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
  });
  it("pre-send validation errors also fall back on reads", async () => {
    const { client } = stub(() => ({ spend_cents: 0 }));
    const tsFallback = vi.fn(async () => ({ spend_cents: 5 }));
    await expect(summarizeCostWindowWithCutover(client,
      { ...WINDOW, to: "2025-01-01T00:00:00Z" }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { spend_cents: 5 } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 1], [10_000.9, 10_000], [600_001, 600_000], [undefined, 10_000], ["x" as never, 10_000]])(
    "reads clamp timeoutMs %s to %s", async (ms, want) => {
      const { client, calls } = stub(() => ({ spend_cents: 0 }));
      await summarizeCostWindowWithCutover(client, WINDOW, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
  it("a throwing logger.warn does not mask the read TS fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("pino boom"); });
    try {
      const { client } = stub(() => { throw rpc(-32005); });
      const tsFallback = vi.fn(async () => ({ spend_cents: 9 }));
      await expect(summarizeCostWindowWithCutover(client, WINDOW, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: { spend_cents: 9 } });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

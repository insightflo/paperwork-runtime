import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  BudgetCutoverIndeterminateError, isBudgetEngineCutoverEnabled,
  listActivePoliciesWithCutover, recordCostEventWithCutover,
  resolveIncidentFencedWithCutover, sumScopeSpendWithCutover,
  upsertIncidentFencedWithCutover,
  type BudgetCutoverCallOpts, type BudgetCutoverResult,
} from "../services/paperwork-engine-budget-cutover.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_BUDGET_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-02-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null,
  goal_id: null, heartbeat_run_id: null, billing_code: null, provider: "anthropic",
  biller: "anthropic", billing_type: "api", model: "m", input_tokens: 1,
  cached_input_tokens: 0, output_tokens: 2, cost_cents: 3, occurred_at: T0, created_at: T0,
};
const INCIDENT = {
  id: NIL, company_id: NIL, policy_id: NIL, scope_type: "company", scope_id: NIL,
  metric: "cost", window_kind: "calendar_month_utc", status: "open",
  window_start: T0, window_end: T1, threshold_type: "soft",
  amount_limit: 100, amount_observed: 50, created_at: T0, updated_at: T0,
  approval_id: null, resolved_at: null,
};
const POLICY = {
  id: NIL, company_id: NIL, scope_type: "company", scope_id: NIL, metric: "cost",
  window_kind: "calendar_month_utc", amount: 100, warn_percent: 80,
  hard_stop_enabled: true, notify_enabled: false, is_active: true,
  created_by_user_id: null, updated_by_user_id: null, created_at: T0, updated_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: NIL, provider: "anthropic", model: "m", occurred_at: T0,
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, cost_cents: 3,
};
const SCOPE = { company_id: NIL, scope_type: "company" as const, scope_id: NIL };
const SUM = { ...SCOPE, window_start: T0, window_end: T1 };
const UPSERT = {
  ...SCOPE, policy_id: NIL, metric: "cost", window_kind: "calendar_month_utc" as const,
  threshold_type: "soft" as const, window_start: T0, window_end: T1,
  amount_limit: 100, amount_observed: 50,
};
const RESOLVE = { incident_id: NIL, company_id: NIL, target_status: "resolved" as const };

type Invoke = (client: PaperworkEngineClient | null, tsFallback: () => Promise<unknown>,
  opts?: BudgetCutoverCallOpts) => Promise<BudgetCutoverResult<unknown>>;
const WRITES: { op: string; method: string; params: Readonly<Record<string, unknown>>;
  response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "record_cost_event", method: "budget.record_cost_event", params: RECORD,
    response: { recorded: true, event: EVENT }, result: { recorded: true, event: EVENT },
    invoke: (c, f, o) => recordCostEventWithCutover(c, RECORD, f as never, o) },
  { op: "upsert_incident_fenced", method: "budget.upsert_incident_fenced", params: UPSERT,
    response: { upserted: true, incident: INCIDENT }, result: { upserted: true, incident: INCIDENT },
    invoke: (c, f, o) => upsertIncidentFencedWithCutover(c, UPSERT, f as never, o) },
  { op: "resolve_incident_fenced", method: "budget.resolve_incident_fenced", params: RESOLVE,
    response: { resolved: true, incident: INCIDENT }, result: { resolved: true, incident: INCIDENT },
    invoke: (c, f, o) => resolveIncidentFencedWithCutover(c, RESOLVE, f as never, o) },
];
const READS: { op: string; method: string; response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "sum_scope_spend", method: "budget.sum_scope_spend",
    response: { observed_cents: 7 }, result: { observed_cents: 7 },
    invoke: (c, f, o) => sumScopeSpendWithCutover(c, SUM, f as never, o) },
  { op: "list_active_policies", method: "budget.list_active_policies",
    response: { policies: [POLICY] }, result: [POLICY],
    invoke: (c, f, o) => listActivePoliciesWithCutover(c, SCOPE, f as never, o) },
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

describe("isBudgetEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isBudgetEngineCutoverEnabled({ PAPERWORK_ENGINE_BUDGET_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isBudgetEngineCutoverEnabled({ PAPERWORK_ENGINE_BUDGET_CUTOVER: v })).toBe(false);
    }
    expect(isBudgetEngineCutoverEnabled({})).toBe(false);
  });
});

describe("budget write cutover", () => {
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
  it("record_cost_event forwards optional fields and serializes Date occurred_at", async () => {
    const { client, calls } = stub(() => ({ recorded: false }));
    const params = {
      ...RECORD, occurred_at: new Date(T0), issue_id: NIL, project_id: NIL,
      goal_id: NIL, heartbeat_run_id: NIL, billing_code: "B1", biller: "x", billing_type: "api",
    };
    await expect(recordCostEventWithCutover(client, params, vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "rust", value: { recorded: false } });
    expect(calls[0].params).toMatchObject({
      occurred_at: "2026-01-01T00:00:00.000Z", issue_id: NIL, project_id: NIL, goal_id: NIL,
      heartbeat_run_id: NIL, billing_code: "B1", biller: "x", billing_type: "api",
    });
  });
  it.each(WRITES)("$op: not_committed rpc warns and falls back to TS once", async (op) => {
    const { client } = stub(() => { throw rpc(-32003); });
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it.each([-32001, -32002, -32004, -32602])(
    "record_cost_event not_committed rpc %i falls back to TS", async (code) => {
      const { client } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => ({ recorded: false }));
      await expect(recordCostEventWithCutover(client, RECORD, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: { recorded: false } });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    });
  it.each(WRITES)("$op: indeterminate rpc -32005 throws and NEVER calls tsFallback", async (op) => {
    const { client } = stub(() => { throw rpc(-32005); });
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "BudgetCutoverIndeterminateError", operation: op.op,
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
    await expect(upsertIncidentFencedWithCutover(client, UPSERT, tsFallback, { env: ON }))
      .rejects.toBeInstanceOf(BudgetCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("engine-ineligible write input throws indeterminate (client RangeError), never TS fallback", async () => {
    const { client, calls } = stub(() => ({ resolved: false }));
    const tsFallback = vi.fn();
    await expect(resolveIncidentFencedWithCutover(client,
      { ...RESOLVE, target_status: "open" }, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "BudgetCutoverIndeterminateError", operation: "resolve_incident_fenced",
      });
    expect(calls).toHaveLength(0);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const err = await resolveIncidentFencedWithCutover(client, RESOLVE, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "resolve_incident_fenced", cause: error });
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

describe("budget read cutover", () => {
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
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t"), new Error("x")]) {
      const { client } = stub(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
  });
  it("pre-send validation errors also fall back on reads", async () => {
    const { client } = stub(() => ({ observed_cents: 0 }));
    const tsFallback = vi.fn(async () => ({ observed_cents: 5 }));
    await expect(sumScopeSpendWithCutover(client, { ...SUM, window_end: T0 }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { observed_cents: 5 } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 1], [10_000.9, 10_000], [600_001, 600_000], [undefined, 10_000], ["x" as never, 10_000]])(
    "reads clamp timeoutMs %s to %s", async (ms, want) => {
      const { client, calls } = stub(() => ({ observed_cents: 0 }));
      await sumScopeSpendWithCutover(client, SUM, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
  it("a throwing logger.warn does not mask the read TS fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("pino boom"); });
    try {
      const { client } = stub(() => { throw rpc(-32005); });
      const tsFallback = vi.fn(async () => ({ observed_cents: 9 }));
      await expect(sumScopeSpendWithCutover(client, SUM, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: { observed_cents: 9 } });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

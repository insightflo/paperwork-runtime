import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  BudgetPolicy, BudgetRecordCostEventResult, BudgetResolveIncidentFencedResult,
  BudgetUpsertIncidentFencedResult,
} from "../services/paperwork-engine-budget.js";
import { BudgetCutoverIndeterminateError } from "../services/paperwork-engine-budget-cutover.js";
import {
  createBudgetCutoverHooks, getBudgetCutoverMetrics, resetBudgetCutoverMetricsForTests,
  wireListActivePoliciesCutover, wireRecordCostEventCutover, wireResolveIncidentFencedCutover,
  wireSumScopeSpendCutover, wireUpsertIncidentFencedCutover,
  type BudgetCutoverResult, type BudgetCutoverTelemetryEvent,
  type BudgetCutoverWiringOpts, type BudgetWiredOperation,
} from "../services/budget-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_BUDGET_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-02-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null, goal_id: null,
  heartbeat_run_id: null, billing_code: null, provider: "anthropic", biller: "anthropic",
  billing_type: "api", model: "m", input_tokens: 1, cached_input_tokens: 0, output_tokens: 2,
  cost_cents: 3, occurred_at: T0, created_at: T0,
};
const INCIDENT = {
  id: NIL, company_id: NIL, policy_id: NIL, scope_type: "company", scope_id: NIL, metric: "cost",
  window_kind: "calendar_month_utc", status: "open", window_start: T0, window_end: T1,
  threshold_type: "soft", amount_limit: 100, amount_observed: 50, created_at: T0, updated_at: T0,
  approval_id: null, resolved_at: null,
};
const POLICY: BudgetPolicy = {
  id: NIL, company_id: NIL, scope_type: "company", scope_id: NIL, metric: "cost",
  window_kind: "calendar_month_utc", amount: 100, warn_percent: 80, hard_stop_enabled: true,
  notify_enabled: false, is_active: true, created_by_user_id: null, updated_by_user_id: null,
  created_at: T0, updated_at: T0,
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
const RECORDED: BudgetRecordCostEventResult = { recorded: true, event: EVENT };
const UPSERTED: BudgetUpsertIncidentFencedResult = { upserted: true, incident: INCIDENT };
const RESOLVED: BudgetResolveIncidentFencedResult = { resolved: true, incident: INCIDENT };

interface OpCase {
  op: BudgetWiredOperation; method: string; response: unknown; result: unknown;
  notApplied?: unknown;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: BudgetCutoverWiringOpts) => Promise<BudgetCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "record_cost_event", method: "budget.record_cost_event", response: RECORDED,
    result: RECORDED, notApplied: { recorded: false },
    invoke: (f, o) => wireRecordCostEventCutover(RECORD, f as never, o) },
  { op: "upsert_incident_fenced", method: "budget.upsert_incident_fenced", response: UPSERTED,
    result: UPSERTED, notApplied: { upserted: false },
    invoke: (f, o) => wireUpsertIncidentFencedCutover(UPSERT, f as never, o) },
  { op: "resolve_incident_fenced", method: "budget.resolve_incident_fenced", response: RESOLVED,
    result: RESOLVED, notApplied: { resolved: false },
    invoke: (f, o) => wireResolveIncidentFencedCutover(RESOLVE, f as never, o) },
  { op: "sum_scope_spend", method: "budget.sum_scope_spend", response: { observed_cents: 7 },
    result: { observed_cents: 7 }, invoke: (f, o) => wireSumScopeSpendCutover(SUM, f as never, o) },
  { op: "list_active_policies", method: "budget.list_active_policies",
    response: { policies: [POLICY] }, result: [POLICY],
    invoke: (f, o) => wireListActivePoliciesCutover(SCOPE, f as never, o) },
];
const WRITES = OPS.slice(0, 3), READS = OPS.slice(3);

function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);
const hostileError = () => Object.defineProperty(new Error("boom"), "stack", { get() { throw new Error("stack-getter-boom"); } });

beforeEach(() => resetBudgetCutoverMetricsForTests());

describe("budget-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_ENGINE_BUDGET_CUTOVER: "0" }, { PAPERWORK_ENGINE_BUDGET_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getBudgetCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    }
    expect(m.record_cost_event.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => RECORDED);
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getBudgetCutoverMetrics().record_cost_event)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const opts = { env: ON, getClient: () => client };
    for (const op of OPS) {
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, opts)).resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(calls.map((c) => c.method)).toEqual(OPS.map((o) => o.method));
    const m = getBudgetCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    }
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => RECORDED);
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getBudgetCutoverMetrics().record_cost_event)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const opts = { env: ON, getClient: () => client };
    for (const op of WRITES) {
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, opts)).rejects.toBeInstanceOf(BudgetCutoverIndeterminateError);
      expect(tsFallback).not.toHaveBeenCalled();
    }
    const m = getBudgetCutoverMetrics();
    for (const op of WRITES) {
      expect(m[op.op]).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    }
  });

  it.each(READS)("flag ON + $op read engine error falls back to tsFallback (never indeterminate)", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t")]) {
      const { client } = stubClient(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
    expect(getBudgetCutoverMetrics()[op.op])
      .toMatchObject({ tsFallback: 2, indeterminateError: 0, rustSuccess: 0 });
  });

  it.each(WRITES)("$op: Rust and TS not-applied results propagate untouched and count fenceMismatch", async (op) => {
    const { client } = stubClient(() => op.notApplied);
    const tsFallback = vi.fn();
    await expect(op.invoke(tsFallback as never, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: op.notApplied });
    expect(tsFallback).not.toHaveBeenCalled();
    await expect(op.invoke(async () => op.notApplied, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: op.notApplied });
    expect(getBudgetCutoverMetrics()[op.op])
      .toMatchObject({ rustSuccess: 1, tsBypass: 1, fenceMismatch: 2, tsFallback: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getBudgetCutoverMetrics().record_cost_event)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ ...RESOLVE, company_id: "not-a-uuid" });
    await expect(wireResolveIncidentFencedCutover(params, async () => RESOLVED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: RESOLVED });
    expect(params).toEqual({ ...RESOLVE, company_id: "not-a-uuid" });
  });

  it("createBudgetCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: BudgetCutoverTelemetryEvent[] = [];
    const hooks = createBudgetCutoverHooks({
      env: ON, getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.recordCostEvent(RECORD, vi.fn())).resolves.toEqual({ source: "rust", value: RECORDED });
    await expect(hooks.resolveIncidentFenced(RESOLVE, vi.fn())).resolves.toEqual({ source: "rust", value: RESOLVED });
    await expect(hooks.sumScopeSpend(SUM, vi.fn())).resolves.toEqual({ source: "rust", value: { observed_cents: 7 } });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.recordCostEvent(RECORD, async () => RECORDED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: RECORDED });
    expect(events).toHaveLength(4);

    const m = hooks.getMetrics();
    expect(m.record_cost_event).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.resolve_incident_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.sum_scope_spend).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getBudgetCutoverMetrics().record_cost_event.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireRecordCostEventCutover(RECORD, async () => RECORDED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: BudgetCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: RECORDED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getBudgetCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireRecordCostEventCutover(RECORD, async () => RECORDED, { env: OFF });
    const snap = getBudgetCutoverMetrics();
    Object.assign(snap.record_cost_event, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.list_active_policies, { totalCalls: 999 });
    const fresh = getBudgetCutoverMetrics();
    expect(fresh.record_cost_event).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.list_active_policies.totalCalls).toBe(0);

    resetBudgetCutoverMetricsForTests();
    const zeroed = getBudgetCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => RECORDED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(BudgetCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getBudgetCutoverMetrics().record_cost_event).toMatchObject({ indeterminateError: 1, tsFallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => RECORDED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireRecordCostEventCutover(RECORD, tsFallback, opts)).resolves.toEqual({ source: "ts", value: RECORDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getBudgetCutoverMetrics().record_cost_event).toMatchObject({ tsBypass: 1 });
  });
});

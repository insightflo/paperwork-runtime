import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyBudgetRpcError, evaluateBudgetThreshold, listActiveBudgetPolicies,
  recordBudgetCostEvent, resolveBudgetIncidentFenced, sumBudgetScopeSpend,
  upsertBudgetIncidentFenced, utcBudgetMonthWindow,
} from "../services/paperwork-engine-budget.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null, goal_id: null,
  heartbeat_run_id: null, billing_code: null, provider: "openai", biller: "openai",
  billing_type: "api", model: "gpt", input_tokens: 1, cached_input_tokens: 0,
  output_tokens: 1, cost_cents: 5, occurred_at: T0, created_at: T0,
};
const POLICY = {
  id: NIL, company_id: NIL, scope_type: "company", scope_id: NIL, metric: "billed_cents",
  window_kind: "lifetime", amount: 100, warn_percent: 80, hard_stop_enabled: true,
  notify_enabled: false, is_active: true, created_by_user_id: null,
  updated_by_user_id: null, created_at: T0, updated_at: T0,
};
const INCIDENT = {
  id: NIL, company_id: NIL, policy_id: NIL, scope_type: "agent", scope_id: NIL,
  metric: "billed_cents", window_kind: "calendar_month_utc", window_start: T0, window_end: T1,
  threshold_type: "hard", amount_limit: 100, amount_observed: 150, status: "open",
  approval_id: null, resolved_at: null, created_at: T0, updated_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: NIL, provider: "openai", model: "gpt",
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cost_cents: 5, occurred_at: T0,
};
const EVAL = { limit_cents: 1000, observed_cents: 800, warn_percent: 80, hard_stop_enabled: true };
const SCOPE = { company_id: NIL, scope_type: "agent", scope_id: NIL } as const;
const SUM = { ...SCOPE, window_start: T0, window_end: T1 };
const UPSERT = {
  ...SCOPE, policy_id: NIL, metric: "billed_cents", window_kind: "lifetime",
  window_start: T0, window_end: T1, threshold_type: "hard", amount_limit: 100, amount_observed: 150,
} as const;
const RESOLVE = { incident_id: NIL, company_id: NIL, target_status: "resolved" } as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("budget.* typed RPC methods", () => {
  it("evaluateBudgetThreshold maps the threshold union; params + callOpts pass through", async () => {
    for (const r of [{ threshold: "soft" }, { threshold: "hard" }, { threshold: null }] as const) {
      const { client } = stub({ "budget.evaluate_threshold": r });
      await expect(evaluateBudgetThreshold(client, EVAL)).resolves.toEqual(r);
    }
    const { client, calls } = stub({ "budget.evaluate_threshold": { threshold: "soft" } });
    await evaluateBudgetThreshold(client, { ...EVAL, junk: 1 } as never, { timeoutMs: 9 });
    expect(calls[0]).toEqual({ method: "budget.evaluate_threshold", params: EVAL, callOpts: { timeoutMs: 9 } });
  });
  it("evaluateBudgetThreshold rejects malformed results and bad params", async () => {
    for (const bad of [null, {}, { threshold: "yes" }, { threshold: 0 }, { threshold: null, x: 1 }]) {
      const { client } = stub({ "budget.evaluate_threshold": bad });
      await expect(evaluateBudgetThreshold(client, EVAL)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const p of [
      { limit_cents: 1.5 }, { observed_cents: "x" }, { warn_percent: 1.5 },
      { warn_percent: 2 ** 31 }, { hard_stop_enabled: "yes" },
    ]) {
      await expect(evaluateBudgetThreshold(s.client, { ...EVAL, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("evaluateBudgetThreshold reads params.hard_stop_enabled once — a getter cannot flip it", async () => {
    const { client, calls } = stub({ "budget.evaluate_threshold": { threshold: null } });
    let reads = 0;
    const flipping = { ...EVAL, get hard_stop_enabled() { return ++reads === 1; } };
    await evaluateBudgetThreshold(client, flipping as never);
    expect(reads).toBe(1);
    expect(calls[0].params).toMatchObject({ hard_stop_enabled: true });
  });
  it("utcBudgetMonthWindow maps the window; Date input serializes to ISO", async () => {
    const W = { window_start: "2026-06-01T00:00:00Z", window_end: "2026-07-01T00:00:00Z" };
    const { client, calls } = stub({ "budget.utc_month_window": W });
    await expect(utcBudgetMonthWindow(client, { now: T0 })).resolves.toEqual(W);
    expect(calls[0]).toEqual({ method: "budget.utc_month_window", params: { now: T0 }, callOpts: undefined });
    const d = stub({ "budget.utc_month_window": W });
    await utcBudgetMonthWindow(d.client, { now: new Date(T0), junk: 0 } as never);
    expect(d.calls[0].params).toEqual({ now: "2026-06-01T00:00:00.000Z" });
    for (const bad of [null, {}, { window_start: T0 }, { ...W, extra: 1 }, { window_start: T0, window_end: "nope" }]) {
      const c = stub({ "budget.utc_month_window": bad });
      await expect(utcBudgetMonthWindow(c.client, { now: T0 })).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const now of [new Date(NaN), "nope", "2026-06-01", 42]) {
      await expect(utcBudgetMonthWindow(s.client, { now: now as never })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("recordBudgetCostEvent sends snake_case wire; optional fields omit/null/value", async () => {
    const { client, calls } = stub({ "budget.record_cost_event": { recorded: true, event: EVENT } });
    await expect(recordBudgetCostEvent(client, { ...RECORD, junk: 1 } as never))
      .resolves.toEqual({ recorded: true, event: EVENT });
    expect(calls[0]).toEqual({ method: "budget.record_cost_event", params: RECORD, callOpts: undefined });
    const n = stub({ "budget.record_cost_event": { recorded: false } });
    await recordBudgetCostEvent(n.client, { ...RECORD, issue_id: null, billing_code: null });
    expect(n.calls[0].params).toEqual({ ...RECORD, issue_id: null, billing_code: null });
    const d = stub({ "budget.record_cost_event": { recorded: false } });
    const opt = {
      issue_id: NIL, project_id: NIL, goal_id: NIL, heartbeat_run_id: NIL,
      billing_code: "bc", biller: "b", billing_type: "api",
    };
    await recordBudgetCostEvent(d.client, { ...RECORD, ...opt, occurred_at: new Date(T0) });
    expect(d.calls[0].params).toEqual({ ...RECORD, ...opt, occurred_at: "2026-06-01T00:00:00.000Z" });
  });
  it("recordBudgetCostEvent validates the result union and event row", async () => {
    const s = stub({ "budget.record_cost_event": { recorded: false } });
    await expect(recordBudgetCostEvent(s.client, RECORD)).resolves.toEqual({ recorded: false });
    for (const bad of [null, {}, { recorded: "y" }, { recorded: false, event: EVENT },
      { recorded: true }, { recorded: false, x: 1 }, { recorded: true, event: null },
      { recorded: true, event: { ...EVENT, id: "z" } }, { recorded: true, event: { ...EVENT, extra: 1 } },
      { recorded: true, event: { ...EVENT, cost_cents: 1.5 } }, { recorded: true, event: { ...EVENT, biller: null } },
      { recorded: true, event: { ...EVENT, billing_code: 5 } },
      { recorded: true, event: { ...EVENT, occurred_at: "2026-02-30T00:00:00Z" } }]) {
      const c = stub({ "budget.record_cost_event": bad });
      await expect(recordBudgetCostEvent(c.client, RECORD)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("recordBudgetCostEvent gates params before any RPC", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { agent_id: 1 }, { provider: 7 }, { model: null },
      { input_tokens: 1.5 }, { cached_input_tokens: 2 ** 31 },
      { cost_cents: -1 }, { cost_cents: 2 ** 31 }, { occurred_at: "soon" },
      { issue_id: "x" }, { project_id: 5 }, { goal_id: {} }, { heartbeat_run_id: 0 },
      { billing_code: 5 }, { biller: 1 }, { billing_type: {} },
    ]) {
      await expect(recordBudgetCostEvent(s.client, { ...RECORD, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("sumBudgetScopeSpend maps observed_cents; enforces company-scope symmetry", async () => {
    const { client, calls } = stub({ "budget.sum_scope_spend": { observed_cents: 42 } });
    await expect(sumBudgetScopeSpend(client, { ...SUM, junk: 0 } as never)).resolves.toEqual({ observed_cents: 42 });
    expect(calls[0]).toEqual({ method: "budget.sum_scope_spend", params: SUM, callOpts: undefined });
    const s = stub({ "budget.sum_scope_spend": { observed_cents: 0 } });
    const go = (p: Record<string, unknown>) => sumBudgetScopeSpend(s.client, { ...SUM, ...p } as never);
    // budget.rs: company scope requires scope_id == company_id
    await expect(go({ scope_type: "company", scope_id: U1 })).rejects.toThrow(RangeError);
    await expect(go({ scope_type: "company" })).resolves.toEqual({ observed_cents: 0 });
    // window must be strictly after at chrono ns precision
    for (const [window_start, window_end] of [
      [T0, T0], [T1, T0],
      ["2026-06-01T00:00:00.000000001Z", "2026-06-01T00:00:00.000000000Z"],
      ["2026-06-01T01:00:00+01:00", "2026-06-01T00:00:00Z"],
    ]) await expect(go({ window_start, window_end })).rejects.toThrow(RangeError);
    // +1 ns is strictly after; Date.parse alone would call it equal
    await expect(go({
      window_start: "2026-06-01T00:00:00.000000000Z", window_end: "2026-06-01T00:00:00.000000001Z",
    })).resolves.toEqual({ observed_cents: 0 });
    for (const p of [{ scope_type: "tenant" }, { scope_id: "z" }, { company_id: 5 }, { window_start: "x" }]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(2);
    for (const bad of [null, {}, { observed_cents: 1.5 }, { observed_cents: "4" },
      { observed_cents: 2 ** 53 }, { observed_cents: 1, x: 2 }]) {
      const c = stub({ "budget.sum_scope_spend": bad });
      await expect(sumBudgetScopeSpend(c.client, SUM)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listActiveBudgetPolicies unwraps policies; validates rows and params", async () => {
    const co = { ...SCOPE, scope_type: "company" } as const;
    const { client, calls } = stub({ "budget.list_active_policies": { policies: [POLICY] } });
    await expect(listActiveBudgetPolicies(client, co)).resolves.toEqual([POLICY]);
    expect(calls[0]).toEqual({ method: "budget.list_active_policies", params: co, callOpts: undefined });
    const e = stub({ "budget.list_active_policies": { policies: [] } });
    await expect(listActiveBudgetPolicies(e.client, SCOPE)).resolves.toEqual([]);
    for (const bad of [null, {}, { policies: "x" }, { policies: [POLICY], x: 1 },
      { policies: [{ ...POLICY, scope_type: "tenant" }] }, { policies: [{ ...POLICY, amount: 1.5 }] },
      { policies: [{ ...POLICY, is_active: "y" }] }, { policies: [{ ...POLICY, extra: 1 }] },
      { policies: [{ ...POLICY, created_by_user_id: 5 }] },
      { policies: [{ ...POLICY, created_at: "2026-01-01T24:00:00Z" }] }]) {
      const c = stub({ "budget.list_active_policies": bad });
      await expect(listActiveBudgetPolicies(c.client, SCOPE)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const p of [{ scope_type: "bogus" }, { scope_id: 3 }, { company_id: "z" }]) {
      await expect(listActiveBudgetPolicies(s.client, { ...SCOPE, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("upsertBudgetIncidentFenced maps the union; approval_id omits/null/value", async () => {
    const { client, calls } = stub({ "budget.upsert_incident_fenced": { upserted: true, incident: INCIDENT } });
    await expect(upsertBudgetIncidentFenced(client, { ...UPSERT, junk: 1 } as never))
      .resolves.toEqual({ upserted: true, incident: INCIDENT });
    expect(calls[0]).toEqual({ method: "budget.upsert_incident_fenced", params: UPSERT, callOpts: undefined });
    const n = stub({ "budget.upsert_incident_fenced": { upserted: false } });
    await expect(upsertBudgetIncidentFenced(n.client, { ...UPSERT, approval_id: null }))
      .resolves.toEqual({ upserted: false });
    expect(n.calls[0].params).toEqual({ ...UPSERT, approval_id: null });
    const a = stub({ "budget.upsert_incident_fenced": { upserted: false } });
    await upsertBudgetIncidentFenced(a.client, { ...UPSERT, approval_id: NIL });
    expect(a.calls[0].params).toEqual({ ...UPSERT, approval_id: NIL });
  });
  it("upsertBudgetIncidentFenced gates window+cents and validates results", async () => {
    const s = stub({});
    const go = (p: Record<string, unknown>) => upsertBudgetIncidentFenced(s.client, { ...UPSERT, ...p } as never);
    for (const p of [
      { window_end: T0 }, { window_start: T1 }, // window_end <= window_start
      { amount_limit: -1 }, { amount_observed: -5 }, { amount_limit: 2 ** 31 },
      { policy_id: "x" }, { metric: 4 }, { window_kind: "bogus" }, { threshold_type: "bogus" },
      { scope_type: "tenant" }, { scope_id: "z" }, { approval_id: "z" },
    ]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { upserted: "y" }, { upserted: false, incident: INCIDENT },
      { upserted: true }, { upserted: false, x: 1 },
      { upserted: true, incident: { ...INCIDENT, status: "bogus" } },
      { upserted: true, incident: { ...INCIDENT, resolved_at: 5 } },
      { upserted: true, incident: { ...INCIDENT, amount_limit: 1.5 } }]) {
      const c = stub({ "budget.upsert_incident_fenced": bad });
      await expect(upsertBudgetIncidentFenced(c.client, UPSERT)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("resolveBudgetIncidentFenced blocks the open transition and maps the union", async () => {
    const { client, calls } = stub({ "budget.resolve_incident_fenced": { resolved: true, incident: INCIDENT } });
    await expect(resolveBudgetIncidentFenced(client, { ...RESOLVE, junk: 0 } as never))
      .resolves.toEqual({ resolved: true, incident: INCIDENT });
    expect(calls[0]).toEqual({ method: "budget.resolve_incident_fenced", params: RESOLVE, callOpts: undefined });
    const d = stub({ "budget.resolve_incident_fenced": { resolved: false } });
    await expect(resolveBudgetIncidentFenced(d.client, { ...RESOLVE, target_status: "dismissed" }))
      .resolves.toEqual({ resolved: false });
    expect(d.calls[0].params).toEqual({ ...RESOLVE, target_status: "dismissed" });
    const s = stub({});
    const go = (p: Record<string, unknown>) => resolveBudgetIncidentFenced(s.client, { ...RESOLVE, ...p } as never);
    for (const p of [{ target_status: "open" }, { target_status: "bogus" }, { incident_id: "x" }, { company_id: 1 }]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { resolved: "y" }, { resolved: true }, { resolved: false, incident: INCIDENT },
      { resolved: false, x: 1 }, { resolved: true, incident: { ...INCIDENT, threshold_type: "bogus" } }]) {
      const c = stub({ "budget.resolve_incident_fenced": bad });
      await expect(resolveBudgetIncidentFenced(c.client, RESOLVE)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("rejects RFC3339 fields that Date.parse normalizes but Chrono rejects", async () => {
    const s = stub({});
    for (const now of [
      "2026-06-01T24:00:00Z",      // hour 24 normalizes to the next day
      "2026-06-01T00:60:00Z",      // minute 60
      "2026-06-01T00:00:60Z",      // second 60
      "2026-06-01T00:00:00+24:00", // offset hour 24
      "2026-06-01T00:00:00+05:60", // offset minute 60
    ]) {
      await expect(utcBudgetMonthWindow(s.client, { now })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("rejects Date inputs outside the 4-digit-year RFC3339 range pre-RPC", async () => {
    const s = stub({});
    for (const d of [new Date("+275760-09-13T00:00:00.000Z"), new Date("-000001-01-01T00:00:00.000Z")]) {
      await expect(utcBudgetMonthWindow(s.client, { now: d })).rejects.toThrow(RangeError);
      await expect(sumBudgetScopeSpend(s.client, { ...SUM, window_end: d })).rejects.toThrow(RangeError);
      await expect(recordBudgetCostEvent(s.client, { ...RECORD, occurred_at: d })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("rejects shapes whose required keys are inherited, not own", async () => {
    // An inherited required key plus an unrelated own key preserves the own-key
    // count; exact own-key-set matching must reject every response shape.
    const inh = (p: object, o: object) => Object.assign(Object.create(p), o);
    const { id: _e, ...eventRest } = EVENT;
    const { id: _p, ...polRest } = POLICY;
    const { id: _n, ...incRest } = INCIDENT;
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["budget.evaluate_threshold", inh({ threshold: null }, { extra: 1 }), (c) => evaluateBudgetThreshold(c, EVAL)],
      ["budget.utc_month_window", inh({ window_start: T0 }, { window_end: T1, extra: 1 }),
        (c) => utcBudgetMonthWindow(c, { now: T0 })],
      ["budget.record_cost_event", inh({ recorded: false }, { extra: 1 }), (c) => recordBudgetCostEvent(c, RECORD)],
      ["budget.record_cost_event", { recorded: true, event: inh({ id: NIL }, { ...eventRest, extra: 1 }) },
        (c) => recordBudgetCostEvent(c, RECORD)],
      ["budget.sum_scope_spend", inh({ observed_cents: 1 }, { extra: 1 }), (c) => sumBudgetScopeSpend(c, SUM)],
      ["budget.list_active_policies", inh({ policies: [POLICY] }, { extra: 1 }),
        (c) => listActiveBudgetPolicies(c, SCOPE)],
      ["budget.list_active_policies", { policies: [inh({ id: NIL }, { ...polRest, extra: 1 })] },
        (c) => listActiveBudgetPolicies(c, SCOPE)],
      ["budget.upsert_incident_fenced", inh({ upserted: false }, { extra: 1 }),
        (c) => upsertBudgetIncidentFenced(c, UPSERT)],
      ["budget.upsert_incident_fenced", { upserted: true, incident: inh({ id: NIL }, { ...incRest, extra: 1 }) },
        (c) => upsertBudgetIncidentFenced(c, UPSERT)],
      ["budget.resolve_incident_fenced", inh({ resolved: false }, { extra: 1 }),
        (c) => resolveBudgetIncidentFenced(c, RESOLVE)],
    ];
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyBudgetRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyBudgetRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyBudgetRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyBudgetRpcError(new PaperworkEngineError("rpc_error", "m", -32000))).toEqual(unknown);
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "queue_full"] as const) {
      expect(classifyBudgetRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyBudgetRpcError(e)).toEqual(unknown);
    }
  });
});

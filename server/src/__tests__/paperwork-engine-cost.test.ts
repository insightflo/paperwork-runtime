import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyCostRpcError, getCostSpendSnapshot, listCostEvents,
  recordCostEvent, summarizeCostWindow,
} from "../services/paperwork-engine-cost.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, agent_id: NIL, issue_id: null, project_id: null, goal_id: null,
  heartbeat_run_id: null, billing_code: null, provider: "openai", biller: "openai",
  billing_type: "metered_api", model: "gpt", input_tokens: 1, cached_input_tokens: 0,
  output_tokens: 1, cost_cents: 5, occurred_at: T0, created_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: NIL, provider: "openai", model: "gpt",
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cost_cents: 5, occurred_at: T0,
};
const SNAPSHOT = { found: true, company_id: NIL, budget_monthly_cents: 1000, spent_monthly_cents: 250 };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("cost.* typed RPC methods", () => {
  it("recordCostEvent sends snake_case wire; optional fields omit/null/value", async () => {
    const { client, calls } = stub({ "cost.record_event": { recorded: true, event: EVENT } });
    await expect(recordCostEvent(client, { ...RECORD, junk: 1 } as never))
      .resolves.toEqual({ recorded: true, event: EVENT });
    expect(calls[0]).toEqual({ method: "cost.record_event", params: RECORD, callOpts: undefined });
    const n = stub({ "cost.record_event": { recorded: false } });
    await expect(recordCostEvent(n.client, { ...RECORD, issue_id: null, billing_code: null }))
      .resolves.toEqual({ recorded: false });
    expect(n.calls[0].params).toEqual({ ...RECORD, issue_id: null, billing_code: null });
    const d = stub({ "cost.record_event": { recorded: false } });
    const opt = {
      issue_id: NIL, project_id: NIL, goal_id: NIL, heartbeat_run_id: NIL,
      billing_code: "bc", biller: "b", billing_type: "subscription_overage",
    } as const;
    await recordCostEvent(d.client, { ...RECORD, ...opt, occurred_at: new Date(T0) }, { timeoutMs: 9 });
    expect(d.calls[0]).toEqual({ method: "cost.record_event",
      params: { ...RECORD, ...opt, occurred_at: "2026-06-01T00:00:00.000Z" }, callOpts: { timeoutMs: 9 } });
  });
  it("recordCostEvent validates the result union and event row", async () => {
    for (const bad of [null, {}, { recorded: "y" }, { recorded: false, event: EVENT },
      { recorded: true }, { recorded: false, x: 1 }, { recorded: true, event: null },
      { recorded: true, event: { ...EVENT, id: "z" } }, { recorded: true, event: { ...EVENT, extra: 1 } },
      { recorded: true, event: { ...EVENT, billing_type: "bogus" } },
      { recorded: true, event: { ...EVENT, billing_type: "METERED_API" } },
      { recorded: true, event: { ...EVENT, cost_cents: 1.5 } },
      { recorded: true, event: { ...EVENT, biller: null } },
      { recorded: true, event: { ...EVENT, billing_code: 5 } },
      { recorded: true, event: { ...EVENT, occurred_at: "2026-02-30T00:00:00Z" } }]) {
      const c = stub({ "cost.record_event": bad });
      await expect(recordCostEvent(c.client, RECORD)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("recordCostEvent gates params before any RPC", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { agent_id: 1 }, { provider: 7 }, { provider: "  " },
      { model: null }, { model: "" }, { input_tokens: -1 }, { input_tokens: 1.5 },
      { cached_input_tokens: 2 ** 31 }, { output_tokens: -2 },
      { cost_cents: -1 }, { cost_cents: 2 ** 31 }, { cost_cents: 1.5 }, { occurred_at: "soon" },
      { issue_id: "x" }, { project_id: 5 }, { goal_id: {} }, { heartbeat_run_id: 0 },
      { billing_code: 5 }, { biller: 1 }, { billing_type: "bogus" },
      { billing_type: "api" }, { billing_type: {} },
    ]) {
      await expect(recordCostEvent(s.client, { ...RECORD, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("listCostEvents sends verbatim params; optionals omit/null/Date-normalize", async () => {
    const { client, calls } = stub({ "cost.list_events": { events: [EVENT] } });
    await expect(listCostEvents(client, { company_id: NIL, junk: 1 } as never))
      .resolves.toEqual({ events: [EVENT] });
    expect(calls[0]).toEqual({ method: "cost.list_events", params: { company_id: NIL }, callOpts: undefined });
    const n = stub({ "cost.list_events": { events: [] } });
    // limit ships verbatim; the engine clamps 1..=500 itself.
    await listCostEvents(n.client, { company_id: NIL, agent_id: null, from: null, to: null, limit: 700 });
    expect(n.calls[0].params).toEqual({ company_id: NIL, agent_id: null, from: null, to: null, limit: 700 });
    const d = stub({ "cost.list_events": { events: [] } });
    await listCostEvents(d.client, { company_id: NIL, agent_id: U1, from: new Date(T0), to: new Date(T1) });
    expect(d.calls[0].params).toEqual({ company_id: NIL, agent_id: U1,
      from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
  });
  it("listCostEvents enforces the cost window and validates results", async () => {
    const s = stub({ "cost.list_events": { events: [] } });
    const go = (p: Record<string, unknown>) => listCostEvents(s.client, { company_id: NIL, ...p } as never);
    // validate_cost_window applies to list too; sub-ms ns precision is honored.
    for (const p of [{ from: T1, to: T0 },
      { from: "2026-06-01T00:00:00.000000002Z", to: "2026-06-01T00:00:00.000000001Z" }]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    await expect(go({ from: T0, to: T0 })).resolves.toEqual({ events: [] }); // equal bounds are legal
    await expect(go({ to: T0 })).resolves.toEqual({ events: [] });           // one-sided is legal
    await expect(go({ from: "2026-06-01T00:00:00.000000001Z", to: "2026-06-01T00:00:00.000000002Z" }))
      .resolves.toEqual({ events: [] });
    for (const p of [{ company_id: "x" }, { agent_id: "z" }, { from: "x" }, { to: {} },
      { limit: 1.5 }, { limit: null }]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(3);
    for (const bad of [null, {}, { events: "x" }, { events: [EVENT], x: 1 },
      { events: [{ ...EVENT, billing_type: "bogus" }] }, { events: [{ ...EVENT, extra: 1 }] },
      { events: [{ ...EVENT, agent_id: "z" }] }]) {
      const c = stub({ "cost.list_events": bad });
      await expect(listCostEvents(c.client, { company_id: NIL })).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("summarizeCostWindow gates the window and maps spend_cents", async () => {
    const { client, calls } = stub({ "cost.summarize_window": { spend_cents: 42 } });
    await expect(summarizeCostWindow(client, { company_id: NIL, junk: 0 } as never))
      .resolves.toEqual({ spend_cents: 42 });
    expect(calls[0]).toEqual({ method: "cost.summarize_window", params: { company_id: NIL }, callOpts: undefined });
    const s = stub({ "cost.summarize_window": { spend_cents: 0 } });
    const go = (p: Record<string, unknown>) => summarizeCostWindow(s.client, { company_id: NIL, ...p } as never);
    for (const p of [{ from: T1, to: T0 }, { company_id: "x" }, { from: "x" }, { to: new Date(NaN) }]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const d = stub({ "cost.summarize_window": { spend_cents: 7 } });
    await summarizeCostWindow(d.client,
      { company_id: NIL, from: new Date(T0), to: new Date(T1), agent_id: null } as never);
    expect(d.calls[0].params).toEqual({ company_id: NIL,
      from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }); // unknown keys stay off the wire
    for (const bad of [null, {}, { spend_cents: 1.5 }, { spend_cents: "4" },
      { spend_cents: 2 ** 53 }, { spend_cents: 1, x: 2 }]) {
      const c = stub({ "cost.summarize_window": bad });
      await expect(summarizeCostWindow(c.client, { company_id: NIL })).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("getCostSpendSnapshot maps the found union and validates rows", async () => {
    const { client, calls } = stub({ "cost.get_spend_snapshot": SNAPSHOT });
    await expect(getCostSpendSnapshot(client, { company_id: NIL, junk: 1 } as never))
      .resolves.toEqual(SNAPSHOT);
    expect(calls[0]).toEqual({ method: "cost.get_spend_snapshot", params: { company_id: NIL }, callOpts: undefined });
    const n = stub({ "cost.get_spend_snapshot": { found: false } });
    await expect(getCostSpendSnapshot(n.client, { company_id: NIL })).resolves.toEqual({ found: false });
    const s = stub({});
    for (const p of [{ company_id: "x" }, { company_id: 5 }]) {
      await expect(getCostSpendSnapshot(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { found: "y" }, { found: true }, { found: false, company_id: NIL },
      { found: false, x: 1 }, { ...SNAPSHOT, company_id: "z" }, { ...SNAPSHOT, extra: 1 },
      { ...SNAPSHOT, budget_monthly_cents: 1.5 }, { ...SNAPSHOT, spent_monthly_cents: "x" },
      { ...SNAPSHOT, budget_monthly_cents: 2 ** 31 }]) {
      const c = stub({ "cost.get_spend_snapshot": bad });
      await expect(getCostSpendSnapshot(c.client, { company_id: NIL })).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("rejects Date inputs outside the 4-digit-year RFC3339 range pre-RPC", async () => {
    const s = stub({});
    for (const d of [new Date("+275760-09-13T00:00:00.000Z"), new Date("-000001-01-01T00:00:00.000Z")]) {
      await expect(recordCostEvent(s.client, { ...RECORD, occurred_at: d })).rejects.toThrow(RangeError);
      await expect(listCostEvents(s.client, { company_id: NIL, from: d })).rejects.toThrow(RangeError);
      await expect(summarizeCostWindow(s.client, { company_id: NIL, to: d })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("rejects shapes whose required keys are inherited, not own", async () => {
    // An inherited required key plus an unrelated own key preserves the own-key
    // count; exact own-key-set matching must reject every response shape.
    const inh = (p: object, o: object) => Object.assign(Object.create(p), o);
    const { id: _e, ...rest } = EVENT;
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["cost.record_event", inh({ recorded: false }, { extra: 1 }), (c) => recordCostEvent(c, RECORD)],
      ["cost.record_event", { recorded: true, event: inh({ id: NIL }, { ...rest, extra: 1 }) },
        (c) => recordCostEvent(c, RECORD)],
      ["cost.list_events", inh({ events: [] }, { extra: 1 }), (c) => listCostEvents(c, { company_id: NIL })],
      ["cost.list_events", { events: [inh({ id: NIL }, { ...rest, extra: 1 })] },
        (c) => listCostEvents(c, { company_id: NIL })],
      ["cost.summarize_window", inh({ spend_cents: 1 }, { extra: 1 }),
        (c) => summarizeCostWindow(c, { company_id: NIL })],
      ["cost.get_spend_snapshot", inh({ found: false }, { extra: 1 }),
        (c) => getCostSpendSnapshot(c, { company_id: NIL })],
      ["cost.get_spend_snapshot",
        inh({ company_id: NIL }, { found: true, budget_monthly_cents: 1, spent_monthly_cents: 2, extra: 1 }),
        (c) => getCostSpendSnapshot(c, { company_id: NIL })],
    ];
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyCostRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyCostRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyCostRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyCostRpcError(new PaperworkEngineError("rpc_error", "m", 32005.5))).toEqual(unknown);
    expect(classifyCostRpcError(new PaperworkEngineError("timeout", "m"))).toEqual(unknown);
    expect(classifyCostRpcError(new Error("x"))).toEqual(unknown);
    expect(classifyCostRpcError(null)).toEqual(unknown);
  });
});

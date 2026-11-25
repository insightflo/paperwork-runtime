import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  cancelDecision, classifyDecisionRpcError, createDecision, getDecisionById,
  getDecisionByRequestKey, listDecisions, resolveDecision,
} from "../services/paperwork-engine-decision.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z";
const ROW = {
  id: NIL, company_id: U1, quality_action_id: null, quality_binding: null,
  request_key: "rk", request_hash: "rh", schema_version: 1, status: "pending",
  priority: "medium", interaction_type: "single_select", title: "t", description: "d",
  source_type: "test", source_id: "s", source_context: {}, issue_id: null,
  requested_by_agent_id: null, requested_by_user_id: null, definition: {}, result: null,
  resolved_by_user_id: null, resolved_at: null, cancelled_at: null,
  continuation_mode: "none", created_at: T0, updated_at: T0,
};
const CREATE = {
  company_id: U1, request_key: "rk", request_hash: "rh", priority: "medium",
  interaction_type: "single_select", title: "t", description: "d", source_type: "test",
  source_id: "s", source_context: {}, definition: {}, continuation_mode: "none",
} as const;
const RESOLVE = { decision_id: NIL, company_id: U1, result: {}, resolved_by_user_id: "user" } as const;
const CANCEL = { decision_id: NIL, company_id: U1 } as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
/** Pre-I/O gate proof: any client.call means the gate failed open. */
function throwingClient(): PaperworkEngineClient {
  return { call: async () => { throw new Error("unexpected client.call"); } } as unknown as PaperworkEngineClient;
}
const omitKey = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("decision.* typed RPC methods", () => {
  it("listDecisions sends exact wire params, unwraps decisions, and passes callOpts", async () => {
    const { client, calls } = stub({ "decision.list": { decisions: [ROW] } });
    await expect(listDecisions(client, { company_id: U1, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual([ROW]);
    expect(calls[0]).toEqual({ method: "decision.list", params: { company_id: U1 }, callOpts: { timeoutMs: 9 } });
    const filtered = stub({ "decision.list": { decisions: [] } });
    await expect(listDecisions(filtered.client, { company_id: U1, status: "resolved", limit: 200 }))
      .resolves.toEqual([]);
    expect(filtered.calls[0].params).toEqual({ company_id: U1, status: "resolved", limit: 200 });
  });

  it("listDecisions validates result rows exactly and gates invalid params before RPC", async () => {
    for (const bad of [null, {}, { decisions: "x" }, { decisions: [ROW], x: 1 },
      { decisions: [omitKey(ROW, "id")] }, { decisions: [{ ...ROW, extra: 1 }] },
      { decisions: [{ ...ROW, status: "open" }] }, { decisions: [{ ...ROW, priority: "urgent" }] },
      { decisions: [{ ...ROW, interaction_type: "checkbox" }] }, { decisions: [{ ...ROW, continuation_mode: "always" }] },
      { decisions: [{ ...ROW, id: "bad" }] }, { decisions: [{ ...ROW, schema_version: 1.5 }] },
      { decisions: [{ ...ROW, quality_action_id: "bad" }] }, { decisions: [{ ...ROW, created_at: "2026-02-30T00:00:00Z" }] },
      { decisions: [{ ...ROW, updated_at: "2026-06-01T24:00:00Z" }] }]) {
      const c = stub({ "decision.list": bad });
      await expect(listDecisions(c.client, { company_id: U1, limit: 1 })).rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const p of [
      { company_id: "no" }, { limit: 0 }, { limit: 201 }, { limit: -5 }, { limit: 1.5 }, { status: "open" },
    ]) {
      await expect(listDecisions(throwingClient(), { company_id: U1, ...p } as never)).rejects.toThrow(RangeError);
    }
  });

  it("getDecisionById and getDecisionByRequestKey map rows and null passthrough", async () => {
    const byId = stub({ "decision.get_by_id": { decision: ROW } });
    await expect(getDecisionById(byId.client, { decision_id: NIL, company_id: U1, junk: 0 } as never))
      .resolves.toEqual({ decision: ROW });
    expect(byId.calls[0]).toEqual({
      method: "decision.get_by_id", params: { decision_id: NIL, company_id: U1 }, callOpts: undefined,
    });
    const missing = stub({ "decision.get_by_id": { decision: null } });
    await expect(getDecisionById(missing.client, { decision_id: NIL, company_id: U1 })).resolves.toEqual({ decision: null });
    const byKey = stub({ "decision.get_by_request_key": { decision: ROW } });
    await expect(getDecisionByRequestKey(byKey.client, { company_id: U1, request_key: "rk" }))
      .resolves.toEqual({ decision: ROW });
    expect(byKey.calls[0].params).toEqual({ company_id: U1, request_key: "rk" });
    const absent = stub({ "decision.get_by_request_key": { decision: null } });
    await expect(getDecisionByRequestKey(absent.client, { company_id: U1, request_key: "none" }))
      .resolves.toEqual({ decision: null });
  });

  it("get methods reject malformed result envelopes and fail closed before RPC", async () => {
    for (const bad of [null, {}, { decision: ROW, x: 1 }, { decision: "x" }, { decision: omitKey(ROW, "status") },
      { decision: { ...ROW, status: "done" } }, { decision: { ...ROW, company_id: "bad" } }]) {
      for (const [method, invoke] of [
        ["decision.get_by_id", (c: PaperworkEngineClient) => getDecisionById(c, { decision_id: NIL, company_id: U1 })],
        ["decision.get_by_request_key", (c: PaperworkEngineClient) => getDecisionByRequestKey(c, { company_id: U1, request_key: "rk" })],
      ] as const) {
        await expect(invoke(stub({ [method]: bad }).client)).rejects.toMatchObject({ code: "protocol_error" });
      }
    }
    for (const p of [{ decision_id: "x" }, { company_id: "x" }]) {
      await expect(getDecisionById(throwingClient(), { decision_id: NIL, company_id: U1, ...p } as never))
        .rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: "x" }, { request_key: "" }, { request_key: "  \t" }]) {
      await expect(getDecisionByRequestKey(throwingClient(), { company_id: U1, request_key: "rk", ...p } as never))
        .rejects.toThrow(RangeError);
    }
  });

  it("createDecision maps created/replayed/conflict unions and exact wire params", async () => {
    const created = stub({ "decision.create": { created: true, decision: ROW } });
    await expect(createDecision(created.client, { ...CREATE, junk: 1 } as never, { timeoutMs: 8 }))
      .resolves.toEqual({ created: true, decision: ROW });
    expect(created.calls[0]).toEqual({ method: "decision.create", params: CREATE, callOpts: { timeoutMs: 8 } });
    const replayed = stub({ "decision.create": { created: false, replayed: true, decision: ROW } });
    await expect(createDecision(replayed.client, CREATE)).resolves.toEqual({ created: false, replayed: true, decision: ROW });
    const conflict = stub({ "decision.create": { created: false, conflict: "request_key" } });
    await expect(createDecision(conflict.client, CREATE)).resolves.toEqual({ created: false, conflict: "request_key" });
    const nullable = stub({ "decision.create": { created: false, conflict: "request_key" } });
    await createDecision(nullable.client, {
      ...CREATE, issue_id: null, requested_by_agent_id: null, requested_by_user_id: null,
      quality_action_id: null, quality_binding: null,
    });
    expect(nullable.calls[0].params).toEqual({
      ...CREATE, issue_id: null, requested_by_agent_id: null, requested_by_user_id: null,
      quality_action_id: null, quality_binding: null,
    });
  });

  it("createDecision validates union key sets and row contents fail-closed", async () => {
    for (const bad of [null, {}, { created: "yes" }, { created: true }, { created: true, decision: ROW, x: 1 },
      { created: false }, { created: false, replayed: true }, { created: false, replayed: false, decision: ROW },
      { created: false, replayed: true, decision: ROW, x: 1 }, { created: false, conflict: "other" },
      { created: false, conflict: "request_key", decision: ROW }, { created: true, decision: null },
      { created: true, decision: omitKey(ROW, "request_key") }, { created: true, decision: { ...ROW, extra: 1 } },
      { created: true, decision: { ...ROW, priority: "mediumish" } },
      { created: true, decision: { ...ROW, resolved_at: "2026-06-01T00:00:60Z" } }]) {
      const c = stub({ "decision.create": bad });
      await expect(createDecision(c.client, CREATE)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });

  it("createDecision mirrors every Rust pre-I/O param gate", async () => {
    for (const p of [
      { company_id: "x" }, { request_key: "" }, { request_key: "   " }, { request_hash: " \t" },
      { title: "" }, { description: "  " }, { source_type: "" }, { source_id: " \n" },
      { priority: "urgent" }, { interaction_type: "multi" }, { continuation_mode: "always" },
      { source_context: [] }, { source_context: "x" }, { source_context: null }, { definition: [] }, { definition: 5 },
      { issue_id: "bad" }, { requested_by_agent_id: "bad" }, { requested_by_user_id: 7 },
      { quality_action_id: "bad" }, { quality_binding: [] }, { quality_binding: "x" }, { quality_binding: 5 },
    ]) {
      await expect(createDecision(throwingClient(), { ...CREATE, ...p } as never)).rejects.toThrow(RangeError);
    }
    await expect(createDecision(throwingClient(), {
      ...CREATE, quality_action_id: NIL, continuation_mode: "issue_current_assignee",
    })).rejects.toThrow(RangeError);
  });

  it("resolveDecision maps both branches, exact null/row decisions, and wire params", async () => {
    const yes = stub({ "decision.resolve": { resolved: true, decision: { ...ROW, status: "resolved" } } });
    await expect(resolveDecision(yes.client, { ...RESOLVE, junk: 1 } as never, { timeoutMs: 7 }))
      .resolves.toEqual({ resolved: true, decision: { ...ROW, status: "resolved" } });
    expect(yes.calls[0]).toEqual({ method: "decision.resolve", params: RESOLVE, callOpts: { timeoutMs: 7 } });
    const noRow = stub({ "decision.resolve": { resolved: false, decision: ROW } });
    await expect(resolveDecision(noRow.client, RESOLVE)).resolves.toEqual({ resolved: false, decision: ROW });
    const noNull = stub({ "decision.resolve": { resolved: false, decision: null } });
    await expect(resolveDecision(noNull.client, RESOLVE)).resolves.toEqual({ resolved: false, decision: null });
    for (const bad of [null, {}, { resolved: "yes" }, { resolved: true }, { resolved: true, decision: ROW, x: 1 },
      { resolved: false }, { resolved: false, decision: "x" }, { resolved: true, decision: null },
      { resolved: true, decision: omitKey(ROW, "updated_at") }, { resolved: true, decision: { ...ROW, result: undefined } }]) {
      const c = stub({ "decision.resolve": bad });
      await expect(resolveDecision(c.client, RESOLVE)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });

  it("resolveDecision gates uuids, result object, and resolved_by_user_id before RPC", async () => {
    for (const p of [
      { decision_id: "x" }, { company_id: "x" }, { result: [] }, { result: "x" }, { result: null },
      { resolved_by_user_id: "" }, { resolved_by_user_id: " \t" },
    ]) {
      await expect(resolveDecision(throwingClient(), { ...RESOLVE, ...p } as never)).rejects.toThrow(RangeError);
    }
  });

  it("cancelDecision maps both branches, validates exact unions, and gates before RPC", async () => {
    const yes = stub({ "decision.cancel": { cancelled: true, decision: { ...ROW, status: "cancelled" } } });
    await expect(cancelDecision(yes.client, { ...CANCEL, junk: 1 } as never, { timeoutMs: 6 }))
      .resolves.toEqual({ cancelled: true, decision: { ...ROW, status: "cancelled" } });
    expect(yes.calls[0]).toEqual({ method: "decision.cancel", params: CANCEL, callOpts: { timeoutMs: 6 } });
    const noRow = stub({ "decision.cancel": { cancelled: false, decision: ROW } });
    await expect(cancelDecision(noRow.client, CANCEL)).resolves.toEqual({ cancelled: false, decision: ROW });
    const noNull = stub({ "decision.cancel": { cancelled: false, decision: null } });
    await expect(cancelDecision(noNull.client, CANCEL)).resolves.toEqual({ cancelled: false, decision: null });
    for (const bad of [null, {}, { cancelled: "yes" }, { cancelled: true }, { cancelled: false },
      { cancelled: true, decision: ROW, x: 1 }, { cancelled: false, decision: "x" }, { cancelled: true, decision: null },
      { cancelled: true, decision: omitKey(ROW, "created_at") }, { cancelled: true, decision: { ...ROW, extra: 1 } }]) {
      const c = stub({ "decision.cancel": bad });
      await expect(cancelDecision(c.client, CANCEL)).rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const p of [{ decision_id: "x" }, { company_id: "x" }]) {
      await expect(cancelDecision(throwingClient(), { ...CANCEL, ...p } as never)).rejects.toThrow(RangeError);
    }
  });

  it("rejects inherited required keys even when the own-key count matches", async () => {
    const inherited = Object.assign(Object.create({ decision: null }), { extra: 1 });
    const c = stub({ "decision.get_by_id": inherited });
    await expect(getDecisionById(c.client, { decision_id: NIL, company_id: U1 }))
      .rejects.toMatchObject({ code: "protocol_error" });
  });
});

describe("classifyDecisionRpcError", () => {
  it("passes through the heartbeat RPC commit classification", () => {
    expect(classifyDecisionRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyDecisionRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    expect(classifyDecisionRpcError(new PaperworkEngineError("rpc_error", "m", -32601)))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
    expect(classifyDecisionRpcError(new PaperworkEngineError("protocol_error", "m")))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
  });
});

import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  appendActivityEvent, classifyActivityRpcError, listActivityEvents,
  listOperatorDecisions, resolveOperatorDecisionFenced,
} from "../services/paperwork-engine-activity.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-06-02T00:00:00Z";
const EVENT = {
  id: NIL, company_id: NIL, actor_type: "agent", actor_id: "a1", action: "issue.updated",
  entity_type: "issue", entity_id: "I-1", agent_id: U1, run_id: null,
  details: { k: 1 }, created_at: T0,
};
const DECISION = {
  id: NIL, company_id: NIL, quality_action_id: null, quality_binding: null,
  request_key: "k1", request_hash: "h1", schema_version: 1, status: "pending",
  priority: "medium", interaction_type: "action", title: "t", description: "d",
  source_type: "test", source_id: "s1", source_context: {}, issue_id: null,
  requested_by_agent_id: U1, requested_by_user_id: null, definition: { x: 1 },
  result: null, resolved_by_user_id: null, resolved_at: null, cancelled_at: null,
  continuation_mode: "resume", created_at: T0, updated_at: T0,
};
const APPEND = {
  company_id: NIL, actor_type: "agent", actor_id: "a1", action: "issue.updated",
  entity_type: "issue", entity_id: "I-1",
} as const;
const LIST = { company_id: NIL, limit: 10 } as const;
const RESOLVE = {
  operator_decision_id: NIL, company_id: NIL, resolved_by_user_id: "u1",
  result: { outcome: "approve" },
} as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("activity.* typed RPC methods", () => {
  it("appendActivityEvent sends snake_case wire; optional fields omit/null/value", async () => {
    const { client, calls } = stub({ "activity.append_event": { event: EVENT } });
    await expect(appendActivityEvent(client, { ...APPEND, junk: 1 } as never))
      .resolves.toEqual({ event: EVENT });
    expect(calls[0]).toEqual({ method: "activity.append_event", params: APPEND, callOpts: undefined });
    const n = stub({ "activity.append_event": { event: EVENT } });
    await appendActivityEvent(n.client, { ...APPEND, agent_id: null, run_id: null, details: null });
    expect(n.calls[0].params).toEqual({ ...APPEND, agent_id: null, run_id: null, details: null });
    const d = stub({ "activity.append_event": { event: EVENT } });
    const opt = { agent_id: U1, run_id: U2, details: { k: 1 } };
    await appendActivityEvent(d.client, { ...APPEND, ...opt }, { timeoutMs: 9 });
    expect(d.calls[0]).toEqual({
      method: "activity.append_event", params: { ...APPEND, ...opt }, callOpts: { timeoutMs: 9 },
    });
  });
  it("appendActivityEvent gates params before any RPC", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { actor_type: "ghost" }, { actor_type: 5 },
      { actor_id: " " }, { actor_id: 1 }, { action: "" }, { action: "\t" },
      { entity_type: "  " }, { entity_id: "" }, { entity_id: null },
      { agent_id: "x" }, { run_id: 5 }, { details: [1] }, { details: "s" }, { details: 5 },
    ]) {
      await expect(appendActivityEvent(s.client, { ...APPEND, ...p } as never)).rejects.toThrow(RangeError);
    }
    // Missing required keys become undefined and fail the same pre-RPC gate.
    const { entity_id: _e, ...missing } = APPEND;
    await expect(appendActivityEvent(s.client, missing as never)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("appendActivityEvent validates the result envelope and event row", async () => {
    for (const bad of [null, {}, { event: EVENT, x: 1 }, { event: null }, { event: [EVENT] },
      { event: { ...EVENT, id: "z" } }, { event: { ...EVENT, extra: 1 } },
      { event: { ...EVENT, actor_type: "ghost" } }, { event: { ...EVENT, agent_id: "x" } },
      { event: { ...EVENT, actor_id: null } }, { event: { ...EVENT, details: [1] } },
      { event: { ...EVENT, created_at: "nope" } }]) {
      const c = stub({ "activity.append_event": bad });
      await expect(appendActivityEvent(c.client, APPEND)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listActivityEvents maps events; optional filters omit/null/value, limit sent verbatim", async () => {
    const { client, calls } = stub({ "activity.list_events": { events: [EVENT] } });
    await expect(listActivityEvents(client, { ...LIST, junk: 1 } as never))
      .resolves.toEqual({ events: [EVENT] });
    expect(calls[0]).toEqual({ method: "activity.list_events", params: LIST, callOpts: undefined });
    const e = stub({ "activity.list_events": { events: [] } });
    await expect(listActivityEvents(e.client, LIST)).resolves.toEqual({ events: [] });
    const f = stub({ "activity.list_events": { events: [] } });
    await listActivityEvents(f.client, { ...LIST, agent_id: U1, entity_type: "issue", entity_id: "I-1" });
    expect(f.calls[0].params).toEqual({ ...LIST, agent_id: U1, entity_type: "issue", entity_id: "I-1" });
    const n = stub({ "activity.list_events": { events: [] } });
    await listActivityEvents(n.client, { ...LIST, agent_id: null, entity_type: null, entity_id: null });
    expect(n.calls[0].params).toEqual({ ...LIST, agent_id: null, entity_type: null, entity_id: null });
    // clamp_list_limit is engine-side: 0 and negatives go over the wire unchanged.
    const z = stub({ "activity.list_events": { events: [] } });
    await listActivityEvents(z.client, { ...LIST, limit: 0 });
    await listActivityEvents(z.client, { ...LIST, limit: -9 });
    expect(z.calls[0].params).toEqual({ ...LIST, limit: 0 });
    expect(z.calls[1].params).toEqual({ ...LIST, limit: -9 });
  });
  it("listActivityEvents gates params and validates rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { limit: 1.5 }, { limit: "10" }, { limit: 2 ** 53 },
      { agent_id: "x" }, { entity_type: 5 }, { entity_id: {} },
    ]) {
      await expect(listActivityEvents(s.client, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
    const { limit: _l, ...missing } = LIST;
    await expect(listActivityEvents(s.client, missing as never)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { events: "x" }, { events: [EVENT], x: 1 },
      { events: [{ ...EVENT, actor_type: "bogus" }] }, { events: [{ ...EVENT, run_id: 0 }] },
      { events: [{ ...EVENT, details: "s" }] },
      { events: [{ ...EVENT, created_at: "2026-01-01T24:00:00Z" }] }]) {
      const c = stub({ "activity.list_events": bad });
      await expect(listActivityEvents(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listOperatorDecisions maps decisions; status omitted vs each of 3 statuses", async () => {
    const { client, calls } = stub({ "activity.list_operator_decisions": { operator_decisions: [DECISION] } });
    await expect(listOperatorDecisions(client, { ...LIST, junk: 1 } as never))
      .resolves.toEqual({ operator_decisions: [DECISION] });
    expect(calls[0]).toEqual({
      method: "activity.list_operator_decisions", params: LIST, callOpts: undefined,
    });
    for (const status of ["pending", "resolved", "cancelled"] as const) {
      const s = stub({ "activity.list_operator_decisions": { operator_decisions: [] } });
      await expect(listOperatorDecisions(s.client, { ...LIST, status }))
        .resolves.toEqual({ operator_decisions: [] });
      expect(s.calls[0].params).toEqual({ ...LIST, status });
    }
    const n = stub({ "activity.list_operator_decisions": { operator_decisions: [] } });
    await listOperatorDecisions(n.client, { ...LIST, status: null });
    expect(n.calls[0].params).toEqual({ ...LIST, status: null });
  });
  it("listOperatorDecisions gates params and validates decision rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { limit: 1.5 }, { status: "bogus" }, { status: 5 },
    ]) {
      await expect(listOperatorDecisions(s.client, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { operator_decisions: "x" }, { operator_decisions: [DECISION], x: 1 },
      { operator_decisions: [{ ...DECISION, status: "bogus" }] },
      { operator_decisions: [{ ...DECISION, schema_version: 1.5 }] },
      { operator_decisions: [{ ...DECISION, schema_version: 2 ** 31 }] },
      { operator_decisions: [{ ...DECISION, source_context: null }] },
      { operator_decisions: [{ ...DECISION, definition: [1] }] },
      { operator_decisions: [{ ...DECISION, result: "s" }] },
      { operator_decisions: [{ ...DECISION, quality_action_id: "x" }] },
      { operator_decisions: [{ ...DECISION, resolved_at: 5 }] },
      { operator_decisions: [{ ...DECISION, extra: 1 }] }]) {
      const c = stub({ "activity.list_operator_decisions": bad });
      await expect(listOperatorDecisions(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("resolveOperatorDecisionFenced maps the union incl. the {updated:false} short result", async () => {
    const resolved = {
      ...DECISION, status: "resolved", result: { outcome: "approve" },
      resolved_by_user_id: "u1", resolved_at: T1,
    };
    const { client, calls } = stub({
      "activity.resolve_operator_decision_fenced": { updated: true, operator_decision: resolved },
    });
    await expect(resolveOperatorDecisionFenced(client, { ...RESOLVE, junk: 1 } as never))
      .resolves.toEqual({ updated: true, operator_decision: resolved });
    expect(calls[0]).toEqual({
      method: "activity.resolve_operator_decision_fenced", params: RESOLVE, callOpts: undefined,
    });
    const f = stub({ "activity.resolve_operator_decision_fenced": { updated: false } });
    await expect(resolveOperatorDecisionFenced(f.client, RESOLVE)).resolves.toEqual({ updated: false });
    expect(f.calls[0].params).toEqual(RESOLVE);
  });
  it("resolveOperatorDecisionFenced gates params and validates results", async () => {
    const s = stub({});
    for (const p of [
      { operator_decision_id: "x" }, { company_id: 1 }, { resolved_by_user_id: "" },
      { resolved_by_user_id: " \t" }, { resolved_by_user_id: 5 },
      { result: null }, { result: [1] }, { result: "s" }, { result: 5 },
    ]) {
      await expect(resolveOperatorDecisionFenced(s.client, { ...RESOLVE, ...p } as never))
        .rejects.toThrow(RangeError);
    }
    const { result: _r, ...missing } = RESOLVE;
    await expect(resolveOperatorDecisionFenced(s.client, missing as never)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { updated: "y" }, { updated: false, operator_decision: DECISION },
      { updated: true }, { updated: false, x: 1 }, { updated: true, operator_decision: null },
      { updated: true, operator_decision: { ...DECISION, status: "bogus" } },
      { updated: true, operator_decision: { ...DECISION, schema_version: "1" } }]) {
      const c = stub({ "activity.resolve_operator_decision_fenced": bad });
      await expect(resolveOperatorDecisionFenced(c.client, RESOLVE))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("rejects shapes whose required keys are inherited, not own", async () => {
    // An inherited required key plus an unrelated own key preserves the own-key
    // count; exact own-key-set matching must reject every response shape.
    const inh = (p: object, o: object) => Object.assign(Object.create(p), o);
    const { id: _e, ...eventRest } = EVENT;
    const { id: _d, ...decRest } = DECISION;
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["activity.append_event", inh({ event: EVENT }, { extra: 1 }), (c) => appendActivityEvent(c, APPEND)],
      ["activity.append_event", { event: inh({ id: NIL }, { ...eventRest, extra: 1 }) },
        (c) => appendActivityEvent(c, APPEND)],
      ["activity.list_events", inh({ events: [] }, { extra: 1 }), (c) => listActivityEvents(c, LIST)],
      ["activity.list_events", { events: [inh({ id: NIL }, { ...eventRest, extra: 1 })] },
        (c) => listActivityEvents(c, LIST)],
      ["activity.list_operator_decisions", inh({ operator_decisions: [] }, { extra: 1 }),
        (c) => listOperatorDecisions(c, LIST)],
      ["activity.list_operator_decisions",
        { operator_decisions: [inh({ id: NIL }, { ...decRest, extra: 1 })] },
        (c) => listOperatorDecisions(c, LIST)],
      ["activity.resolve_operator_decision_fenced", inh({ updated: false }, { extra: 1 }),
        (c) => resolveOperatorDecisionFenced(c, RESOLVE)],
    ];
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyActivityRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyActivityRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyActivityRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyActivityRpcError(new PaperworkEngineError("rpc_error", "m", -32000))).toEqual(unknown);
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "queue_full"] as const) {
      expect(classifyActivityRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyActivityRpcError(e)).toEqual(unknown);
    }
  });
});

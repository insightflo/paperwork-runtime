import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyAgentRpcError, getAgent, listAgentsByCompany, listAgentTaskSessions,
  listAgentToolGrants, transitionAgentStatusFenced,
} from "../services/paperwork-engine-agent.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const AGENT = {
  id: NIL, company_id: NIL, name: "bot", role: "engineer", title: null, icon: null,
  status: "idle", reports_to: null, capabilities: null, adapter_type: "local",
  adapter_config: {}, agent_config: {}, runtime_config: {},
  budget_monthly_cents: 0, spent_monthly_cents: 0, pause_reason: null,
  paused_at: null, permissions: {}, last_heartbeat_at: null, metadata: null,
  created_at: T0, updated_at: T1,
};
const SESSION = {
  id: NIL, company_id: NIL, agent_id: NIL, adapter_type: "local", task_key: "k",
  session_params_json: null, session_display_id: null, last_run_id: null,
  last_error: null, created_at: T0, updated_at: T1,
};
const GRANT = { id: NIL, company_id: NIL, agent_id: NIL, tool_id: U1, granted_by: "u", created_at: T0 };
const GET = { company_id: NIL, agent_id: NIL } as const;
const CO = { company_id: NIL } as const;
const TR = { company_id: NIL, agent_id: NIL, expected_status: "idle", new_status: "paused" } as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("agent.* typed RPC methods", () => {
  it("getAgent maps agent-or-null; exact wire params + callOpts passthrough", async () => {
    const { client, calls } = stub({ "agent.get": { agent: AGENT } });
    await expect(getAgent(client, { ...GET, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual({ agent: AGENT });
    expect(calls[0]).toEqual({ method: "agent.get", params: GET, callOpts: { timeoutMs: 9 } });
    const n = stub({ "agent.get": { agent: null } });
    await expect(getAgent(n.client, GET)).resolves.toEqual({ agent: null });
  });
  it("getAgent gates params before any RPC and validates the result", async () => {
    const s = stub({});
    for (const p of [{ company_id: "no" }, { agent_id: 1 }, { agent_id: "x" }]) {
      await expect(getAgent(s.client, { ...GET, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { agent: AGENT, x: 1 }, { agent: "x" }, { agent: 5 }]) {
      const c = stub({ "agent.get": bad });
      await expect(getAgent(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listAgentsByCompany maps the agents array; validates result", async () => {
    const { client, calls } = stub({ "agent.list_by_company": { agents: [AGENT] } });
    await expect(listAgentsByCompany(client, { ...CO, junk: 0 } as never))
      .resolves.toEqual({ agents: [AGENT] });
    expect(calls[0]).toEqual({ method: "agent.list_by_company", params: CO, callOpts: undefined });
    const e = stub({ "agent.list_by_company": { agents: [] } });
    await expect(listAgentsByCompany(e.client, CO)).resolves.toEqual({ agents: [] });
    const s = stub({});
    await expect(listAgentsByCompany(s.client, { company_id: "z" })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { agents: null }, { agents: "x" }, { agents: [AGENT], x: 1 },
      { agents: [null] }, { agents: [{ ...AGENT, status: "archived" }] }]) {
      const c = stub({ "agent.list_by_company": bad });
      await expect(listAgentsByCompany(c.client, CO)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listAgentTaskSessions omits agent_id when undefined/null, sends it when set", async () => {
    const { client, calls } = stub({ "agent.list_task_sessions": { sessions: [SESSION] } });
    await expect(listAgentTaskSessions(client, CO)).resolves.toEqual({ sessions: [SESSION] });
    expect(calls[0]).toEqual({ method: "agent.list_task_sessions", params: CO, callOpts: undefined });
    for (const agent_id of [undefined, null]) {
      const d = stub({ "agent.list_task_sessions": { sessions: [] } });
      await listAgentTaskSessions(d.client, { ...CO, agent_id } as never);
      expect(d.calls[0].params).toEqual(CO);
    }
    const a = stub({ "agent.list_task_sessions": { sessions: [SESSION] } });
    await listAgentTaskSessions(a.client, { ...CO, agent_id: U1 });
    expect(a.calls[0].params).toEqual({ ...CO, agent_id: U1 });
  });
  it("listAgentTaskSessions gates params and validates rows", async () => {
    const s = stub({});
    for (const p of [{ company_id: "z" }, { agent_id: "z" }, { agent_id: 1 }]) {
      await expect(listAgentTaskSessions(s.client, { ...CO, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const { session_params_json: _p, ...noParams } = SESSION;
    for (const bad of [null, {}, { sessions: null }, { sessions: "x" }, { sessions: [SESSION], x: 1 },
      { sessions: [noParams] }, { sessions: [{ ...SESSION, last_run_id: "no" }] },
      { sessions: [{ ...SESSION, extra: 1 }] }]) {
      const c = stub({ "agent.list_task_sessions": bad });
      await expect(listAgentTaskSessions(c.client, CO)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listAgentToolGrants mirrors the sessions contract", async () => {
    const { client, calls } = stub({ "agent.list_tool_grants": { grants: [GRANT] } });
    await expect(listAgentToolGrants(client, CO)).resolves.toEqual({ grants: [GRANT] });
    expect(calls[0]).toEqual({ method: "agent.list_tool_grants", params: CO, callOpts: undefined });
    for (const agent_id of [undefined, null]) {
      const d = stub({ "agent.list_tool_grants": { grants: [] } });
      await listAgentToolGrants(d.client, { ...CO, agent_id } as never);
      expect(d.calls[0].params).toEqual(CO);
    }
    const a = stub({ "agent.list_tool_grants": { grants: [GRANT] } });
    await listAgentToolGrants(a.client, { ...CO, agent_id: U1 });
    expect(a.calls[0].params).toEqual({ ...CO, agent_id: U1 });
    const s = stub({});
    for (const p of [{ company_id: 5 }, { agent_id: "z" }]) {
      await expect(listAgentToolGrants(s.client, { ...CO, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { grants: null }, { grants: [GRANT], x: 1 },
      { grants: [{ ...GRANT, tool_id: "z" }] }, { grants: [{ ...GRANT, extra: 1 }] }]) {
      const c = stub({ "agent.list_tool_grants": bad });
      await expect(listAgentToolGrants(c.client, CO)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("transitionAgentStatusFenced maps both applied arms; legal transitions hit wire", async () => {
    const { client, calls } = stub({ "agent.transition_status_fenced": { applied: true, agent: AGENT } });
    await expect(transitionAgentStatusFenced(client, { ...TR, junk: 0 } as never, { timeoutMs: 3 }))
      .resolves.toEqual({ applied: true, agent: AGENT });
    expect(calls[0]).toEqual({ method: "agent.transition_status_fenced", params: TR, callOpts: { timeoutMs: 3 } });
    const f = stub({ "agent.transition_status_fenced": { applied: false, reason: "fenced" } });
    await expect(transitionAgentStatusFenced(f.client, TR))
      .resolves.toEqual({ applied: false, reason: "fenced" });
    const t = stub({ "agent.transition_status_fenced": { applied: true, agent: AGENT } });
    await transitionAgentStatusFenced(t.client,
      { ...TR, expected_status: "pending_approval", new_status: "terminated" });
    expect(t.calls[0].params)
      .toEqual({ ...TR, expected_status: "pending_approval", new_status: "terminated" });
  });
  it("transitionAgentStatusFenced pause_reason omits when nullish, sends when set", async () => {
    for (const pause_reason of [undefined, null]) {
      const d = stub({ "agent.transition_status_fenced": { applied: false, reason: "fenced" } });
      await transitionAgentStatusFenced(d.client, { ...TR, pause_reason } as never);
      expect(d.calls[0].params).toEqual(TR);
    }
    const a = stub({ "agent.transition_status_fenced": { applied: true, agent: AGENT } });
    await transitionAgentStatusFenced(a.client, { ...TR, pause_reason: "hold" });
    expect(a.calls[0].params).toEqual({ ...TR, pause_reason: "hold" });
    // Rust has no blank-text gate on pause_reason: "" is a valid wire value.
    const e = stub({ "agent.transition_status_fenced": { applied: true, agent: AGENT } });
    await transitionAgentStatusFenced(e.client, { ...TR, pause_reason: "" });
    expect(e.calls[0].params).toEqual({ ...TR, pause_reason: "" });
  });
  it("transitionAgentStatusFenced gates params + legality matrix before any RPC", async () => {
    const s = stub({});
    const go = (p: Record<string, unknown>) => transitionAgentStatusFenced(s.client, { ...TR, ...p } as never);
    for (const p of [
      { company_id: "no" }, { agent_id: 1 },
      { expected_status: "done" }, { new_status: "bogus" },
      { expected_status: "terminated", new_status: "idle" },
      { expected_status: "paused", new_status: "pending_approval" },
      { expected_status: "pending_approval", new_status: "paused" },
      { expected_status: "idle", new_status: "idle" },
      { expected_status: "running", new_status: "pending_approval" },
      { pause_reason: 5 },
    ]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("transitionAgentStatusFenced validates the applied union exactly", async () => {
    for (const bad of [null, {}, { applied: "y" }, { applied: true }, { applied: false },
      { applied: false, reason: "x" }, { applied: false, reason: "fenced", x: 1 },
      { applied: true, agent: null }, { applied: true, agent: AGENT, x: 1 },
      { applied: true, agent: { ...AGENT, status: "archived" } }]) {
      const c = stub({ "agent.transition_status_fenced": bad });
      await expect(transitionAgentStatusFenced(c.client, TR)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("agent rows reject bad shapes exactly (nullability + enums + i32)", async () => {
    const { metadata: _m, ...noMeta } = AGENT;
    for (const row of [
      { ...AGENT, status: "archived" }, { ...AGENT, capabilities: ["x"] },
      { ...AGENT, reports_to: "not-a-uuid" }, { ...AGENT, budget_monthly_cents: "x" },
      { ...AGENT, spent_monthly_cents: 1.5 }, { ...AGENT, paused_at: "nope" },
      { ...AGENT, adapter_config: undefined }, noMeta, { ...AGENT, extra: 1 },
    ]) {
      const c = stub({ "agent.get": { agent: row } });
      await expect(getAgent(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
    // every non-null Option column also accepts a populated value
    const full = {
      ...AGENT, title: "t", icon: "i", status: "paused", reports_to: U1,
      capabilities: "cap", pause_reason: "p", paused_at: T0, last_heartbeat_at: T1, metadata: { k: 1 },
    };
    const ok = stub({ "agent.get": { agent: full } });
    await expect(getAgent(ok.client, GET)).resolves.toEqual({ agent: full });
  });
});

describe("classifyAgentRpcError", () => {
  it("delegates to the heartbeat commit contract (fail-closed)", () => {
    expect(classifyAgentRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyAgentRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyAgentRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyAgentRpcError(new PaperworkEngineError("timeout", "m"))).toEqual(unknown);
    for (const e of [new Error("x"), "x", null, { rpcCode: -32005 }]) {
      expect(classifyAgentRpcError(e)).toEqual(unknown);
    }
  });
});

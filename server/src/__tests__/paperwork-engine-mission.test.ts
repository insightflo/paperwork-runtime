import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  bumpMissionRollingStateFenced, classifyMissionRpcError, getMission,
  getMissionRollingState, listMissionsByCompany, listMissionSessions,
  MISSION_STATUSES, transitionMissionStatusFenced,
} from "../services/paperwork-engine-mission.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const MISSION = {
  id: NIL, company_id: U1, owner_agent_id: NIL, title: "m", description: null,
  status: "active", goal_id: null, project_id: NIL, source_mission_id: null,
  source_workflow_run_id: null, started_at: T0, completed_at: null, created_at: T0, updated_at: T1,
};
const ROLLING = {
  id: NIL, company_id: U1, mission_id: NIL, revision: 3, status: "fresh",
  state_markdown: "# s", state_json: { a: [1] }, last_run_id: NIL, last_compacted_at: T0,
  total_runs: 2, total_input_tokens: 10, total_output_tokens: 20, total_cost_cents: 30,
  created_at: T0, updated_at: T1,
};
const SESSION = {
  id: NIL, mission_id: NIL, agent_id: U1, company_id: U1, session_secret_id: NIL,
  adapter_type: "claude", status: "active", last_active_at: T0, run_count: 1,
  expires_at: null, created_at: T0,
};
const GET = { mission_id: NIL, company_id: U1 };
const LIST = { company_id: U1, limit: 50 };
const TRANS = { ...GET, expected_status: "planning", next_status: "active" } as const;
const BUMP = { ...GET, expected_revision: 1, state_json: { k: [] }, state_markdown: "md" };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("mission.* typed RPC methods", () => {
  it("getMission maps {mission: Mission|null}; params are exact-key gated", async () => {
    const { client, calls } = stub({ "mission.get": { mission: MISSION } });
    await expect(getMission(client, GET)).resolves.toEqual({ mission: MISSION });
    expect(calls[0]).toEqual({ method: "mission.get", params: GET, callOpts: undefined });
    const n = stub({ "mission.get": { mission: null } });
    await expect(getMission(n.client, GET)).resolves.toEqual({ mission: null });
    const s = stub({});
    for (const p of [{ mission_id: "x" }, { company_id: 1 }, { mission_id: null }]) {
      await expect(getMission(s.client, { ...GET, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ mission_id: NIL }, null, "x", [1], { ...GET, extra: 1 }]) {
      await expect(getMission(s.client, p as never)).rejects.toThrow(RangeError); // missing/extra/non-object
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { mission: "x" }, { mission: {} }, { mission: null, x: 1 },
      { mission: { ...MISSION, status: "bogus" } }, { mission: { ...MISSION, title: null } },
      { mission: { ...MISSION, goal_id: 5 } }, { mission: { ...MISSION, started_at: "soon" } },
      { mission: { ...MISSION, description: 7 } }, { mission: { ...MISSION, extra: 1 } },
      { mission: { id: NIL } }, { mission: { ...MISSION, owner_agent_id: null } }]) {
      const c = stub({ "mission.get": bad });
      await expect(getMission(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listMissionsByCompany omits status / passes each status + null; limit unclamped", async () => {
    const { client, calls } = stub({ "mission.list_by_company": { missions: [MISSION] } });
    await expect(listMissionsByCompany(client, LIST)).resolves.toEqual({ missions: [MISSION] });
    expect(calls[0]).toEqual({ method: "mission.list_by_company", params: LIST, callOpts: undefined });
    const s = stub({ "mission.list_by_company": { missions: [] } });
    for (const status of MISSION_STATUSES) {
      await listMissionsByCompany(s.client, { ...LIST, status });
      expect(s.calls.at(-1)!.params).toEqual({ ...LIST, status });
    }
    await listMissionsByCompany(s.client, { ...LIST, status: null }); // serde Option: null -> None
    expect(s.calls.at(-1)!.params).toEqual({ ...LIST, status: null });
    await listMissionsByCompany(s.client, { ...LIST, limit: 0 }); // engine clamps 1..200, not client
    expect(s.calls.at(-1)!.params).toEqual({ ...LIST, limit: 0 });
  });
  it("listMissionsByCompany gates params and validates mission rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "z" }, { limit: 1.5 }, { limit: "x" }, { limit: 2 ** 53 },
      { status: "bogus" }, { status: 5 },
    ]) {
      await expect(listMissionsByCompany(s.client, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: U1 }, { limit: 1 }, { ...LIST, extra: 1 }]) {
      await expect(listMissionsByCompany(s.client, p as never)).rejects.toThrow(RangeError); // missing/extra key
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { missions: "x" }, { missions: [MISSION], x: 1 },
      { missions: [{ ...MISSION, status: "bogus" }] }, { missions: [{ ...MISSION, extra: 1 }] },
      { missions: [{ ...MISSION, updated_at: 0 }] }, { missions: [null] }]) {
      const c = stub({ "mission.list_by_company": bad });
      await expect(listMissionsByCompany(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("getMissionRollingState maps {rolling_state} null|row and gates params", async () => {
    const { client, calls } = stub({ "mission.get_rolling_state": { rolling_state: ROLLING } });
    await expect(getMissionRollingState(client, GET)).resolves.toEqual({ rolling_state: ROLLING });
    expect(calls[0]).toEqual({ method: "mission.get_rolling_state", params: GET, callOpts: undefined });
    const n = stub({ "mission.get_rolling_state": { rolling_state: null } });
    await expect(getMissionRollingState(n.client, GET)).resolves.toEqual({ rolling_state: null });
    const s = stub({});
    for (const p of [{ mission_id: 0 }, { company_id: "z" }, { mission_id: NIL }, { ...GET, x: 1 }]) {
      await expect(getMissionRollingState(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { rolling_state: 1 }, { rolling_state: null, x: 1 },
      { rolling_state: { ...ROLLING, revision: 1.5 } }, { rolling_state: { ...ROLLING, state_json: undefined } },
      { rolling_state: { ...ROLLING, last_run_id: "x" } }, { rolling_state: { ...ROLLING, extra: 1 } },
      { rolling_state: { ...ROLLING, total_cost_cents: "30" } }, { rolling_state: { ...ROLLING, status: null } }]) {
      const c = stub({ "mission.get_rolling_state": bad });
      await expect(getMissionRollingState(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listMissionSessions maps session rows and gates params", async () => {
    const { client, calls } = stub({ "mission.list_sessions": { sessions: [SESSION] } });
    await expect(listMissionSessions(client, GET)).resolves.toEqual({ sessions: [SESSION] });
    expect(calls[0]).toEqual({ method: "mission.list_sessions", params: GET, callOpts: undefined });
    const e = stub({ "mission.list_sessions": { sessions: [] } });
    await expect(listMissionSessions(e.client, GET)).resolves.toEqual({ sessions: [] });
    const s = stub({});
    for (const p of [{ mission_id: "x" }, { company_id: null }, { company_id: U1 }, { ...GET, x: 1 }]) {
      await expect(listMissionSessions(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { sessions: {} }, { sessions: [SESSION], x: 1 },
      { sessions: [{ ...SESSION, session_secret_id: null }] },
      { sessions: [{ ...SESSION, last_active_at: null }] },
      { sessions: [{ ...SESSION, expires_at: 5 }] }, { sessions: [{ ...SESSION, run_count: "1" }] },
      { sessions: [{ ...SESSION, extra: 1 }] }, { sessions: [{ ...SESSION, adapter_type: null }] }]) {
      const c = stub({ "mission.list_sessions": bad });
      await expect(listMissionSessions(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("transitionMissionStatusFenced maps the applied union; callOpts pass through", async () => {
    const { client, calls } = stub({ "mission.transition_status_fenced": { applied: true, mission: MISSION } });
    await expect(transitionMissionStatusFenced(client, TRANS, { timeoutMs: 9 }))
      .resolves.toEqual({ applied: true, mission: MISSION });
    expect(calls[0]).toEqual({
      method: "mission.transition_status_fenced", params: TRANS, callOpts: { timeoutMs: 9 },
    });
    const d = stub({ "mission.transition_status_fenced": { applied: false } });
    await expect(transitionMissionStatusFenced(d.client, { ...TRANS, next_status: "paused" }))
      .resolves.toEqual({ applied: false });
  });
  it("transitionMissionStatusFenced rejects same-status and bad params pre-RPC", async () => {
    const s = stub({});
    for (const st of MISSION_STATUSES) {
      await expect(transitionMissionStatusFenced(s.client, { ...TRANS, expected_status: st, next_status: st }))
        .rejects.toThrow(RangeError);
    }
    for (const p of [
      { expected_status: "bogus" }, { next_status: "open" }, { expected_status: 1 },
      { mission_id: "x" }, { company_id: {} },
    ]) {
      await expect(transitionMissionStatusFenced(s.client, { ...TRANS, ...p } as never))
        .rejects.toThrow(RangeError);
    }
    for (const p of [{ mission_id: NIL, company_id: U1, expected_status: "planning" }, { ...TRANS, x: 1 }]) {
      await expect(transitionMissionStatusFenced(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { applied: "y" }, { applied: false, mission: MISSION },
      { applied: true }, { applied: false, x: 1 }, { applied: true, mission: null },
      { applied: true, mission: { ...MISSION, status: "open" } }]) {
      const c = stub({ "mission.transition_status_fenced": bad });
      await expect(transitionMissionStatusFenced(c.client, TRANS)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("bumpMissionRollingStateFenced maps the union; state_json passes through", async () => {
    const { client, calls } = stub({ "mission.bump_rolling_state_fenced": { applied: true, rolling_state: ROLLING } });
    await expect(bumpMissionRollingStateFenced(client, BUMP))
      .resolves.toEqual({ applied: true, rolling_state: ROLLING });
    expect(calls[0]).toEqual({
      method: "mission.bump_rolling_state_fenced", params: BUMP, callOpts: undefined,
    });
    const d = stub({ "mission.bump_rolling_state_fenced": { applied: false } });
    await expect(bumpMissionRollingStateFenced(d.client, BUMP)).resolves.toEqual({ applied: false });
    for (const sj of [null, 0, "s", [1], { nested: { v: [true] } }]) { // any JSON value is legal
      const j = stub({ "mission.bump_rolling_state_fenced": { applied: false } });
      await bumpMissionRollingStateFenced(j.client, { ...BUMP, state_json: sj });
      expect(j.calls[0].params).toMatchObject({ state_json: sj });
    }
  });
  it("bumpMissionRollingStateFenced rejects bad revision/params pre-RPC", async () => {
    const s = stub({});
    for (const p of [
      { expected_revision: 0 }, { expected_revision: -1 }, { expected_revision: 1.5 },
      { expected_revision: 2 ** 31 }, { state_json: undefined }, { state_markdown: 5 },
      { mission_id: "x" }, { company_id: null },
    ]) {
      await expect(bumpMissionRollingStateFenced(s.client, { ...BUMP, ...p } as never))
        .rejects.toThrow(RangeError);
    }
    for (const p of [
      { ...BUMP, x: 1 },
      { mission_id: NIL, company_id: U1, expected_revision: 1, state_markdown: "m" }, // missing state_json
    ]) {
      await expect(bumpMissionRollingStateFenced(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { applied: "y" }, { applied: true }, { applied: false, x: 1 },
      { applied: false, rolling_state: ROLLING }, { applied: true, rolling_state: null },
      { applied: true, rolling_state: { ...ROLLING, revision: "2" } }]) {
      const c = stub({ "mission.bump_rolling_state_fenced": bad });
      await expect(bumpMissionRollingStateFenced(c.client, BUMP))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyMissionRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyMissionRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const e of [
      new PaperworkEngineError("rpc_error", "m", -32601),
      new PaperworkEngineError("timeout", "m"), new PaperworkEngineError("protocol_error", "m"),
      new Error("x"), "x", null, undefined, 42,
    ]) {
      expect(classifyMissionRpcError(e)).toEqual(unknown);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type { Mission, MissionRollingState } from "../services/paperwork-engine-mission.js";
import { MissionCutoverIndeterminateError } from "../services/mission-cutover.js";
import {
  createMissionCutoverHooks,
  getMissionCutoverMetrics,
  resetMissionCutoverMetricsForTests,
  wireMissionBumpRollingStateFencedCutover,
  wireMissionGetCutover,
  wireMissionGetRollingStateCutover,
  wireMissionListByCompanyCutover,
  wireMissionListSessionsCutover,
  wireMissionTransitionStatusFencedCutover,
  MISSION_WIRED_OPERATIONS,
  type MissionCutoverTelemetryEvent,
} from "../services/mission-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_MISSION_CUTOVER: "1" };
const OFF = {};
const TS = "2026-01-01T00:00:00Z";
const MISSION: Mission = {
  id: NIL, company_id: NIL, owner_agent_id: NIL, title: "m", description: null,
  status: "active", goal_id: null, project_id: null, source_mission_id: null,
  source_workflow_run_id: null, started_at: TS, completed_at: null,
  created_at: TS, updated_at: TS,
};
const ROLLING: MissionRollingState = {
  id: NIL, company_id: NIL, mission_id: NIL, revision: 1, status: "fresh",
  state_markdown: "md", state_json: {}, last_run_id: null, last_compacted_at: null,
  total_runs: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost_cents: 0,
  created_at: TS, updated_at: TS,
};
const TRANS = {
  mission_id: NIL, company_id: NIL,
  expected_status: "planning" as const, next_status: "active" as const,
};
const BUMP = {
  mission_id: NIL, company_id: NIL,
  expected_revision: 1, state_json: {}, state_markdown: "md",
};
const GET = { mission_id: NIL, company_id: NIL };
const LIST = { company_id: NIL, limit: 10 };
const APPLIED = { applied: true as const, mission: MISSION };
const ROLLED = { applied: true as const, rolling_state: ROLLING };

function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => {
      calls.push({ method, params, callOpts });
      return script(method);
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);
const hostileError = () => Object.defineProperty(new Error("boom"), "stack", { get() { throw new Error("stack-getter-boom"); } });

beforeEach(() => resetMissionCutoverMetricsForTests());

describe("mission-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all six ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_MISSION_CUTOVER: "0" }, { PAPERWORK_RUST_MISSION_CUTOVER: "true" }]) {
      const o = { env, getClient };
      await expect(wireMissionTransitionStatusFencedCutover(TRANS, async () => APPLIED, o)).resolves.toEqual({ source: "ts", value: APPLIED });
      await expect(wireMissionBumpRollingStateFencedCutover(BUMP, async () => ROLLED, o)).resolves.toEqual({ source: "ts", value: ROLLED });
      await expect(wireMissionGetCutover(GET, async () => ({ mission: MISSION }), o)).resolves.toEqual({ source: "ts", value: { mission: MISSION } });
      await expect(wireMissionListByCompanyCutover(LIST, async () => ({ missions: [] }), o)).resolves.toEqual({ source: "ts", value: { missions: [] } });
      await expect(wireMissionGetRollingStateCutover(GET, async () => ({ rolling_state: ROLLING }), o)).resolves.toEqual({ source: "ts", value: { rolling_state: ROLLING } });
      await expect(wireMissionListSessionsCutover(GET, async () => ({ sessions: [] }), o)).resolves.toEqual({ source: "ts", value: { sessions: [] } });
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getMissionCutoverMetrics();
    for (const op of MISSION_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getMissionCutoverMetrics().transition_status_fenced)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustOk", async () => {
    const { client, calls } = stubClient((method) =>
      method === "mission.get" ? { mission: MISSION } : APPLIED);
    const opts = { env: ON, getClient: () => client };
    const tsWrite = vi.fn(async () => ({ applied: false as const }));
    const tsRead = vi.fn(async () => ({ mission: null }));

    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsWrite, opts))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(wireMissionGetCutover(GET, tsRead, opts))
      .resolves.toEqual({ source: "rust", value: { mission: MISSION } });
    expect(tsWrite).not.toHaveBeenCalled();
    expect(tsRead).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["mission.transition_status_fenced", "mission.get"]);
    const m = getMissionCutoverMetrics();
    expect(m.transition_status_fenced).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0, fenceMismatch: 0 });
    expect(m.get).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0 });
  });

  it.each([-32001, -32003])("flag ON + not_committed write rpc %i falls back to tsFallback (fallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => ROLLED);
    await expect(wireMissionBumpRollingStateFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: ROLLED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getMissionCutoverMetrics().bump_rolling_state_fenced)
      .toMatchObject({ fallback: 1, tsBypass: 0, rustOk: 0, indeterminate: 0 });
  });

  it("flag ON + ANY read error (incl. -32005) falls back to TS reader", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => ({ rolling_state: null }));
    await expect(wireMissionGetRollingStateCutover(GET, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: { rolling_state: null } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getMissionCutoverMetrics().get_rolling_state)
      .toMatchObject({ fallback: 1, indeterminate: 0, rustOk: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsTrans = vi.fn(async () => APPLIED);
    const tsBump = vi.fn(async () => ROLLED);
    const opts = { env: ON, getClient: () => client };
    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsTrans, opts))
      .rejects.toBeInstanceOf(MissionCutoverIndeterminateError);
    await expect(wireMissionBumpRollingStateFencedCutover(BUMP, tsBump, opts))
      .rejects.toBeInstanceOf(MissionCutoverIndeterminateError);
    expect(tsTrans).not.toHaveBeenCalled();
    expect(tsBump).not.toHaveBeenCalled();
    const m = getMissionCutoverMetrics();
    expect(m.transition_status_fenced).toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0 });
    expect(m.bump_rolling_state_fenced).toMatchObject({ indeterminate: 1 });
  });

  it("propagates Rust fence mismatch { applied: false } untouched; counts rustOk + fenceMismatch", async () => {
    const { client } = stubClient(() => ({ applied: false }));
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getMissionCutoverMetrics().transition_status_fenced)
      .toMatchObject({ rustOk: 1, fenceMismatch: 1, fallback: 0 });
  });

  it("counts fenceMismatch for TS-originated { applied: false } as well", async () => {
    await expect(wireMissionBumpRollingStateFencedCutover(BUMP, async () => ({ applied: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(getMissionCutoverMetrics().bump_rolling_state_fenced)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustOk: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireMissionListSessionsCutover(GET, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getMissionCutoverMetrics().list_sessions)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ mission_id: "not-a-uuid", company_id: NIL });
    await expect(wireMissionGetCutover(params, async () => ({ mission: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { mission: null } });
    expect(params).toEqual({ mission_id: "not-a-uuid", company_id: NIL });
  });

  it("createMissionCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "mission.list_by_company" ? { missions: [] } : APPLIED);
    const events: MissionCutoverTelemetryEvent[] = [];
    const hooks = createMissionCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.transitionStatusFenced(TRANS, vi.fn(async () => ({ applied: false as const }))))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(hooks.listByCompany(LIST, vi.fn(async () => ({ missions: [MISSION] }))))
      .resolves.toEqual({ source: "rust", value: { missions: [] } });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.get(GET, async () => ({ mission: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { mission: null } });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.transition_status_fenced).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.list_by_company).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.get).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getMissionCutoverMetrics().get.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireMissionGetCutover(GET, async () => ({ mission: null }), {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: MissionCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: { mission: null } });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getMissionCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireMissionGetCutover(GET, async () => ({ mission: null }), { env: OFF });
    const snap = getMissionCutoverMetrics();
    Object.assign(snap.get, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list_sessions, { totalCalls: 999 });
    const fresh = getMissionCutoverMetrics();
    expect(fresh.get).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list_sessions.totalCalls).toBe(0);

    resetMissionCutoverMetricsForTests();
    const zeroed = getMissionCutoverMetrics();
    for (const op of MISSION_WIRED_OPERATIONS) expect(zeroed[op].totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => APPLIED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireMissionTransitionStatusFencedCutover(TRANS, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(MissionCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getMissionCutoverMetrics().transition_status_fenced)
      .toMatchObject({ indeterminate: 1, fallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => ROLLED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireMissionBumpRollingStateFencedCutover(BUMP, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: ROLLED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getMissionCutoverMetrics().bump_rolling_state_fenced).toMatchObject({ tsBypass: 1 });
  });
});

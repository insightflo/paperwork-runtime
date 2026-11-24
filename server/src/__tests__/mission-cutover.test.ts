import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyMissionRpcError, type MissionBumpRollingStateFencedParams,
  type MissionTransitionStatusFencedParams,
} from "../services/paperwork-engine-mission.js";
import {
  MissionCutoverIndeterminateError, bumpMissionRollingStateFencedWithCutover,
  getMissionRollingStateWithCutover, getMissionWithCutover,
  isMissionEngineCutoverEnabled, listMissionSessionsWithCutover,
  listMissionsByCompanyWithCutover, transitionMissionStatusFencedWithCutover,
  type MissionCutoverCallOpts, type MissionCutoverResult,
} from "../services/mission-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_MISSION_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const MISSION = {
  id: NIL, company_id: NIL, owner_agent_id: NIL, title: "m", description: null,
  status: "active", goal_id: null, project_id: null, source_mission_id: null,
  source_workflow_run_id: null, started_at: T0, completed_at: null,
  created_at: T0, updated_at: T0,
};
const ROLLING = {
  id: NIL, company_id: NIL, mission_id: NIL, revision: 3, status: "active",
  state_markdown: "s", state_json: { k: 1 }, last_run_id: null,
  last_compacted_at: null, total_runs: 2, total_input_tokens: 10,
  total_output_tokens: 20, total_cost_cents: 30, created_at: T0, updated_at: T0,
};
const SESSION = {
  id: NIL, mission_id: NIL, agent_id: NIL, company_id: NIL,
  session_secret_id: NIL, adapter_type: "codex", status: "active",
  last_active_at: T0, run_count: 1, expires_at: null, created_at: T0,
};
const GET_P = { mission_id: NIL, company_id: NIL };
const LIST_P = { company_id: NIL, limit: 5 };
const TRANS: MissionTransitionStatusFencedParams = {
  mission_id: NIL, company_id: NIL, expected_status: "planning", next_status: "active",
};
const BUMP: MissionBumpRollingStateFencedParams = {
  mission_id: NIL, company_id: NIL, expected_revision: 3,
  state_json: { k: 1 }, state_markdown: "s",
};

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: MissionCutoverCallOpts) => Promise<MissionCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["transition_status_fenced",
    (c, ts, o) => transitionMissionStatusFencedWithCutover(c, TRANS, ts, o),
    { applied: true, mission: MISSION }, { applied: true, mission: MISSION },
    "mission.transition_status_fenced",
    { mission_id: NIL, company_id: NIL, expected_status: "planning", next_status: "active" }],
  ["bump_rolling_state_fenced",
    (c, ts, o) => bumpMissionRollingStateFencedWithCutover(c, BUMP, ts, o),
    { applied: true, rolling_state: ROLLING }, { applied: true, rolling_state: ROLLING },
    "mission.bump_rolling_state_fenced",
    { mission_id: NIL, company_id: NIL, expected_revision: 3,
      state_json: { k: 1 }, state_markdown: "s" }],
];
// [op, bound call, wire result, resolved value, RPC method]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string][] = [
  ["get", (c, ts, o) => getMissionWithCutover(c, GET_P, ts, o),
    { mission: MISSION }, { mission: MISSION }, "mission.get"],
  ["list_by_company", (c, ts, o) => listMissionsByCompanyWithCutover(c, LIST_P, ts, o),
    { missions: [MISSION] }, { missions: [MISSION] }, "mission.list_by_company"],
  ["get_rolling_state", (c, ts, o) => getMissionRollingStateWithCutover(c, GET_P, ts, o),
    { rolling_state: ROLLING }, { rolling_state: ROLLING }, "mission.get_rolling_state"],
  ["list_sessions", (c, ts, o) => listMissionSessionsWithCutover(c, GET_P, ts, o),
    { sessions: [SESSION] }, { sessions: [SESSION] }, "mission.list_sessions"],
];
const NOT_APPLIED: readonly [string, CutFn][] = [
  ["transition_status_fenced",
    (c, ts, o) => transitionMissionStatusFencedWithCutover(c, TRANS, ts, o)],
  ["bump_rolling_state_fenced",
    (c, ts, o) => bumpMissionRollingStateFencedWithCutover(c, BUMP, ts, o)],
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

afterEach(() => { vi.mocked(logger.warn).mockReset(); });

describe("isMissionEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isMissionEngineCutoverEnabled({ PAPERWORK_RUST_MISSION_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isMissionEngineCutoverEnabled({ PAPERWORK_RUST_MISSION_CUTOVER: v })).toBe(false);
    }
    expect(isMissionEngineCutoverEnabled({})).toBe(false);
  });
});

describe("mission write cutover", () => {
  it.each(WRITES)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op) => {
    const { client, calls } = stub(() => ({}));
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: "ts-result" });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
  });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 17_000 } }]);
    });
  it.each(NOT_APPLIED)("%s {applied:false} is a rust result, never a fallback", async (_n, op) => {
    const { client } = stub(() => ({ applied: false }));
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(ts).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS once", async (code) => {
      for (const [name, op] of WRITES) {
        const { client } = stub(() => { throw rpc(code); });
        const ts = vi.fn(async () => "ts-result" as never);
        await expect(op(client, ts, { env: ON }))
          .resolves.toEqual({ source: "ts", value: "ts-result" });
        expect(ts).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          expect.objectContaining({ operation: name }), expect.any(String));
        vi.mocked(logger.warn).mockReset();
      }
    });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    for (const [name, op] of WRITES) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).rejects.toMatchObject({
        name: "MissionCutoverIndeterminateError",
        operation: name,
        classification: classifyMissionRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => ({ applied: false }));
    const ts = vi.fn();
    await expect(transitionMissionStatusFencedWithCutover(client,
      { ...TRANS, next_status: "planning" }, ts, { env: ON }))
      .rejects.toBeInstanceOf(MissionCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await transitionMissionStatusFencedWithCutover(client, TRANS, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(MissionCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "transition_status_fenced", cause: error });
    expect(err.classification).toEqual(classifyMissionRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32003); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(transitionMissionStatusFencedWithCutover(client, TRANS, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32003); });
    const boom = new Error("ts boom");
    await expect(transitionMissionStatusFencedWithCutover(client, TRANS,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[0, 17_000], [17_000, 17_000], [17_000.5, 17_000], [700_000, 600_000],
    [Number.NaN, 17_000], [Number.POSITIVE_INFINITY, 17_000], [12.7, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("mission read cutover", () => {
  it.each(READS)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op, _w, want) => {
    const { client, calls } = stub(() => ({}));
    const ts = vi.fn(async () => want as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: want });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
  });
  it.each(READS)("%s returns engine rows with the 10s read timeout", async (_n, op, wire, want, method) => {
    const { client, calls } = stub(() => wire);
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
    expect(ts).not.toHaveBeenCalled();
    expect(calls[0].method).toBe(method);
    expect(timeoutOf(calls[0])).toBe(10_000);
  });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["rpc -32602", rpc(-32602)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("any engine error (%s) warns and falls back to TS once", async (_l, error) => {
    for (const [, op, , want] of READS) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn(async () => want as never);
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(ts).toHaveBeenCalledTimes(1);
    }
  });
  it("pre-send validation errors also fall back on reads", async () => {
    const { client, calls } = stub(() => ({ mission: null }));
    const ts = vi.fn(async () => ({ mission: null }) as never);
    await expect(getMissionWithCutover(client,
      { mission_id: "nope", company_id: NIL }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { mission: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ mission: null }) as never);
    await expect(getMissionWithCutover(client, GET_P, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { mission: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 1], [10_000, 10_000], [10_000.9, 10_000], [700_000, 600_000],
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000], [12.7, 12], [undefined, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

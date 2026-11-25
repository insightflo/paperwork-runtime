import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyAgentRpcError, type AgentTransitionStatusFencedParams,
} from "../services/paperwork-engine-agent.js";
import {
  AgentCutoverIndeterminateError, getAgentWithCutover, isAgentEngineCutoverEnabled,
  listAgentsByCompanyWithCutover, listAgentTaskSessionsWithCutover,
  listAgentToolGrantsWithCutover, transitionAgentStatusFencedWithCutover,
  type AgentCutoverCallOpts, type AgentCutoverResult,
} from "../services/agent-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_AGENT_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const AGENT = {
  id: NIL, company_id: U1, name: "bot", role: "engineer", title: null, icon: null,
  status: "idle", reports_to: null, capabilities: null, adapter_type: "local",
  adapter_config: {}, agent_config: {}, runtime_config: {},
  budget_monthly_cents: 0, spent_monthly_cents: 0, pause_reason: null,
  paused_at: null, permissions: {}, last_heartbeat_at: null, metadata: null,
  created_at: T0, updated_at: T1,
};
const SESSION = {
  id: NIL, company_id: U1, agent_id: NIL, adapter_type: "local", task_key: "k",
  session_params_json: null, session_display_id: null, last_run_id: null,
  last_error: null, created_at: T0, updated_at: T1,
};
const GRANT = { id: NIL, company_id: U1, agent_id: NIL, tool_id: U1, granted_by: "u", created_at: T0 };
const GET = { company_id: U1, agent_id: NIL } as const;
const CO = { company_id: U1 } as const;
const TR: AgentTransitionStatusFencedParams = {
  company_id: U1, agent_id: NIL, expected_status: "idle", new_status: "paused",
};
const APPLIED = { applied: true, agent: AGENT };

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: AgentCutoverCallOpts) => Promise<AgentCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["transition_status_fenced",
    (c, ts, o) => transitionAgentStatusFencedWithCutover(c, TR, ts, o),
    APPLIED, APPLIED, "agent.transition_status_fenced", TR],
];
// [op, bound call, wire result, resolved value, RPC method, wire params]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["get", (c, ts, o) => getAgentWithCutover(c, GET, ts, o),
    { agent: AGENT }, { agent: AGENT }, "agent.get", GET],
  ["list_by_company", (c, ts, o) => listAgentsByCompanyWithCutover(c, CO, ts, o),
    { agents: [AGENT] }, { agents: [AGENT] }, "agent.list_by_company", CO],
  ["list_task_sessions", (c, ts, o) => listAgentTaskSessionsWithCutover(c, CO, ts, o),
    { sessions: [SESSION] }, { sessions: [SESSION] }, "agent.list_task_sessions", CO],
  ["list_tool_grants", (c, ts, o) => listAgentToolGrantsWithCutover(c, CO, ts, o),
    { grants: [GRANT] }, { grants: [GRANT] }, "agent.list_tool_grants", CO],
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

describe("isAgentEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isAgentEngineCutoverEnabled({ PAPERWORK_RUST_AGENT_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isAgentEngineCutoverEnabled({ PAPERWORK_RUST_AGENT_CUTOVER: v })).toBe(false);
    }
    expect(isAgentEngineCutoverEnabled({})).toBe(false);
  });
  it("opts.env overrides process.env in both directions", async () => {
    const saved = process.env.PAPERWORK_RUST_AGENT_CUTOVER;
    try {
      delete process.env.PAPERWORK_RUST_AGENT_CUTOVER;
      const a = stub(() => APPLIED);
      const tsA = vi.fn(async () => "ts-result" as never);
      await expect(transitionAgentStatusFencedWithCutover(a.client, TR, tsA, { env: ON }))
        .resolves.toEqual({ source: "rust", value: APPLIED });
      expect(a.calls).toHaveLength(1);
      expect(tsA).not.toHaveBeenCalled();
      process.env.PAPERWORK_RUST_AGENT_CUTOVER = "1";
      const b = stub(() => APPLIED);
      const tsB = vi.fn(async () => "ts-result" as never);
      await expect(transitionAgentStatusFencedWithCutover(b.client, TR, tsB, { env: {} }))
        .resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(b.calls).toHaveLength(0);
      expect(tsB).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.PAPERWORK_RUST_AGENT_CUTOVER;
      else process.env.PAPERWORK_RUST_AGENT_CUTOVER = saved;
    }
  });
});

describe("agent write cutover", () => {
  it.each(WRITES)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => "ts-result" as never);
      for (const env of [{}, { PAPERWORK_RUST_AGENT_CUTOVER: "0" },
        { PAPERWORK_RUST_AGENT_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: "ts-result" });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 17_000 } }]);
    });
  it.each(WRITES)("%s {applied:false,reason:'fenced'} is a rust result, never a fallback",
    async (_n, op) => {
      const { client } = stub(() => ({ applied: false, reason: "fenced" }));
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON }))
        .resolves.toEqual({ source: "rust", value: { applied: false, reason: "fenced" } });
      expect(ts).not.toHaveBeenCalled();
    });
  it.each([-32001, -32002, -32004, -32602])(
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
    ["unknown rpc -32601", rpc(-32601)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    for (const [name, op] of WRITES) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).rejects.toMatchObject({
        name: "AgentCutoverIndeterminateError",
        operation: name,
        classification: classifyAgentRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => APPLIED);
    const ts = vi.fn();
    await expect(transitionAgentStatusFencedWithCutover(client,
      { ...TR, agent_id: "not-a-uuid" }, ts, { env: ON }))
      .rejects.toBeInstanceOf(AgentCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await transitionAgentStatusFencedWithCutover(client, TR, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "transition_status_fenced", cause: error });
    expect(err.classification).toEqual(classifyAgentRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32004); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(transitionAgentStatusFencedWithCutover(client, TR, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32004); });
    const boom = new Error("ts boom");
    await expect(transitionAgentStatusFencedWithCutover(client, TR,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[undefined, 17_000], [0, 17_000], [5_000, 17_000], [1_000_000, 600_000],
    [1.5, 17_000], [Number.NaN, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("agent read cutover", () => {
  it.each(READS)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op, _w, want) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => want as never);
      for (const env of [{}, { PAPERWORK_RUST_AGENT_CUTOVER: "0" },
        { PAPERWORK_RUST_AGENT_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: want });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(READS)("%s returns engine rows with the 10s read timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 10_000 } }]);
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
    const { client, calls } = stub(() => ({ agent: null }));
    const ts = vi.fn(async () => ({ agent: null }) as never);
    await expect(getAgentWithCutover(client,
      { ...GET, agent_id: "nope" }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { agent: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ agent: null }) as never);
    await expect(getAgentWithCutover(client, GET, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { agent: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, 10_000], [0, 1], [5_000, 5_000], [9_000_000, 600_000],
    [1.5, 1], [Number.NaN, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

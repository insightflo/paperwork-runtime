import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyActivityRpcError, type ActivityAppendEventParams,
  type ActivityResolveOperatorDecisionFencedParams,
} from "../services/paperwork-engine-activity.js";
import {
  ActivityCutoverIndeterminateError, appendActivityEventWithCutover,
  isActivityEngineCutoverEnabled, listActivityEventsWithCutover,
  listOperatorDecisionsWithCutover, resolveOperatorDecisionFencedWithCutover,
  type ActivityCutoverCallOpts, type ActivityCutoverResult,
} from "../services/activity-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_ACTIVITY_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const EVENT = {
  id: NIL, company_id: U1, actor_type: "agent", actor_id: NIL, action: "a",
  entity_type: "issue", entity_id: U1, agent_id: null, run_id: null,
  details: null, created_at: T0,
};
const DECISION = {
  id: NIL, company_id: U1, quality_action_id: null, quality_binding: null,
  request_key: "rk", request_hash: "rh", schema_version: 1, status: "pending",
  priority: "normal", interaction_type: "confirm", title: "t", description: "d",
  source_type: "issue", source_id: "s", source_context: {}, issue_id: null,
  requested_by_agent_id: null, requested_by_user_id: null, definition: {},
  result: null, resolved_by_user_id: null, resolved_at: null, cancelled_at: null,
  continuation_mode: "resume", created_at: T0, updated_at: T1,
};
const APPEND: ActivityAppendEventParams = {
  company_id: U1, actor_type: "agent", actor_id: NIL, action: "issue.done",
  entity_type: "issue", entity_id: U1,
};
const RESOLVE: ActivityResolveOperatorDecisionFencedParams = {
  operator_decision_id: NIL, company_id: U1, resolved_by_user_id: "u",
  result: { ok: true },
};
const LE = { company_id: U1, limit: 10 } as const;
const LD = { company_id: U1, limit: 10 } as const;
const APPENDED = { event: EVENT };
const UPDATED = { updated: true, operator_decision: DECISION };
const EVENTS = { events: [EVENT] };
const DECISIONS = { operator_decisions: [DECISION] };

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: ActivityCutoverCallOpts) => Promise<ActivityCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["append_event",
    (c, ts, o) => appendActivityEventWithCutover(c, APPEND, ts, o),
    APPENDED, APPENDED, "activity.append_event", APPEND],
  ["resolve_operator_decision_fenced",
    (c, ts, o) => resolveOperatorDecisionFencedWithCutover(c, RESOLVE, ts, o),
    UPDATED, UPDATED, "activity.resolve_operator_decision_fenced", RESOLVE],
];
// [op, bound call, wire result, resolved value, RPC method, wire params]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["list_events", (c, ts, o) => listActivityEventsWithCutover(c, LE, ts, o),
    EVENTS, EVENTS, "activity.list_events", LE],
  ["list_operator_decisions",
    (c, ts, o) => listOperatorDecisionsWithCutover(c, LD, ts, o),
    DECISIONS, DECISIONS, "activity.list_operator_decisions", LD],
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

describe("isActivityEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isActivityEngineCutoverEnabled({ PAPERWORK_RUST_ACTIVITY_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isActivityEngineCutoverEnabled({ PAPERWORK_RUST_ACTIVITY_CUTOVER: v })).toBe(false);
    }
    expect(isActivityEngineCutoverEnabled({})).toBe(false);
  });
  it("opts.env overrides process.env in both directions", async () => {
    const saved = process.env.PAPERWORK_RUST_ACTIVITY_CUTOVER;
    try {
      delete process.env.PAPERWORK_RUST_ACTIVITY_CUTOVER;
      const a = stub(() => APPENDED);
      const tsA = vi.fn(async () => "ts-result" as never);
      await expect(appendActivityEventWithCutover(a.client, APPEND, tsA, { env: ON }))
        .resolves.toEqual({ source: "rust", value: APPENDED });
      expect(a.calls).toHaveLength(1);
      expect(tsA).not.toHaveBeenCalled();
      process.env.PAPERWORK_RUST_ACTIVITY_CUTOVER = "1";
      const b = stub(() => APPENDED);
      const tsB = vi.fn(async () => "ts-result" as never);
      await expect(appendActivityEventWithCutover(b.client, APPEND, tsB, { env: {} }))
        .resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(b.calls).toHaveLength(0);
      expect(tsB).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.PAPERWORK_RUST_ACTIVITY_CUTOVER;
      else process.env.PAPERWORK_RUST_ACTIVITY_CUTOVER = saved;
    }
  });
});

describe("activity write cutover", () => {
  it.each(WRITES)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => "ts-result" as never);
      for (const env of [{}, { PAPERWORK_RUST_ACTIVITY_CUTOVER: "0" },
        { PAPERWORK_RUST_ACTIVITY_CUTOVER: "yes" }]) {
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
  it("resolve {updated:false} is a rust result, never a fallback", async () => {
    const { client } = stub(() => ({ updated: false }));
    const ts = vi.fn();
    await expect(resolveOperatorDecisionFencedWithCutover(client, RESOLVE, ts, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { updated: false } });
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
    ["unknown rpc -32601", rpc(-32601)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    for (const [name, op] of WRITES) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).rejects.toMatchObject({
        name: "ActivityCutoverIndeterminateError",
        operation: name,
        classification: classifyActivityRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => APPENDED);
    const ts = vi.fn();
    await expect(appendActivityEventWithCutover(client,
      { ...APPEND, company_id: "not-a-uuid" }, ts, { env: ON }))
      .rejects.toBeInstanceOf(ActivityCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await appendActivityEventWithCutover(client, APPEND, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(ActivityCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "append_event", cause: error });
    expect(err.classification).toEqual(classifyActivityRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32004); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(appendActivityEventWithCutover(client, APPEND, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32004); });
    const boom = new Error("ts boom");
    await expect(appendActivityEventWithCutover(client, APPEND,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[undefined, 17_000], [0, 17_000], [5_000, 17_000], [999_999.7, 600_000],
    [20_000, 20_000], [Number.NaN, 17_000], [Number.POSITIVE_INFINITY, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("activity read cutover", () => {
  it.each(READS)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op, _w, want) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => want as never);
      for (const env of [{}, { PAPERWORK_RUST_ACTIVITY_CUTOVER: "0" },
        { PAPERWORK_RUST_ACTIVITY_CUTOVER: "yes" }]) {
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
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
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
    const { client, calls } = stub(() => ({ events: [] }));
    const ts = vi.fn(async () => ({ events: [] }) as never);
    await expect(listActivityEventsWithCutover(client,
      { ...LE, company_id: "nope" }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { events: [] } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ events: [] }) as never);
    await expect(listActivityEventsWithCutover(client, LE, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { events: [] } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, 10_000], [0, 1], [0.9, 1], [5_000, 5_000], [9_000_000, 600_000],
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

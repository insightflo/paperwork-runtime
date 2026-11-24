import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  ActivityAppendEventResult, ActivityListEventsResult,
  ActivityListOperatorDecisionsResult, ActivityResolveOperatorDecisionFencedResult,
} from "../services/paperwork-engine-activity.js";
import { ActivityCutoverIndeterminateError } from "../services/activity-cutover.js";
import {
  createActivityCutoverHooks, getActivityCutoverMetrics, resetActivityCutoverMetricsForTests,
  wireAppendActivityEventCutover, wireListActivityEventsCutover,
  wireListOperatorDecisionsCutover, wireResolveOperatorDecisionFencedCutover,
  type ActivityCutoverResult, type ActivityCutoverTelemetryEvent,
  type ActivityCutoverWiringOpts, type ActivityWiredOperation,
} from "../services/activity-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_ACTIVITY_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z";
const T1 = "2026-07-01T00:00:00Z";
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
const APPEND = {
  company_id: U1, actor_type: "agent" as const, actor_id: NIL, action: "issue.done",
  entity_type: "issue", entity_id: U1,
};
const RESOLVE = {
  operator_decision_id: NIL, company_id: U1, resolved_by_user_id: "u",
  result: { ok: true },
};
const LE = { company_id: U1, limit: 10 };
const LD = { company_id: U1, limit: 10 };
const APPENDED: ActivityAppendEventResult = { event: EVENT };
const UPDATED: ActivityResolveOperatorDecisionFencedResult = { updated: true, operator_decision: DECISION };
const NOT_UPDATED: ActivityResolveOperatorDecisionFencedResult = { updated: false };
const EVENTS: ActivityListEventsResult = { events: [EVENT] };
const DECISIONS: ActivityListOperatorDecisionsResult = { operator_decisions: [DECISION] };

interface OpCase {
  op: ActivityWiredOperation; method: string; response: unknown; result: unknown;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: ActivityCutoverWiringOpts) => Promise<ActivityCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "append_event", method: "activity.append_event", response: APPENDED,
    result: APPENDED,
    invoke: (f, o) => wireAppendActivityEventCutover(APPEND, f as never, o) },
  { op: "resolve_operator_decision_fenced", method: "activity.resolve_operator_decision_fenced",
    response: UPDATED, result: UPDATED,
    invoke: (f, o) => wireResolveOperatorDecisionFencedCutover(RESOLVE, f as never, o) },
  { op: "list_events", method: "activity.list_events", response: EVENTS,
    result: EVENTS, invoke: (f, o) => wireListActivityEventsCutover(LE, f as never, o) },
  { op: "list_operator_decisions", method: "activity.list_operator_decisions",
    response: DECISIONS, result: DECISIONS,
    invoke: (f, o) => wireListOperatorDecisionsCutover(LD, f as never, o) },
];
const WRITES = OPS.slice(0, 2), READS = OPS.slice(2);

function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);
const hostileError = () => Object.defineProperty(new Error("boom"), "stack", { get() { throw new Error("stack-getter-boom"); } });

beforeEach(() => resetActivityCutoverMetricsForTests());

describe("activity-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_ACTIVITY_CUTOVER: "0" }, { PAPERWORK_RUST_ACTIVITY_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getActivityCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    }
    expect(m.append_event.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPENDED);
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPENDED });
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPENDED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getActivityCutoverMetrics().append_event)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const opts = { env: ON, getClient: () => client };
    for (const op of OPS) {
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, opts)).resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(calls.map((c) => c.method)).toEqual(OPS.map((o) => o.method));
    const m = getActivityCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    }
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => APPENDED);
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: APPENDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getActivityCutoverMetrics().append_event)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["plain Error", new Error("unclassified write failure")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const opts = { env: ON, getClient: () => client };
    for (const op of WRITES) {
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, opts)).rejects.toBeInstanceOf(ActivityCutoverIndeterminateError);
      expect(tsFallback).not.toHaveBeenCalled();
    }
    const m = getActivityCutoverMetrics();
    for (const op of WRITES) {
      expect(m[op.op]).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    }
  });

  it.each(READS)("flag ON + $op read engine error falls back to tsFallback (never indeterminate)", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t")]) {
      const { client } = stubClient(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
    expect(getActivityCutoverMetrics()[op.op])
      .toMatchObject({ tsFallback: 2, indeterminateError: 0, rustSuccess: 0 });
  });

  it("resolve {updated:false} propagates untouched and counts fenceMismatch (no fallback)", async () => {
    const { client } = stubClient(() => NOT_UPDATED);
    const tsFallback = vi.fn();
    await expect(wireResolveOperatorDecisionFencedCutover(RESOLVE, tsFallback as never,
      { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: NOT_UPDATED });
    expect(tsFallback).not.toHaveBeenCalled();
    await expect(wireResolveOperatorDecisionFencedCutover(RESOLVE,
      async () => NOT_UPDATED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: NOT_UPDATED });
    expect(getActivityCutoverMetrics().resolve_operator_decision_fenced)
      .toMatchObject({ rustSuccess: 1, tsBypass: 1, fenceMismatch: 2, tsFallback: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getActivityCutoverMetrics().append_event)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ ...RESOLVE, company_id: "not-a-uuid" });
    await expect(wireResolveOperatorDecisionFencedCutover(params, async () => UPDATED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: UPDATED });
    expect(params).toEqual({ ...RESOLVE, company_id: "not-a-uuid" });
  });

  it("createActivityCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: ActivityCutoverTelemetryEvent[] = [];
    const hooks = createActivityCutoverHooks({
      env: ON, getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.appendEvent(APPEND, vi.fn())).resolves.toEqual({ source: "rust", value: APPENDED });
    await expect(hooks.resolveOperatorDecisionFenced(RESOLVE, vi.fn())).resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(hooks.listEvents(LE, vi.fn())).resolves.toEqual({ source: "rust", value: EVENTS });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.appendEvent(APPEND, async () => APPENDED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: APPENDED });
    expect(events).toHaveLength(4);

    const m = hooks.getMetrics();
    expect(m.append_event).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.resolve_operator_decision_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.list_events).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getActivityCutoverMetrics().append_event.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireAppendActivityEventCutover(APPEND, async () => APPENDED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: ActivityCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: APPENDED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getActivityCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireAppendActivityEventCutover(APPEND, async () => APPENDED, { env: OFF });
    const snap = getActivityCutoverMetrics();
    Object.assign(snap.append_event, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.list_events, { totalCalls: 999 });
    const fresh = getActivityCutoverMetrics();
    expect(fresh.append_event).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.list_events.totalCalls).toBe(0);

    resetActivityCutoverMetricsForTests();
    const zeroed = getActivityCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => APPENDED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(ActivityCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getActivityCutoverMetrics().append_event).toMatchObject({ indeterminateError: 1, tsFallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPENDED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireAppendActivityEventCutover(APPEND, tsFallback, opts)).resolves.toEqual({ source: "ts", value: APPENDED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getActivityCutoverMetrics().append_event).toMatchObject({ tsBypass: 1 });
  });
});

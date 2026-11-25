import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  DueSchedule,
  ScheduleAdvanceFencedParams,
  ScheduleAdvanceFencedResult,
  ScheduleListDueParams,
  ScheduleSetEnabledParams,
  ScheduleSetEnabledResult,
} from "../services/paperwork-engine-schedule.js";
import { ScheduleCutoverIndeterminateError } from "../services/paperwork-engine-schedule-cutover.js";
import {
  createScheduleCutoverHooks,
  getScheduleCutoverMetrics,
  resetScheduleCutoverMetricsForTests,
  wireAdvanceFencedCutover,
  wireListDueCutover,
  wireSetEnabledCutover,
  type ScheduleCutoverTelemetryEvent,
} from "../services/schedule-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const SID = "11111111-1111-1111-1111-111111111111";
const AID = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_ENGINE_SCHEDULE_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-01-01T00:00:00Z", T1 = "2026-01-08T00:00:00Z";
const DUE: DueSchedule = {
  id: SID, company_id: NIL, agent_id: AID, cron_expression: "0 * * * *",
  timezone: "UTC", mission_id: null, enabled: true, last_run_at: null, next_run_at: T0,
};
const LIST: ScheduleListDueParams = { company_id: NIL, due_before: T1, limit: 10 };
const ADV: ScheduleAdvanceFencedParams = {
  schedule_id: SID, company_id: NIL, last_run_at: T0, next_run_at: T1,
};
const APPLIED: ScheduleAdvanceFencedResult = {
  applied: true, id: SID, company_id: NIL, agent_id: AID,
  last_run_at: T0, next_run_at: T1, updated_at: T1,
};
const EN: ScheduleSetEnabledParams = { schedule_id: SID, company_id: NIL, enabled: false };
const UPDATED: ScheduleSetEnabledResult = { updated: true, id: SID, enabled: false, updated_at: T1 };

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

beforeEach(() => resetScheduleCutoverMetricsForTests());

describe("schedule-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_ENGINE_SCHEDULE_CUTOVER: "0" }, { PAPERWORK_ENGINE_SCHEDULE_CUTOVER: "true" }]) {
      const adv = await wireAdvanceFencedCutover(ADV, async () => APPLIED, { env, getClient });
      const en = await wireSetEnabledCutover(EN, async () => UPDATED, { env, getClient });
      const list = await wireListDueCutover(LIST, async () => [DUE], { env, getClient });
      expect(adv).toEqual({ source: "ts", value: APPLIED });
      expect(en).toEqual({ source: "ts", value: UPDATED });
      expect(list).toEqual({ source: "ts", value: [DUE] });
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getScheduleCutoverMetrics();
    expect(m.advance_fenced).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    expect(m.set_enabled).toMatchObject({ totalCalls: 3, tsBypass: 3 });
    expect(m.list_due).toMatchObject({ totalCalls: 3, tsBypass: 3 });
    expect(m.list_due.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireAdvanceFencedCutover(ADV, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    await expect(wireAdvanceFencedCutover(ADV, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getScheduleCutoverMetrics().advance_fenced)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient((method) =>
      method === "schedule.advance_fenced" ? APPLIED
        : method === "schedule.set_enabled" ? UPDATED : { schedules: [DUE] });
    const opts = { env: ON, getClient: () => client };
    const tsAdv = vi.fn(async () => ({ applied: false as const }));
    const tsEn = vi.fn(async () => ({ updated: false as const }));
    const tsList = vi.fn(async () => []);

    await expect(wireAdvanceFencedCutover(ADV, tsAdv, opts)).resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(wireSetEnabledCutover(EN, tsEn, opts)).resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(wireListDueCutover(LIST, tsList, opts)).resolves.toEqual({ source: "rust", value: [DUE] });
    expect(tsAdv).not.toHaveBeenCalled();
    expect(tsEn).not.toHaveBeenCalled();
    expect(tsList).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method))
      .toEqual(["schedule.advance_fenced", "schedule.set_enabled", "schedule.list_due"]);
    const m = getScheduleCutoverMetrics();
    expect(m.advance_fenced).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    expect(m.set_enabled).toMatchObject({ rustSuccess: 1, fenceMismatch: 0 });
    expect(m.list_due).toMatchObject({ rustSuccess: 1, fenceMismatch: 0 });
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireAdvanceFencedCutover(ADV, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getScheduleCutoverMetrics().advance_fenced)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsAdv = vi.fn(async () => APPLIED);
    const tsEn = vi.fn(async () => UPDATED);
    const opts = { env: ON, getClient: () => client };
    await expect(wireAdvanceFencedCutover(ADV, tsAdv, opts))
      .rejects.toBeInstanceOf(ScheduleCutoverIndeterminateError);
    await expect(wireSetEnabledCutover(EN, tsEn, opts))
      .rejects.toBeInstanceOf(ScheduleCutoverIndeterminateError);
    expect(tsAdv).not.toHaveBeenCalled();
    expect(tsEn).not.toHaveBeenCalled();
    const m = getScheduleCutoverMetrics();
    expect(m.advance_fenced).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    expect(m.set_enabled).toMatchObject({ indeterminateError: 1 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + list_due engine error (%s) still falls back to TS (read is side-effect free)", async (_l, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsFallback = vi.fn(async () => [DUE]);
    await expect(wireListDueCutover(LIST, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getScheduleCutoverMetrics().list_due)
      .toMatchObject({ tsFallback: 1, indeterminateError: 0, rustSuccess: 0 });
  });

  it("propagates Rust not-applied results untouched; counts rustSuccess + fenceMismatch", async () => {
    const { client } = stubClient((method) =>
      method === "schedule.advance_fenced" ? { applied: false } : { updated: false });
    const opts = { env: ON, getClient: () => client };
    const tsFallback = vi.fn();
    await expect(wireAdvanceFencedCutover(ADV, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    await expect(wireSetEnabledCutover(EN, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: { updated: false } });
    expect(tsFallback).not.toHaveBeenCalled();
    const m = getScheduleCutoverMetrics();
    expect(m.advance_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 1, tsFallback: 0 });
    expect(m.set_enabled).toMatchObject({ rustSuccess: 1, fenceMismatch: 1, tsFallback: 0 });
  });

  it("counts fenceMismatch for TS-originated not-applied results as well", async () => {
    await expect(wireAdvanceFencedCutover(ADV, async () => ({ applied: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    await expect(wireSetEnabledCutover(EN, async () => ({ updated: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { updated: false } });
    const m = getScheduleCutoverMetrics();
    expect(m.advance_fenced).toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustSuccess: 0 });
    expect(m.set_enabled).toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustSuccess: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireAdvanceFencedCutover(ADV, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getScheduleCutoverMetrics().advance_fenced)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ schedule_id: "not-a-uuid", company_id: NIL, last_run_at: T0, next_run_at: T1 });
    await expect(wireAdvanceFencedCutover(params, async () => ({ applied: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(params).toEqual({ schedule_id: "not-a-uuid", company_id: NIL, last_run_at: T0, next_run_at: T1 });
  });

  it("createScheduleCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "schedule.advance_fenced" ? APPLIED
        : method === "schedule.set_enabled" ? UPDATED : { schedules: [DUE] });
    const events: ScheduleCutoverTelemetryEvent[] = [];
    const hooks = createScheduleCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.advanceFenced(ADV, vi.fn(async () => ({ applied: false as const }))))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(hooks.setEnabled(EN, vi.fn(async () => ({ updated: false as const }))))
      .resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(hooks.listDue(LIST, vi.fn(async () => [])))
      .resolves.toEqual({ source: "rust", value: [DUE] });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.listDue(LIST, async () => [DUE], { env: OFF }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    expect(events).toHaveLength(4);

    const m = hooks.getMetrics();
    expect(m.advance_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.set_enabled).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.list_due).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    // hooks meter is independent of the module-level meter
    expect(getScheduleCutoverMetrics().advance_fenced.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireAdvanceFencedCutover(ADV, async () => APPLIED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: ScheduleCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: APPLIED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getScheduleCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireListDueCutover(LIST, async () => [DUE], { env: OFF });
    const snap = getScheduleCutoverMetrics();
    Object.assign(snap.list_due, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.advance_fenced, { totalCalls: 999 });
    const fresh = getScheduleCutoverMetrics();
    expect(fresh.list_due).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.advance_fenced.totalCalls).toBe(0);

    resetScheduleCutoverMetricsForTests();
    const zeroed = getScheduleCutoverMetrics();
    expect(zeroed.advance_fenced.totalCalls).toBe(0);
    expect(zeroed.set_enabled.totalCalls).toBe(0);
    expect(zeroed.list_due.totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => UPDATED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireSetEnabledCutover(EN, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(ScheduleCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getScheduleCutoverMetrics().set_enabled).toMatchObject({ indeterminateError: 1, tsFallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => [DUE]);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireListDueCutover(LIST, tsFallback, opts)).resolves.toEqual({ source: "ts", value: [DUE] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getScheduleCutoverMetrics().list_due).toMatchObject({ tsBypass: 1 });
  });
});

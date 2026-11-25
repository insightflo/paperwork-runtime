import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  ScheduleAdvanceFencedParams, ScheduleAdvanceFencedResult, ScheduleSetEnabledParams,
  ScheduleSetEnabledResult,
} from "../services/paperwork-engine-schedule.js";
import {
  ScheduleCutoverIndeterminateError, advanceFencedWithCutover, isScheduleEngineCutoverEnabled,
  listDueWithCutover, setEnabledWithCutover,
} from "../services/paperwork-engine-schedule-cutover.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const SID = "11111111-1111-1111-1111-111111111111";
const AID = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_ENGINE_SCHEDULE_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z", T1 = "2026-01-08T00:00:00Z";
const DUE = {
  id: SID, company_id: NIL, agent_id: AID, cron_expression: "0 * * * *",
  timezone: "UTC", mission_id: null, enabled: true, last_run_at: null, next_run_at: T0,
};
const LIST = { company_id: NIL, due_before: T1, limit: 10 };
const ADV: ScheduleAdvanceFencedParams = { schedule_id: SID, company_id: NIL, last_run_at: T0, next_run_at: T1 };
const APPLIED: ScheduleAdvanceFencedResult = {
  applied: true, id: SID, company_id: NIL, agent_id: AID,
  last_run_at: T0, next_run_at: T1, updated_at: T1,
};
const EN: ScheduleSetEnabledParams = { schedule_id: SID, company_id: NIL, enabled: false };
const UPDATED: ScheduleSetEnabledResult = { updated: true, id: SID, enabled: false, updated_at: T1 };

afterEach(() => vi.restoreAllMocks());

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

describe("isScheduleEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isScheduleEngineCutoverEnabled({ PAPERWORK_ENGINE_SCHEDULE_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isScheduleEngineCutoverEnabled({ PAPERWORK_ENGINE_SCHEDULE_CUTOVER: v })).toBe(false);
    }
    expect(isScheduleEngineCutoverEnabled({})).toBe(false);
  });
});

describe("advanceFencedWithCutover", () => {
  it("flag OFF or null client returns the TS result without any RPC", async () => {
    const { client, calls } = stub(() => APPLIED);
    const tsFallback = vi.fn(async () => ({ applied: false as const }));
    await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    await expect(advanceFencedWithCutover(null, ADV, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it("flag ON sends snake_case wire params with a clamped write timeout", async () => {
    const { client, calls } = stub(() => APPLIED);
    const tsFallback = vi.fn();
    await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: "schedule.advance_fenced",
      params: { schedule_id: SID, company_id: NIL, last_run_at: T0, next_run_at: T1 },
      callOpts: { timeoutMs: 17_000 },
    }]);
  });
  it("flag ON passes expected_next_run_at through to the wire", async () => {
    const { client, calls } = stub(() => APPLIED);
    await advanceFencedWithCutover(client, { ...ADV, expected_next_run_at: T0 }, vi.fn(), { env: ON });
    expect(calls[0].params).toMatchObject({ schedule_id: SID, expected_next_run_at: T0 });
  });
  it("applied:false is a rust result, never a fallback", async () => {
    const { client } = stub(() => ({ applied: false }));
    const tsFallback = vi.fn();
    await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS once", async (code) => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const { client } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => APPLIED);
      await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: APPLIED });
      expect(tsFallback).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn();
    await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "ScheduleCutoverIndeterminateError",
        operation: "advance_fenced",
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const err = await advanceFencedWithCutover(client, ADV, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "advance_fenced", cause: error });
  });
  const ineligible: [string, ScheduleAdvanceFencedParams][] = [
    ["non-UUID schedule_id", { ...ADV, schedule_id: "nope" }],
    ["non-UUID company_id", { ...ADV, company_id: "nope" }],
    ["malformed last_run_at", { ...ADV, last_run_at: "junk" }],
    ["malformed next_run_at", { ...ADV, next_run_at: "junk" }],
    ["stale advance window", { ...ADV, next_run_at: T0 }],
    ["bad expected_next_run_at", { ...ADV, expected_next_run_at: "junk" }],
  ];
  it.each(ineligible)("engine-ineligible input (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => APPLIED);
    const tsFallback = vi.fn(async () => ({ applied: false as const }));
    await expect(advanceFencedWithCutover(client, params, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger never blocks the not_committed TS fallback", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("log down"); });
    const { client } = stub(() => { throw rpc(-32003); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(advanceFencedWithCutover(client, ADV, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});

describe("setEnabledWithCutover", () => {
  it("flag OFF or null client bypass the engine", async () => {
    const { client, calls } = stub(() => UPDATED);
    const tsFallback = vi.fn(async () => ({ updated: false as const }));
    await expect(setEnabledWithCutover(client, EN, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: { updated: false } });
    await expect(setEnabledWithCutover(null, EN, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { updated: false } });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it("flag ON sends schedule.set_enabled wire params with a write timeout", async () => {
    const { client, calls } = stub(() => UPDATED);
    const tsFallback = vi.fn();
    await expect(setEnabledWithCutover(client, EN, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: UPDATED });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: "schedule.set_enabled",
      params: { schedule_id: SID, company_id: NIL, enabled: false },
      callOpts: { timeoutMs: 17_000 },
    }]);
  });
  it("updated:false is a rust result, never a fallback", async () => {
    const { client } = stub(() => ({ updated: false }));
    const tsFallback = vi.fn();
    await expect(setEnabledWithCutover(client, EN, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { updated: false } });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("not_committed warns and falls back to TS once", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { client } = stub(() => { throw rpc(-32002); });
    const tsFallback = vi.fn(async () => UPDATED);
    await expect(setEnabledWithCutover(client, EN, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: UPDATED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
  it("indeterminate throws and never calls tsFallback", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn();
    const err = await setEnabledWithCutover(client, EN, tsFallback, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "set_enabled", cause: error });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each<[string, ScheduleSetEnabledParams]>([
    ["non-UUID schedule_id", { ...EN, schedule_id: "nope" }],
    ["non-boolean enabled", { ...EN, enabled: "yes" as never }],
  ])("engine-ineligible input (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => UPDATED);
    const tsFallback = vi.fn(async () => ({ updated: false as const }));
    await expect(setEnabledWithCutover(client, params, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { updated: false } });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});

describe("listDueWithCutover", () => {
  it("flag ON returns engine rows with the 10s read timeout", async () => {
    const { client, calls } = stub(() => ({ schedules: [DUE] }));
    const tsFallback = vi.fn();
    await expect(listDueWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: [DUE] });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls[0].method).toBe("schedule.list_due");
    expect(calls[0].params).toEqual({ company_id: NIL, due_before: T1, limit: 10 });
    expect(timeoutOf(calls[0])).toBe(10_000);
  });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("any engine error (%s) warns and falls back to TS once", async (_l, error) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn(async () => [DUE]);
    await expect(listDueWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
  it("flag OFF, null client, and engine-ineligible params never reach the engine", async () => {
    const { client, calls } = stub(() => ({ schedules: [DUE] }));
    const tsFallback = vi.fn(async () => [DUE]);
    await expect(listDueWithCutover(client, LIST, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    await expect(listDueWithCutover(null, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    await expect(listDueWithCutover(client, { ...LIST, due_before: "junk" }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    await expect(listDueWithCutover(client, { ...LIST, limit: 1.5 }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(4);
  });
  it("a throwing logger never blocks the read TS fallback", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("log down"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => [DUE]);
    await expect(listDueWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [DUE] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});

describe("cutover timeout clamping", () => {
  it.each([[1, 17_000], [17_000.5, 17_000], [600_001, 600_000], [Number.NaN, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      const a = stub(() => APPLIED), b = stub(() => UPDATED);
      await advanceFencedWithCutover(a.client, ADV, vi.fn(), { env: ON, timeoutMs: ms });
      await setEnabledWithCutover(b.client, EN, vi.fn(), { env: ON, timeoutMs: ms });
      expect([timeoutOf(a.calls[0]), timeoutOf(b.calls[0])]).toEqual([want, want]);
    });
  it.each([[0, 1], [1, 1], [10_000.7, 10_000], [600_001, 600_000], [Number.NaN, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      const { client, calls } = stub(() => ({ schedules: [] }));
      await listDueWithCutover(client, LIST, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
});

import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  advanceScheduleFenced, classifyScheduleRpcError, listDueSchedules,
  setScheduleEnabled, validateScheduleAdvanceWindow,
} from "../services/paperwork-engine-schedule.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const T0 = "2026-01-01T00:00:00Z", T1 = "2026-01-01T00:05:00Z";
const DUE = {
  id: NIL, company_id: NIL, agent_id: NIL, cron_expression: "*/5 * * * *",
  timezone: "UTC", mission_id: null, enabled: true, last_run_at: T0, next_run_at: T1,
};
const APPLIED = {
  applied: true, id: NIL, company_id: NIL, agent_id: NIL,
  last_run_at: T0, next_run_at: T1, updated_at: "2026-01-01T00:00:01Z",
};
const ADVANCE = { schedule_id: NIL, company_id: NIL, last_run_at: T0, next_run_at: T1 };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("schedule.* typed RPC methods", () => {
  it("validateScheduleAdvanceWindow maps both results; snake_case params, Date inputs, callOpts", async () => {
    const { client, calls } = stub({ "schedule.validate_advance_window": { valid: true } });
    await expect(validateScheduleAdvanceWindow(client, { last_run_at: T0, next_run_at: T1 }))
      .resolves.toEqual({ valid: true });
    expect(calls[0]).toEqual({
      method: "schedule.validate_advance_window",
      params: { last_run_at: T0, next_run_at: T1 }, callOpts: undefined,
    });
    const s = stub({ "schedule.validate_advance_window": { valid: false, reason: "invalid_advance_window" } });
    // next <= last is NOT gated client-side: the RPC verdict carries it.
    await expect(validateScheduleAdvanceWindow(s.client, { last_run_at: T1, next_run_at: T0 }))
      .resolves.toEqual({ valid: false, reason: "invalid_advance_window" });
    const d = stub({ "schedule.validate_advance_window": { valid: true } });
    await validateScheduleAdvanceWindow(d.client, {
      last_run_at: new Date(T0), next_run_at: new Date(T1), junk: 1,
    } as never, { timeoutMs: 77 });
    expect(d.calls[0]).toEqual({
      method: "schedule.validate_advance_window",
      params: { last_run_at: "2026-01-01T00:00:00.000Z", next_run_at: "2026-01-01T00:05:00.000Z" },
      callOpts: { timeoutMs: 77 },
    });
  });
  it("validateScheduleAdvanceWindow rejects malformed results and bad timestamps", async () => {
    for (const bad of [null, 1, { valid: "yes" }, { valid: true, extra: 1 },
      { valid: false }, { valid: false, reason: "bogus" },
      { valid: false, reason: "invalid_advance_window", x: 1 }]) {
      const { client } = stub({ "schedule.validate_advance_window": bad });
      await expect(validateScheduleAdvanceWindow(client, { last_run_at: T0, next_run_at: T1 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const ts of [new Date(NaN), "nope", "2026-01-01", "2026-02-30T00:00:00Z", 42]) {
      await expect(validateScheduleAdvanceWindow(s.client, { last_run_at: ts as never, next_run_at: T1 }))
        .rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("listDueSchedules unwraps schedules; validates rows and params", async () => {
    const { client, calls } = stub({ "schedule.list_due": { schedules: [DUE] } });
    await expect(listDueSchedules(client, { company_id: NIL, due_before: "2030-01-01T00:00:00Z", limit: 10 }))
      .resolves.toEqual([DUE]);
    expect(calls[0]).toEqual({
      method: "schedule.list_due",
      params: { company_id: NIL, due_before: "2030-01-01T00:00:00Z", limit: 10 }, callOpts: undefined,
    });
    const d = stub({ "schedule.list_due": { schedules: [] } });
    await listDueSchedules(d.client, {
      company_id: NIL, due_before: new Date("2030-06-15T12:00:00Z"), limit: 5, x: 9,
    } as never);
    expect(d.calls[0].params).toEqual({
      company_id: NIL, due_before: "2030-06-15T12:00:00.000Z", limit: 5,
    });
    for (const bad of [null, {}, { schedules: "x" }, { schedules: [{ ...DUE, id: "z" }] },
      { schedules: [{ ...DUE, mission_id: "z" }] }, { schedules: [{ ...DUE, enabled: "y" }] },
      { schedules: [{ ...DUE, last_run_at: "2026-02-30T00:00:00Z" }] }, { schedules: [{ ...DUE, next_run_at: 0 }] }]) {
      const c = stub({ "schedule.list_due": bad });
      await expect(listDueSchedules(c.client, { company_id: NIL, due_before: "2030-01-01T00:00:00Z", limit: 5 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    await expect(listDueSchedules(s.client, { company_id: "no", due_before: T1, limit: 1 })).rejects.toThrow(RangeError);
    await expect(listDueSchedules(s.client, { company_id: NIL, due_before: "soon", limit: 1 })).rejects.toThrow(RangeError);
    await expect(listDueSchedules(s.client, { company_id: NIL, due_before: T1, limit: 1.5 })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("advanceScheduleFenced maps applied/discarded; expected_next_run_at omitted/null/ts", async () => {
    const { client, calls } = stub({ "schedule.advance_fenced": APPLIED });
    await expect(advanceScheduleFenced(client, ADVANCE)).resolves.toEqual(APPLIED);
    expect(calls[0]).toEqual({ method: "schedule.advance_fenced", params: { ...ADVANCE }, callOpts: undefined });
    const n = stub({ "schedule.advance_fenced": { applied: false } });
    await expect(advanceScheduleFenced(n.client, { ...ADVANCE, expected_next_run_at: null }))
      .resolves.toEqual({ applied: false });
    expect(n.calls[0].params).toEqual({ ...ADVANCE, expected_next_run_at: null });
    const d = stub({ "schedule.advance_fenced": { applied: false } });
    await advanceScheduleFenced(d.client, { ...ADVANCE, expected_next_run_at: new Date(T1), junk: 2 } as never);
    expect(d.calls[0].params).toEqual({ ...ADVANCE, expected_next_run_at: "2026-01-01T00:05:00.000Z" });
  });
  it("advanceScheduleFenced gates the window at PG microsecond precision pre-call", async () => {
    const s = stub({ "schedule.advance_fenced": APPLIED });
    const go = (p: Record<string, unknown>) => advanceScheduleFenced(s.client, { ...ADVANCE, ...p } as never);
    for (const [last_run_at, next_run_at] of [
      [T0, T0], [T1, T0],
      // 1ns apart: distinct at Rust ns precision, equal once bound as PG µs
      ["2026-01-01T00:00:00.000000000Z", "2026-01-01T00:00:00.000000001Z"],
      // both truncate toward zero to 0 µs at the PG epoch boundary
      ["1999-12-31T23:59:59.999999999Z", "2000-01-01T00:00:00Z"],
      // same instant written in different offsets still compares equal
      ["2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z"],
    ]) await expect(go({ last_run_at, next_run_at })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
    for (const [last_run_at, next_run_at] of [
      ["2026-01-01T00:00:00.000000000Z", "2026-01-01T00:00:00.000001000Z"], // +1 µs
      ["1999-12-31T23:59:59.999999000Z", "2000-01-01T00:00:00Z"],           // -1 µs -> 0 µs
      ["2026-01-01T01:00:00+01:00", "2025-12-31T19:00:00.000001-05:00"],   // +1 µs across offsets
    ]) await expect(go({ last_run_at, next_run_at })).resolves.toEqual(APPLIED);
    expect(s.calls).toHaveLength(3);
    await expect(go({ schedule_id: "no" })).rejects.toThrow(RangeError);
    await expect(go({ company_id: 7 })).rejects.toThrow(RangeError);
    await expect(go({ next_run_at: new Date(NaN) })).rejects.toThrow(RangeError);
    await expect(go({ expected_next_run_at: 5 })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(3);
  });
  it("advanceScheduleFenced rejects malformed results", async () => {
    for (const bad of [null, {}, { applied: "yes" }, { applied: false, extra: 1 },
      { ...APPLIED, id: "z" }, { ...APPLIED, company_id: 1 }, { ...APPLIED, next_run_at: 3 },
      { ...APPLIED, updated_at: "2026-13-01T00:00:00Z" }, { applied: true, id: NIL }]) {
      const c = stub({ "schedule.advance_fenced": bad });
      await expect(advanceScheduleFenced(c.client, ADVANCE)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("setScheduleEnabled maps updated/skipped and enforces boolean enabled", async () => {
    const on = { updated: true, id: NIL, enabled: true, updated_at: "2026-01-01T00:00:01Z" };
    const { client, calls } = stub({ "schedule.set_enabled": on });
    await expect(setScheduleEnabled(client, { schedule_id: NIL, company_id: NIL, enabled: true, junk: 0 } as never))
      .resolves.toEqual(on);
    expect(calls[0]).toEqual({
      method: "schedule.set_enabled",
      params: { schedule_id: NIL, company_id: NIL, enabled: true }, callOpts: undefined,
    });
    const off = stub({ "schedule.set_enabled": { updated: false } });
    await expect(setScheduleEnabled(off.client, { schedule_id: NIL, company_id: NIL, enabled: false }))
      .resolves.toEqual({ updated: false });
    for (const bad of [null, {}, { updated: "y" }, { updated: false, x: 1 },
      { ...on, id: "z" }, { ...on, enabled: "y" }, { ...on, updated_at: "when" }]) {
      const c = stub({ "schedule.set_enabled": bad });
      await expect(setScheduleEnabled(c.client, { schedule_id: NIL, company_id: NIL, enabled: true }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    await expect(setScheduleEnabled(s.client, { schedule_id: NIL, company_id: NIL, enabled: "yes" as never }))
      .rejects.toThrow(RangeError);
    await expect(setScheduleEnabled(s.client, { schedule_id: "z", company_id: NIL, enabled: true }))
      .rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
});

describe("classifyScheduleRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyScheduleRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyScheduleRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyScheduleRpcError(new PaperworkEngineError("rpc_error", "m", -32000))).toEqual(unknown);
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "queue_full"] as const) {
      expect(classifyScheduleRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyScheduleRpcError(e)).toEqual(unknown);
    }
  });
});

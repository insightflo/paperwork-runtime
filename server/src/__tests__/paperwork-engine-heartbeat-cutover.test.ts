import { describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  HeartbeatCutoverIndeterminateError, claimWakeupWithCutover,
  hasExpectedRunIdentityFence, hasExtraPatchFields, isHeartbeatEngineCutoverEnabled,
  listStaleRunsWithCutover, transitionRunFencedWithCutover,
  type HeartbeatTransitionRunFencedCutoverParams,
} from "../services/paperwork-engine-heartbeat-cutover.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "1" };
const WAKE = {
  id: "11111111-1111-1111-1111-111111111111", company_id: NIL, agent_id: NIL,
  source: "issue_assigned", reason: null, idempotency_key: "k1", payload: { x: 1 },
  requested_at: "2026-01-01T00:00:00Z", claimed_at: "2026-01-01T00:00:01Z",
};
const STALE = {
  id: NIL, company_id: NIL, agent_id: NIL, process_pid: null,
  process_loss_retry_count: 0, updated_at: "2026-01-01T00:00:00Z",
};
const CLAIM = { company_id: NIL, agent_id: NIL };
const LIST = { company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 10 };
const TRANS: HeartbeatTransitionRunFencedCutoverParams = {
  run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "succeeded",
};
const APPLIED = {
  applied: true, run_id: NIL, status: "succeeded",
  started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
};

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

describe("isHeartbeatEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isHeartbeatEngineCutoverEnabled({ PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isHeartbeatEngineCutoverEnabled({ PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: v })).toBe(false);
    }
    expect(isHeartbeatEngineCutoverEnabled({})).toBe(false);
  });
});

describe("claimWakeupWithCutover", () => {
  it("flag OFF returns the TS result without any RPC", async () => {
    const { client, calls } = stub(() => ({ claimed: WAKE }));
    const tsFallback = vi.fn(async () => WAKE);
    await expect(claimWakeupWithCutover(client, CLAIM, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: WAKE });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("flag ON uses the engine once with snake_case params and a write timeout", async () => {
    const { client, calls } = stub(() => ({ claimed: WAKE }));
    const tsFallback = vi.fn();
    await expect(claimWakeupWithCutover(client, CLAIM, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: WAKE });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: "heartbeat.claim_wakeup",
      params: { company_id: NIL, agent_id: NIL },
      callOpts: { timeoutMs: expect.any(Number) },
    }]);
    expect(timeoutOf(calls[0])).toBeGreaterThanOrEqual(17_000);
  });
  it("flag ON maps an empty claim to null without TS", async () => {
    const { client } = stub(() => ({ claimed: null }));
    const tsFallback = vi.fn();
    await expect(claimWakeupWithCutover(client, CLAIM, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: null });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004])(
    "not_committed rpc %i warns and falls back to TS", async (code) => {
      const { client } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => WAKE);
      await expect(claimWakeupWithCutover(client, CLAIM, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: WAKE });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn();
    await expect(claimWakeupWithCutover(client, CLAIM, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "HeartbeatCutoverIndeterminateError",
        operation: "claim_wakeup",
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const err = await claimWakeupWithCutover(client, CLAIM, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "claim_wakeup", cause: error });
  });
  it("null client and non-UUID params stay on the TS path even with flag ON", async () => {
    const { client, calls } = stub(() => ({ claimed: WAKE }));
    const tsFallback = vi.fn(async () => null);
    await expect(claimWakeupWithCutover(null, CLAIM, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: null });
    await expect(claimWakeupWithCutover(client, { company_id: "nope", agent_id: NIL }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: null });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
});

describe("transitionRunFencedWithCutover", () => {
  it("flag ON sends run_id/expected_statuses/next_status snake_case with a write timeout", async () => {
    const { client, calls } = stub(() => APPLIED);
    const tsFallback = vi.fn();
    await expect(transitionRunFencedWithCutover(client, TRANS, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls[0].method).toBe("heartbeat.transition_run_fenced");
    expect(calls[0].params).toEqual({
      run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "succeeded",
    });
    expect(timeoutOf(calls[0])).toBeGreaterThanOrEqual(17_000);
  });
  it("passes error/error_code through to the wire params", async () => {
    const { client, calls } = stub(() => ({ applied: false }));
    await expect(transitionRunFencedWithCutover(client,
      { ...TRANS, next_status: "failed", error: "boom", error_code: "E1" }, vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(calls[0].params).toMatchObject({ error: "boom", error_code: "E1" });
  });
  const ineligible: [string, HeartbeatTransitionRunFencedCutoverParams][] = [
    ["extra patch fields", { ...TRANS, extra_patch: { process_pid: 7 } }],
    ["expected-run identity fence", { ...TRANS, expected_run: { id: NIL } }],
    ["empty expected_statuses", { ...TRANS, expected_statuses: [] }],
    ["non-canonical status", { ...TRANS, next_status: "bogus" as never }],
    ["engine-illegal transition", { ...TRANS, next_status: "running" }],
  ];
  it.each(ineligible)("ineligible input (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => APPLIED);
    const tsFallback = vi.fn(async () => ({ applied: false as const }));
    await expect(transitionRunFencedWithCutover(client, params, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("eligibility predicates reflect the TS-only inputs", () => {
    expect(hasExtraPatchFields({})).toBe(false);
    expect(hasExtraPatchFields({ extra_patch: {} })).toBe(false);
    expect(hasExtraPatchFields({ extra_patch: { finished_at: "x" } })).toBe(true);
    expect(hasExpectedRunIdentityFence({})).toBe(false);
    expect(hasExpectedRunIdentityFence({ expected_run: { id: NIL } })).toBe(true);
  });
  it("not_committed rpc error falls back to the TS writer", async () => {
    const { client } = stub(() => { throw rpc(-32003); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(transitionRunFencedWithCutover(client, TRANS, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("indeterminate throws for transition_run_fenced with cause preserved", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn();
    const err = await transitionRunFencedWithCutover(client, TRANS, tsFallback, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "transition_run_fenced", cause: error });
    expect(tsFallback).not.toHaveBeenCalled();
  });
});

describe("listStaleRunsWithCutover", () => {
  it("flag ON returns engine rows with the 10s read timeout", async () => {
    const { client, calls } = stub(() => ({ runs: [STALE] }));
    const tsFallback = vi.fn();
    await expect(listStaleRunsWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: [STALE] });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls[0].method).toBe("heartbeat.list_stale_runs");
    expect(timeoutOf(calls[0])).toBe(10_000);
  });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("any engine error (%s) warns and falls back to TS", async (_l, error) => {
    const { client } = stub(() => { throw error; });
    const tsFallback = vi.fn(async () => [STALE]);
    await expect(listStaleRunsWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [STALE] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("flag OFF, null client, and invalid params never reach or need the engine", async () => {
    const { client, calls } = stub(() => ({ runs: [STALE] }));
    const tsFallback = vi.fn(async () => [STALE]);
    await expect(listStaleRunsWithCutover(client, LIST, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: [STALE] });
    await expect(listStaleRunsWithCutover(null, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [STALE] });
    await expect(listStaleRunsWithCutover(client, { ...LIST, stale_before: "junk" }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [STALE] });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(3);
  });
});

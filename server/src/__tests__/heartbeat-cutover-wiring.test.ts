import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  HeartbeatClaimedWakeup,
  HeartbeatTransitionRunFencedResult,
} from "../services/paperwork-engine-heartbeat.js";
import {
  HeartbeatCutoverIndeterminateError,
  type HeartbeatTransitionRunFencedCutoverParams,
} from "../services/paperwork-engine-heartbeat-cutover.js";
import {
  createHeartbeatCutoverHooks,
  getHeartbeatCutoverMetrics,
  resetHeartbeatCutoverMetricsForTests,
  wireClaimWakeupCutover,
  wireTransitionRunFencedCutover,
  type HeartbeatCutoverTelemetryEvent,
} from "../services/heartbeat-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "1" };
const OFF = {};
const WAKE: HeartbeatClaimedWakeup = {
  id: "11111111-1111-1111-1111-111111111111",
  company_id: NIL,
  agent_id: NIL,
  source: "issue_assigned",
  reason: null,
  idempotency_key: "k1",
  payload: { issueId: "i1" },
  requested_at: "2026-01-01T00:00:00Z",
  claimed_at: "2026-01-01T00:00:01Z",
};
const CLAIM = { company_id: NIL, agent_id: NIL };
const TRANS: HeartbeatTransitionRunFencedCutoverParams = {
  run_id: NIL,
  company_id: NIL,
  expected_statuses: ["running"],
  next_status: "succeeded",
};
const APPLIED: HeartbeatTransitionRunFencedResult = {
  applied: true,
  run_id: NIL,
  status: "succeeded",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:01Z",
};

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

beforeEach(() => resetHeartbeatCutoverMetricsForTests());

describe("heartbeat-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes both ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "0" }, { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER: "true" }]) {
      const claim = await wireClaimWakeupCutover(CLAIM, async () => WAKE, { env, getClient });
      const trans = await wireTransitionRunFencedCutover(TRANS, async () => APPLIED, { env, getClient });
      expect(claim).toEqual({ source: "ts", value: WAKE });
      expect(trans).toEqual({ source: "ts", value: APPLIED });
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getHeartbeatCutoverMetrics();
    expect(m.claim_wakeup).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    expect(m.transition_run_fenced).toMatchObject({ totalCalls: 3, tsBypass: 3 });
    expect(m.claim_wakeup.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => WAKE);
    await expect(wireClaimWakeupCutover(CLAIM, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: WAKE });
    await expect(wireClaimWakeupCutover(CLAIM, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: WAKE });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getHeartbeatCutoverMetrics().claim_wakeup)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient((method) =>
      method === "heartbeat.claim_wakeup" ? { claimed: WAKE } : APPLIED);
    const opts = { env: ON, getClient: () => client };
    const tsClaim = vi.fn(async () => null);
    const tsTrans = vi.fn(async () => ({ applied: false as const }));

    await expect(wireClaimWakeupCutover(CLAIM, tsClaim, opts)).resolves.toEqual({ source: "rust", value: WAKE });
    await expect(wireTransitionRunFencedCutover(TRANS, tsTrans, opts)).resolves.toEqual({ source: "rust", value: APPLIED });
    expect(tsClaim).not.toHaveBeenCalled();
    expect(tsTrans).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["heartbeat.claim_wakeup", "heartbeat.transition_run_fenced"]);
    const m = getHeartbeatCutoverMetrics();
    expect(m.claim_wakeup).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    expect(m.transition_run_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 0 });
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => WAKE);
    await expect(wireClaimWakeupCutover(CLAIM, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: WAKE });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getHeartbeatCutoverMetrics().claim_wakeup)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsClaim = vi.fn(async () => WAKE);
    const tsTrans = vi.fn(async () => APPLIED);
    const opts = { env: ON, getClient: () => client };
    await expect(wireClaimWakeupCutover(CLAIM, tsClaim, opts))
      .rejects.toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    await expect(wireTransitionRunFencedCutover(TRANS, tsTrans, opts))
      .rejects.toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    expect(tsClaim).not.toHaveBeenCalled();
    expect(tsTrans).not.toHaveBeenCalled();
    const m = getHeartbeatCutoverMetrics();
    expect(m.claim_wakeup).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    expect(m.transition_run_fenced).toMatchObject({ indeterminateError: 1 });
  });

  it("propagates Rust fence mismatch { applied: false } untouched; counts rustSuccess + fenceMismatch", async () => {
    const { client } = stubClient(() => ({ applied: false }));
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireTransitionRunFencedCutover(TRANS, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getHeartbeatCutoverMetrics().transition_run_fenced)
      .toMatchObject({ rustSuccess: 1, fenceMismatch: 1, tsFallback: 0 });
  });

  it("counts fenceMismatch for TS-originated { applied: false } as well", async () => {
    await expect(wireTransitionRunFencedCutover(TRANS, async () => ({ applied: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(getHeartbeatCutoverMetrics().transition_run_fenced)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustSuccess: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireClaimWakeupCutover(CLAIM, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getHeartbeatCutoverMetrics().claim_wakeup)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ company_id: "not-a-uuid", agent_id: NIL });
    await expect(wireClaimWakeupCutover(params, async () => null, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: null });
    expect(params).toEqual({ company_id: "not-a-uuid", agent_id: NIL });
  });

  it("createHeartbeatCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "heartbeat.claim_wakeup" ? { claimed: WAKE } : APPLIED);
    const events: HeartbeatCutoverTelemetryEvent[] = [];
    const hooks = createHeartbeatCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.claimWakeup(CLAIM, vi.fn(async () => null)))
      .resolves.toEqual({ source: "rust", value: WAKE });
    await expect(hooks.transitionRunFenced(TRANS, vi.fn(async () => ({ applied: false }))))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.claimWakeup(CLAIM, async () => WAKE, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: WAKE });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.claim_wakeup).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.transition_run_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getHeartbeatCutoverMetrics().claim_wakeup.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireClaimWakeupCutover(CLAIM, async () => WAKE, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: HeartbeatCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: WAKE });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getHeartbeatCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireClaimWakeupCutover(CLAIM, async () => WAKE, { env: OFF });
    const snap = getHeartbeatCutoverMetrics();
    Object.assign(snap.claim_wakeup, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.transition_run_fenced, { totalCalls: 999 });
    const fresh = getHeartbeatCutoverMetrics();
    expect(fresh.claim_wakeup).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.transition_run_fenced.totalCalls).toBe(0);

    resetHeartbeatCutoverMetricsForTests();
    const zeroed = getHeartbeatCutoverMetrics();
    expect(zeroed.claim_wakeup.totalCalls).toBe(0);
    expect(zeroed.transition_run_fenced.totalCalls).toBe(0);
  });
});

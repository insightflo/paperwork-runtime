import { describe, expect, it, vi } from "vitest";
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
  createHeartbeatCutoverWiring,
  getHeartbeatCutoverTelemetry,
  resetHeartbeatCutoverTelemetry,
  wireClaimWakeupWithCutover,
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

function stubClient(script: (method: string, params?: unknown) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => {
      calls.push({ method, params, callOpts });
      return script(method, params);
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);

describe("heartbeat-cutover-wiring", () => {
  it("flag OFF routes directly to TS without resolving client and records flag_off telemetry", async () => {
    const getClient = vi.fn(() => stubClient(() => ({ claimed: WAKE })).client);
    const wiring = createHeartbeatCutoverWiring({ getClient, defaultEnv: OFF });
    const tsFallback = vi.fn(async () => WAKE);

    const res = await wiring.claimWakeup(CLAIM, tsFallback);
    expect(res).toEqual({ source: "ts", value: WAKE });
    expect(getClient).not.toHaveBeenCalled();
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(wiring.getTelemetry()).toMatchObject({
      rustHits: 0,
      tsFallbacks: 1,
      indeterminateErrors: 0,
      byOperation: { claim_wakeup: { rustHits: 0, tsFallbacks: 1, indeterminateErrors: 0 } },
      byReason: { flag_off: 1 },
    });
  });

  it("flag ON succeeds via Rust for claim and transition and increments rustHits", async () => {
    const { client, calls } = stubClient((method) =>
      method === "heartbeat.claim_wakeup" ? { claimed: WAKE } : APPLIED,
    );
    const wiring = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const tsClaim = vi.fn(async () => null);
    const tsTrans = vi.fn(async () => ({ applied: false as const }));

    await expect(wiring.claimWakeup(CLAIM, tsClaim)).resolves.toEqual({ source: "rust", value: WAKE });
    await expect(wiring.transitionRunFenced(TRANS, tsTrans, { timeoutMs: 25_000 }))
      .resolves.toEqual({ source: "rust", value: APPLIED });

    expect(tsClaim).not.toHaveBeenCalled();
    expect(tsTrans).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[1].callOpts).toEqual({ timeoutMs: 25_000 });
    expect(wiring.getTelemetry()).toMatchObject({
      rustHits: 2,
      tsFallbacks: 0,
      byOperation: {
        claim_wakeup: { rustHits: 1, tsFallbacks: 0 },
        transition_run_fenced: { rustHits: 1, tsFallbacks: 0 },
      },
      byReason: { rust_ok: 2 },
    });
  });

  it("propagates fence mismatch ({ applied: false }) from Rust without calling TS fallback", async () => {
    const { client } = stubClient(() => ({ applied: false }));
    const wiring = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const tsFallback = vi.fn(async () => APPLIED);

    const res = await wiring.transitionRunFenced(TRANS, tsFallback);
    expect(res).toEqual({ source: "rust", value: { applied: false } });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(wiring.getTelemetry().rustHits).toBe(1);
  });

  it("falls back to TS on not_committed RPC error (-32001/-32003) and records rpc_not_committed", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const wiring = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const tsFallback = vi.fn(async () => WAKE);

    const res = await wiring.claimWakeup(CLAIM, tsFallback);
    expect(res).toEqual({ source: "ts", value: WAKE });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(wiring.getTelemetry()).toMatchObject({
      rustHits: 0,
      tsFallbacks: 1,
      byReason: { rpc_not_committed: 1 },
    });
  });

  it("propagates HeartbeatCutoverIndeterminateError on client timeout or -32005 without TS fallback", async () => {
    const { client } = stubClient((method) => {
      throw method === "heartbeat.claim_wakeup"
        ? new PaperworkEngineError("timeout", "client deadline exceeded")
        : rpc(-32005);
    });
    const wiring = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const tsClaim = vi.fn(async () => WAKE);
    const tsTrans = vi.fn(async () => APPLIED);

    await expect(wiring.claimWakeup(CLAIM, tsClaim)).rejects.toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    await expect(wiring.transitionRunFenced(TRANS, tsTrans)).rejects.toBeInstanceOf(HeartbeatCutoverIndeterminateError);
    expect(tsClaim).not.toHaveBeenCalled();
    expect(tsTrans).not.toHaveBeenCalled();
    expect(wiring.getTelemetry()).toMatchObject({
      rustHits: 0,
      tsFallbacks: 0,
      indeterminateErrors: 2,
      byOperation: {
        claim_wakeup: { indeterminateErrors: 1 },
        transition_run_fenced: { indeterminateErrors: 1 },
      },
      byReason: { indeterminate: 2 },
    });
  });

  it("routes inTransaction, null client, client init error, and ineligible inputs to TS with exact reasons", async () => {
    const { client, calls } = stubClient(() => APPLIED);
    const wiringOk = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const wiringNull = createHeartbeatCutoverWiring({ getClient: () => null, defaultEnv: ON });
    const wiringThrow = createHeartbeatCutoverWiring({
      getClient: () => { throw new Error("spawn init fail"); },
      defaultEnv: ON,
    });

    await wiringOk.transitionRunFenced(TRANS, async () => APPLIED, { inTransaction: true });
    await wiringOk.transitionRunFenced({ ...TRANS, extra_patch: { process_pid: 9 } }, async () => APPLIED);
    await wiringOk.transitionRunFenced({ ...TRANS, next_status: "running" }, async () => ({ applied: false }));
    await wiringOk.claimWakeup({ company_id: "non-uuid-co", agent_id: NIL }, async () => null);
    await wiringNull.claimWakeup(CLAIM, async () => null);
    await wiringThrow.claimWakeup(CLAIM, async () => null);

    expect(calls).toHaveLength(0);
    expect(wiringOk.getTelemetry().byReason).toMatchObject({ in_transaction: 1, ineligible_input: 3 });
    expect(wiringNull.getTelemetry().byReason.client_unavailable).toBe(1);
    expect(wiringThrow.getTelemetry().byReason.client_init_error).toBe(1);
  });

  it("enforces strict input validation for empty IDs, invalid statuses, and out-of-range timeouts", async () => {
    const wiring = createHeartbeatCutoverWiring({ getClient: () => null, defaultEnv: ON });
    const noop = async () => null;
    const noopTrans = async () => ({ applied: false as const });

    await expect(wiring.claimWakeup({ company_id: "  ", agent_id: NIL }, noop)).rejects.toThrow(RangeError);
    await expect(wiring.claimWakeup({ company_id: NIL, agent_id: "" }, noop)).rejects.toThrow(RangeError);
    await expect(wiring.claimWakeup(CLAIM, noop, { timeoutMs: 1_000 })).rejects.toThrow(RangeError);
    await expect(wiring.claimWakeup(CLAIM, noop, { timeoutMs: 600_001 })).rejects.toThrow(RangeError);
    await expect(wiring.claimWakeup(CLAIM, noop, { timeoutMs: 17_000.5 })).rejects.toThrow(RangeError);
    await expect(wiring.transitionRunFenced({ ...TRANS, run_id: "" }, noopTrans)).rejects.toThrow(RangeError);
    await expect(wiring.transitionRunFenced({ ...TRANS, next_status: "bogus" as never }, noopTrans)).rejects.toThrow(RangeError);
    await expect(wiring.transitionRunFenced({ ...TRANS, expected_statuses: Array(1) }, noopTrans)).rejects.toThrow(RangeError);
    expect(wiring.getTelemetry()).toMatchObject({ rustHits: 0, tsFallbacks: 0, indeterminateErrors: 0 });
  });

  it("exposes clean typed hook adapters preserving exact TS return shapes and supports telemetry reset", async () => {
    const { client } = stubClient((method) =>
      method === "heartbeat.claim_wakeup" ? { claimed: WAKE } : APPLIED,
    );
    const wiring = createHeartbeatCutoverWiring({ getClient: () => client, defaultEnv: ON });
    const claimHook = wiring.createClaimWakeupHook(async () => null);
    const transHook = wiring.createTransitionRunFencedHook(async () => ({ applied: false }));

    expect(await claimHook(CLAIM)).toEqual(WAKE);
    expect(await transHook(TRANS)).toEqual(APPLIED);
    expect(wiring.getTelemetry().rustHits).toBe(2);

    const snap = wiring.getTelemetry();
    snap.rustHits = 999;
    expect(wiring.getTelemetry().rustHits).toBe(2);
    wiring.resetTelemetry();
    expect(wiring.getTelemetry().rustHits).toBe(0);

    resetHeartbeatCutoverTelemetry();
    await wireClaimWakeupWithCutover(CLAIM, async () => null, { env: OFF });
    expect(getHeartbeatCutoverTelemetry().byReason.flag_off).toBe(1);
    resetHeartbeatCutoverTelemetry();
  });
});

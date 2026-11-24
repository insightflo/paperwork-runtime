import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPaperworkEngineClient, PaperworkEngineError, type PaperworkEngineClient,
} from "../services/paperwork-engine-client.js";
import {
  claimHeartbeatWakeup, classifyHeartbeatRpcError, listStaleHeartbeatRuns,
  transitionHeartbeatRunFenced, validateHeartbeatTransition,
} from "../services/paperwork-engine-heartbeat.js";
import { resolveDefaultPaperworkEngineBin } from "../services/paperwork-engine-runtime.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WAKE = {
  id: "11111111-1111-1111-1111-111111111111", company_id: NIL, agent_id: NIL,
  source: "issue_assigned", reason: null, idempotency_key: "k1", payload: { x: 1 },
  requested_at: "2026-01-01T00:00:00Z", claimed_at: "2026-01-01T00:00:01Z",
};
const STALE = {
  id: NIL, company_id: NIL, agent_id: NIL, process_pid: null,
  process_loss_retry_count: 0, updated_at: "2026-01-01T00:00:00Z",
};

/** Minimal PaperworkEngineClient stub: records calls, returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown) => (calls.push({ method, params }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const errCall = (code: number, message = "m") => Promise.reject(new PaperworkEngineError("rpc_error", message, code));

describe("heartbeat.* typed RPC methods", () => {
  it("validateHeartbeatTransition: legal/illegal results and snake_case params", async () => {
    const { client, calls } = stub({
      "heartbeat.validate_transition": { valid: true, sets_started_at: true, sets_finished_at: false },
    });
    await expect(validateHeartbeatTransition(client, {
      expected_statuses: ["queued"], next_status: "running",
    })).resolves.toEqual({ valid: true, sets_started_at: true, sets_finished_at: false });
    expect(calls[0]).toEqual({
      method: "heartbeat.validate_transition",
      params: { expected_statuses: ["queued"], next_status: "running" },
    });
    const s = stub({ "heartbeat.validate_transition": { valid: false, reason: "illegal_transition", from: "succeeded", to: "running" } });
    await expect(validateHeartbeatTransition(s.client, {
      expected_statuses: ["succeeded"], next_status: "running",
    })).resolves.toEqual({ valid: false, reason: "illegal_transition", from: "succeeded", to: "running" });
  });
  it("validateHeartbeatTransition rejects malformed results and bad params", async () => {
    for (const bad of [null, 1, { valid: true }, { valid: "yes" },
      { valid: false, reason: "bogus", from: "queued", to: "running" },
      { valid: false, reason: "illegal_transition", from: "bogus", to: "running" }]) {
      const { client } = stub({ "heartbeat.validate_transition": bad });
      await expect(validateHeartbeatTransition(client, { expected_statuses: ["queued"], next_status: "running" }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const { client, calls } = stub({});
    await expect(validateHeartbeatTransition(client, { expected_statuses: [], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(validateHeartbeatTransition(client, { expected_statuses: ["nope" as never], next_status: "running" })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
  it("claimHeartbeatWakeup unwraps claimed wakeup or null; snake_case params", async () => {
    const { client, calls } = stub({ "heartbeat.claim_wakeup": { claimed: WAKE } });
    await expect(claimHeartbeatWakeup(client, { company_id: NIL, agent_id: NIL })).resolves.toEqual(WAKE);
    expect(calls[0]).toEqual({
      method: "heartbeat.claim_wakeup", params: { company_id: NIL, agent_id: NIL },
    });
    const none = stub({ "heartbeat.claim_wakeup": { claimed: null } });
    await expect(claimHeartbeatWakeup(none.client, { company_id: NIL, agent_id: NIL })).resolves.toBeNull();
    for (const bad of [null, {}, { claimed: "x" }, { claimed: { ...WAKE, id: 1 } }, { claimed: { ...WAKE, payload: undefined } }]) {
      const c = stub({ "heartbeat.claim_wakeup": bad });
      await expect(claimHeartbeatWakeup(c.client, { company_id: NIL, agent_id: NIL }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    await expect(claimHeartbeatWakeup(stub({}).client, { company_id: "no", agent_id: NIL })).rejects.toThrow(RangeError);
  });
  it("transitionHeartbeatRunFenced maps applied/discarded and omits undefined optionals", async () => {
    const applied = { applied: true, run_id: NIL, status: "succeeded", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z" };
    const { client, calls } = stub({ "heartbeat.transition_run_fenced": applied });
    await expect(transitionHeartbeatRunFenced(client, {
      run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "succeeded",
    })).resolves.toEqual(applied);
    expect(calls[0]).toEqual({
      method: "heartbeat.transition_run_fenced",
      params: { run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "succeeded" },
    });
    const withErr = stub({ "heartbeat.transition_run_fenced": { applied: false } });
    await expect(transitionHeartbeatRunFenced(withErr.client, {
      run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "failed",
      error: "boom", error_code: "E1",
    })).resolves.toEqual({ applied: false });
    expect(withErr.calls[0].params).toMatchObject({ error: "boom", error_code: "E1", next_status: "failed" });
    for (const bad of [null, {}, { applied: "yes" }, { applied: true, run_id: NIL, status: "bogus" },
      { applied: false, run_id: NIL, status: "failed" }, { applied: false, extra: 1 }]) {
      const c = stub({ "heartbeat.transition_run_fenced": bad });
      await expect(transitionHeartbeatRunFenced(c.client, {
        run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "failed",
      })).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listStaleHeartbeatRuns unwraps runs array; validates rows and limit", async () => {
    const { client, calls } = stub({ "heartbeat.list_stale_runs": { runs: [STALE] } });
    await expect(listStaleHeartbeatRuns(client, {
      company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 10,
    })).resolves.toEqual([STALE]);
    await expect(listStaleHeartbeatRuns(client, { company_id: NIL, stale_before: "0000-02-29T00:00:00Z", limit: 10 })).resolves.toEqual([STALE]);
    expect(calls[0]).toEqual({
      method: "heartbeat.list_stale_runs",
      params: { company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 10 },
    });
    for (const bad of [null, {}, { runs: "x" }, { runs: [{ ...STALE, process_loss_retry_count: "x" }] },
      { runs: [{ ...STALE, process_pid: 1.5 }] }, { runs: [{ ...STALE, updated_at: 3 }] }]) {
      const c = stub({ "heartbeat.list_stale_runs": bad });
      await expect(listStaleHeartbeatRuns(c.client, { company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 5 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const c2 = stub({});
    await expect(listStaleHeartbeatRuns(c2.client, { company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 1.5 })).rejects.toThrow(RangeError);
    expect(c2.calls).toHaveLength(0);
  });
  it("rejects malformed UUID/RFC3339 response fields (protocol_error)", async () => {
    for (const claimed of [
      { ...WAKE, id: "nope" }, { ...WAKE, agent_id: 7 },
      { ...WAKE, requested_at: "2026-01-01" }, { ...WAKE, requested_at: "not-a-date" },
      { ...WAKE, claimed_at: "yesterday" }, { ...WAKE, requested_at: "2026-02-30T00:00:00Z" },
    ]) {
      const c = stub({ "heartbeat.claim_wakeup": { claimed } });
      await expect(claimHeartbeatWakeup(c.client, { company_id: NIL, agent_id: NIL }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const applied = { applied: true, run_id: NIL, status: "succeeded", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z" };
    for (const bad of [{ ...applied, run_id: "zzz" }, { ...applied, finished_at: "2026-13-01T00:00:00Z" }, { ...applied, started_at: 0 },
      { ...applied, finished_at: "2026-02-30T00:00:00Z" }, { ...applied, started_at: "2025-02-29T00:00:00Z" }]) {
      const c = stub({ "heartbeat.transition_run_fenced": bad });
      await expect(transitionHeartbeatRunFenced(c.client, {
        run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "succeeded",
      })).rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const run of [{ ...STALE, id: "x" }, { ...STALE, company_id: "x" }, { ...STALE, updated_at: "soon" }, { ...STALE, updated_at: "2026-01-01T00:00:00" }]) {
      const c = stub({ "heartbeat.list_stale_runs": { runs: [run] } });
      await expect(listStaleHeartbeatRuns(c.client, { company_id: NIL, stale_before: "2030-01-01T00:00:00Z", limit: 5 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("rejects bad inputs before the call: error types, illegal transitions, stale_before", async () => {
    const s = stub({});
    const fenced = (p: Parameters<typeof transitionHeartbeatRunFenced>[1]) => transitionHeartbeatRunFenced(s.client, p);
    const base = { run_id: NIL, company_id: NIL, expected_statuses: ["running" as const], next_status: "failed" as const };
    await expect(fenced({ ...base, error: 5 as never })).rejects.toThrow(RangeError);
    await expect(fenced({ ...base, error_code: {} as never })).rejects.toThrow(RangeError);
    await expect(fenced({ ...base, expected_statuses: ["succeeded"], next_status: "failed" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...base, expected_statuses: ["queued"], next_status: "timed_out" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...base, next_status: "queued" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...base, expected_statuses: Array(1) })).rejects.toThrow(RangeError); // sparse hole -> undefined
    expect(s.calls).toHaveLength(0);
    const ls = stub({ "heartbeat.list_stale_runs": { runs: [] } });
    for (const stale_before of [new Date(NaN), "not-a-date", "2030-01-01", "2030-01-01T00:00:00", 42]) {
      await expect(listStaleHeartbeatRuns(ls.client, { company_id: NIL, stale_before: stale_before as never, limit: 1 })).rejects.toThrow(RangeError);
    }
    await expect(listStaleHeartbeatRuns(ls.client, { company_id: NIL, stale_before: new Date("2030-06-15T12:00:00Z"), limit: 1 })).resolves.toEqual([]);
    expect(ls.calls[0].params).toMatchObject({ stale_before: "2030-06-15T12:00:00.000Z" });
    expect(ls.calls).toHaveLength(1);
    // legal queued -> failed still reaches the wire
    const ok = stub({ "heartbeat.transition_run_fenced": { applied: false } });
    await expect(transitionHeartbeatRunFenced(ok.client, { run_id: NIL, company_id: NIL, expected_statuses: ["queued"], next_status: "failed" })).resolves.toEqual({ applied: false });
  });
});

describe("classifyHeartbeatRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("maps every heartbeat RPC code to its commit contract", async () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      await expect(errCall(rpcCode)).rejects.toMatchObject({ code: "rpc_error", rpcCode });
      const c = classifyHeartbeatRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode));
      expect(c).toEqual({ kind, outcome, retryable });
    }
  });
  it("fails closed: unknown codes and transport errors are indeterminate/never-retry", () => {
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyHeartbeatRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyHeartbeatRpcError(new PaperworkEngineError("rpc_error", "m", -32000))).toEqual(unknown);
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "bin_not_configured", "queue_full"] as const) {
      expect(classifyHeartbeatRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyHeartbeatRpcError(e)).toEqual(unknown);
    }
    Object.assign(classifyHeartbeatRpcError(new PaperworkEngineError("rpc_error", "m", -32001)), { kind: "bogus" });
    expect(classifyHeartbeatRpcError(new PaperworkEngineError("rpc_error", "m", -32001))).toEqual({ kind: "timeout", outcome: "not_committed", retryable: true });
  });
});

// A directory can carry the +x bit: require a regular file AND executable access.
const usable = (b: string | null): b is string => {
  try { return b !== null && statSync(b).isFile() && (accessSync(b, constants.X_OK), true); } catch { return false; }
};

describe("real paperwork-engine binary (smoke)", () => {
  let bin: string | null = null;
  beforeAll(() => {
    bin = resolveDefaultPaperworkEngineBin();
    if (!usable(bin)) bin = null;
    // An explicit PAPERWORK_ENGINE_BIN is authoritative: when it resolves to a
    // non-executable path (e.g. /dev/null) skip instead of spawning -> EACCES.
    if (!bin && process.env.PAPERWORK_ENGINE_BIN === undefined
      && spawnSync("cargo", ["build", "-p", "paperwork-engine"], { cwd: REPO_ROOT }).status === 0) {
      const rebuilt = resolveDefaultPaperworkEngineBin();
      bin = usable(rebuilt) ? rebuilt : null;
    }
  });
  it("usable() requires a regular +x file (dirs can carry +x)", () => {
    expect(usable(REPO_ROOT)).toBe(false); expect(usable(process.execPath)).toBe(true);
  });
  it("validate_transition legal/illegal + claim_wakeup unconfigured -32002", async (ctx) => {
    if (!bin) return ctx.skip();
    const env = { ...process.env };
    delete env.DATABASE_URL; // engine reads ProbeEnv::from_process() -> -32002 pre-dial
    const client = createPaperworkEngineClient({
      bin,
      spawnFn: ((b: string, a: readonly string[], o: SpawnOptionsWithoutStdio) =>
        spawn(b, a, { ...o, env })) as typeof spawn,
    });
    try {
      await expect(client.health()).resolves.toMatchObject({ ok: true, engine: "paperwork-engine" });
      await expect(validateHeartbeatTransition(client, {
        expected_statuses: ["queued"], next_status: "running",
      })).resolves.toEqual({ valid: true, sets_started_at: true, sets_finished_at: false });
      await expect(validateHeartbeatTransition(client, {
        expected_statuses: ["succeeded"], next_status: "running",
      })).resolves.toEqual({ valid: false, reason: "illegal_transition", from: "succeeded", to: "running" });
      const err = await claimHeartbeatWakeup(client, { company_id: NIL, agent_id: NIL }).then(
        () => { throw new Error("expected rpc_error"); }, (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PaperworkEngineError);
      expect(err).toMatchObject({ code: "rpc_error", rpcCode: -32002 });
      expect(classifyHeartbeatRpcError(err)).toEqual({ kind: "unconfigured", outcome: "not_committed", retryable: false });
    } finally {
      await client.close();
    }
  });
});

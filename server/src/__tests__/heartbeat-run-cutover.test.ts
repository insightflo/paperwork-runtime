import { describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  HEARTBEAT_RUN_CUTOVER_ADAPTERS, HeartbeatRunCutoverIndeterminateError,
  isHeartbeatRunAgentParamsEligible, isHeartbeatRunCutoverEnabled,
  runHeartbeatAgentWithCutover,
} from "../services/heartbeat-run-cutover.js";
import type {
  HeartbeatRunAgentParams, HeartbeatRunAgentResult,
} from "../services/paperwork-engine-heartbeat-run.js";

const ON = { PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: "1" };
const BASE: HeartbeatRunAgentParams = {
  adapter: "pi_local", executable: "/bin/sh", cwd: "/tmp", timeout_ms: 5_000,
};
const OK: HeartbeatRunAgentResult = {
  status: "succeeded", exit_code: 0, signal: null, error: null, error_code: null,
  unreaped_pid: null, stdout_excerpt: "out", stderr_excerpt: "",
  stdout_captured_bytes: 3, stderr_captured_bytes: 0,
};
const TS_RESULT: HeartbeatRunAgentResult = { ...OK, status: "failed", error: "ts" };

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

describe("isHeartbeatRunCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isHeartbeatRunCutoverEnabled({ PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isHeartbeatRunCutoverEnabled({ PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: v })).toBe(false);
    }
    expect(isHeartbeatRunCutoverEnabled({})).toBe(false);
  });
  it("allowlist holds exactly the engine-supported local adapters", () => {
    expect(HEARTBEAT_RUN_CUTOVER_ADAPTERS).toEqual(["pi_local", "commandcode_local"]);
  });
});

describe("runHeartbeatAgentWithCutover gating", () => {
  it("flag OFF returns the TS result without any RPC", async () => {
    const { client, calls } = stub(() => OK);
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("flag ON + null client stays on the TS path", async () => {
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(runHeartbeatAgentWithCutover(null, BASE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("flag ON + non-allowlisted adapter stays on the TS path with no RPC", async () => {
    const { client, calls } = stub(() => OK);
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(runHeartbeatAgentWithCutover(
      client, { ...BASE, adapter: "bogus" as never }, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("flag ON + eligible params uses heartbeat.run_agent once and returns source rust", async () => {
    const { client, calls } = stub(() => OK);
    const tsFallback = vi.fn();
    const params = { ...BASE, args: ["-c", "exit 0"], env: { A: "1" }, grace_ms: 100 };
    await expect(runHeartbeatAgentWithCutover(client, params, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: OK });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      method: "heartbeat.run_agent",
      params: {
        adapter: "pi_local", executable: "/bin/sh", args: ["-c", "exit 0"],
        env: { A: "1" }, cwd: "/tmp", timeout_ms: 5_000, grace_ms: 100,
      },
      callOpts: { timeoutMs: 10_100 }, // 5000 + 100 grace + 5000 slack
    }]);
  });
});

describe("runHeartbeatAgentWithCutover error classification", () => {
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS", async (code) => {
      const { client, calls } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => TS_RESULT);
      await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: TS_RESULT });
      expect(calls).toHaveLength(1);
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
    await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "HeartbeatRunCutoverIndeterminateError",
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const err = await runHeartbeatAgentWithCutover(client, BASE, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatRunCutoverIndeterminateError);
    expect(err).toMatchObject({
      operation: "run_agent",
      classification: { kind: "commit_indeterminate" },
      cause: error,
    });
  });
});

describe("runHeartbeatAgentWithCutover pre-spawn eligibility", () => {
  const ineligible: [string, HeartbeatRunAgentParams][] = [
    ["relative executable", { ...BASE, executable: "bin/sh" }],
    ["empty executable", { ...BASE, executable: "" }],
    ["NUL in executable", { ...BASE, executable: "/bin/sh\0x" }],
    ["relative cwd", { ...BASE, cwd: "tmp" }],
    ["NUL in cwd", { ...BASE, cwd: "/tmp\0x" }],
    ["non-string arg", { ...BASE, args: [1] as never }],
    ["NUL arg", { ...BASE, args: ["a\0b"] }],
    ["sparse args", { ...BASE, args: Array(1) }],
    ["non-array args", { ...BASE, args: "x" as never }],
    ["env empty key", { ...BASE, env: { "": "v" } }],
    ["env key with '='", { ...BASE, env: { "K=V": "v" } }],
    ["env NUL key", { ...BASE, env: { "K\0": "v" } }],
    ["env NUL value", { ...BASE, env: { K: "v\0" } }],
    ["non-string env value", { ...BASE, env: { K: 1 } as never }],
    ["non-plain env object", { ...BASE, env: new Date() as never }],
    ["env array", { ...BASE, env: [] as never }],
    ["timeout_ms zero", { ...BASE, timeout_ms: 0 }],
    ["timeout_ms above max", { ...BASE, timeout_ms: 3_600_001 }],
    ["timeout_ms non-integer", { ...BASE, timeout_ms: 1.5 }],
    ["timeout_ms NaN", { ...BASE, timeout_ms: Number.NaN }],
    ["grace_ms negative", { ...BASE, grace_ms: -1 }],
    ["grace_ms above max", { ...BASE, grace_ms: 60_001 }],
    ["grace_ms non-integer", { ...BASE, grace_ms: 0.5 }],
  ];
  it.each(ineligible)("ineligible input (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => OK);
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(runHeartbeatAgentWithCutover(client, params, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
  it("isHeartbeatRunAgentParamsEligible mirrors the typed client's pre-send rules", () => {
    expect(isHeartbeatRunAgentParamsEligible(BASE)).toBe(true);
    expect(isHeartbeatRunAgentParamsEligible({ ...BASE, adapter: "commandcode_local" })).toBe(true);
    expect(isHeartbeatRunAgentParamsEligible({ ...BASE, adapter: "pi" as never })).toBe(false);
    expect(isHeartbeatRunAgentParamsEligible({ ...BASE, args: new Array(1) })).toBe(false);
  });
});

describe("runHeartbeatAgentWithCutover success contract", () => {
  it("returns an unreaped_pid result AS-IS (caller owns reap) with no fallback", async () => {
    const handoff = {
      ...OK, status: "failed" as const, error: "waitpid deadline expired",
      error_code: "reap_handoff_pending", unreaped_pid: 4242,
    };
    const { client, calls } = stub(() => handoff);
    const tsFallback = vi.fn();
    await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: handoff });
    expect(calls).toHaveLength(1);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("returns a reap_handoff_pending result AS-IS even when unreaped_pid is null", async () => {
    const handoff = { ...OK, error_code: "reap_handoff_pending" };
    const { client } = stub(() => handoff);
    const tsFallback = vi.fn();
    await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: handoff });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("normal success is returned with source rust", async () => {
    const { client } = stub(() => OK);
    const tsFallback = vi.fn();
    await expect(runHeartbeatAgentWithCutover(client, BASE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: OK });
    expect(tsFallback).not.toHaveBeenCalled();
  });
});

describe("runHeartbeatAgentWithCutover transport timeout", () => {
  it("derives deadline as timeout_ms + grace_ms + 5s when opts.timeoutMs is absent", async () => {
    const { client, calls } = stub(() => OK);
    await runHeartbeatAgentWithCutover(client, BASE, vi.fn(), { env: ON });
    expect(timeoutOf(calls[0])).toBe(15_000); // 5000 + default 5000 + 5000
    await runHeartbeatAgentWithCutover(client, { ...BASE, grace_ms: 100 }, vi.fn(), { env: ON });
    expect(timeoutOf(calls[1])).toBe(10_100); // 5000 + 100 + 5000
  });
  it.each([[1.9, 1], [0, 1], [-5, 1], [600_001, 600_000]])(
    "explicit opts.timeoutMs %s clamps to engine-valid %s", async (ms, want) => {
      const { client, calls } = stub(() => OK);
      await runHeartbeatAgentWithCutover(client, BASE, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
  it("non-finite opts.timeoutMs falls back to the derived deadline", async () => {
    const { client, calls } = stub(() => OK);
    await runHeartbeatAgentWithCutover(client, BASE, vi.fn(), { env: ON, timeoutMs: Number.NaN });
    expect(timeoutOf(calls[0])).toBe(15_000);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  HeartbeatRunAgentParams, HeartbeatRunAgentResult,
} from "../services/paperwork-engine-heartbeat-run.js";
import type {
  HeartbeatRunCutoverTelemetryEvent,
} from "../services/heartbeat-run-cutover-wiring.js";

const ADAPTER = "../services/heartbeat-run-cutover.js";
const WIRING = "../services/heartbeat-run-cutover-wiring.js";
type Wiring = typeof import("../services/heartbeat-run-cutover-wiring.js");
type Adapter = typeof import("../services/heartbeat-run-cutover.js");

const ON = { PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: "1" };
const OFF = {};
const BASE: HeartbeatRunAgentParams = {
  adapter: "pi_local", executable: "/bin/sh", cwd: "/tmp", timeout_ms: 5_000,
};
const OK: HeartbeatRunAgentResult = {
  status: "succeeded", exit_code: 0, signal: null, error: null, error_code: null,
  unreaped_pid: null, stdout_excerpt: "out", stderr_excerpt: "",
  stdout_captured_bytes: 3, stderr_captured_bytes: 0,
};
const TS_RESULT: HeartbeatRunAgentResult = { ...OK, status: "failed", error: "ts" };
const HANDOFF_PID: HeartbeatRunAgentResult = { ...OK, status: "failed", unreaped_pid: 4242 };
const HANDOFF_CODE: HeartbeatRunAgentResult = { ...OK, error_code: "reap_handoff_pending" };

const loadWiring = (): Promise<Wiring> => import(WIRING);
const metricsOf = (w: Wiring) => w.getHeartbeatRunCutoverMetrics().run_agent;

/** Adapter-boundary mock: the real module with a scripted runHeartbeatAgentWithCutover. */
async function loadWithAdapterMock() {
  const runMock = vi.fn();
  vi.doMock(ADAPTER, async (importOriginal) => {
    const actual = await importOriginal<Adapter>();
    return { ...actual, runHeartbeatAgentWithCutover: runMock };
  });
  const wiring = await loadWiring();
  const adapter = (await import(ADAPTER)) as Adapter;
  return { wiring, runMock, adapter };
}

/** PaperworkEngineClient stub: records calls and runs a script — real adapter path. */
function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const fakeClient = () => stubClient(() => OK).client;
/** Fresh-registry PaperworkEngineError: after resetModules the adapter's instanceof
 *  only matches the class from the same registry — never the static import. */
const rpc = async (code: number) => {
  const { PaperworkEngineError } = await import("../services/paperwork-engine-client.js");
  return new PaperworkEngineError("rpc_error", `e${code}`, code);
};
const hostileError = () => Object.defineProperty(new Error("boom"), "stack",
  { get() { throw new Error("stack-getter-boom"); } });
const collect = () => {
  const events: HeartbeatRunCutoverTelemetryEvent[] = [];
  return { events, onEvent: (e: HeartbeatRunCutoverTelemetryEvent) => { events.push(e); } };
};

beforeEach(() => {
  vi.resetModules();
  // vi.doMock registrations outlive resetModules; clear the adapter mock per test.
  vi.doUnmock(ADAPTER);
});

describe("adapter-boundary scripted outcomes", () => {
  it("rust result without unreaped child → rust_ok passthrough, no tsFallback", async () => {
    const { wiring, runMock } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    const tsFallback = vi.fn(async () => TS_RESULT);
    runMock.mockResolvedValue({ source: "rust", value: OK });
    const res = await wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: fakeClient, onEvent });
    expect(res).toEqual({ source: "rust", value: OK });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 1, rustOk: 1, fallback: 0, indeterminate: 0, unreapedHandoff: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(
      { operation: "run_agent", outcome: "rust_ok", source: "rust" });
  });

  it.each([
    ["unreaped_pid 4242", HANDOFF_PID],
    ["error_code reap_handoff_pending", HANDOFF_CODE],
  ])("unreaped handoff (%s) returns AS-IS; unreapedHandoff 1, non-retryable", async (_l, handoff) => {
    const { wiring, runMock } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    const tsFallback = vi.fn(async () => TS_RESULT);
    runMock.mockResolvedValue({ source: "rust", value: handoff });
    const res = await wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: fakeClient, onEvent });
    expect(res.source).toBe("rust");
    expect(res.value).toBe(handoff); // AS-IS: same object, never re-run/fallback/signaled
    expect(tsFallback).not.toHaveBeenCalled();
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 1, unreapedHandoff: 1, rustOk: 0, fallback: 0 });
    expect(events.map((e) => e.outcome)).toEqual(["unreaped_handoff"]);
    expect(events[0].source).toBe("rust");
  });

  it("adapter returns { source: ts } → fallback 1, outcome fallback", async () => {
    const { wiring, runMock } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    runMock.mockResolvedValue({ source: "ts", value: TS_RESULT });
    const res = await wiring.wireRunHeartbeatAgentCutover(BASE, vi.fn(),
      { env: ON, getClient: fakeClient, onEvent });
    expect(res).toEqual({ source: "ts", value: TS_RESULT });
    expect(metricsOf(wiring)).toMatchObject({ totalCalls: 1, fallback: 1, rustOk: 0 });
    expect(events.map((e) => e.outcome)).toEqual(["fallback"]);
    expect(events[0].source).toBe("ts");
  });

  it("adapter throws HeartbeatRunCutoverIndeterminateError → rethrown, tsFallback never runs", async () => {
    const { wiring, runMock, adapter } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    const err = new adapter.HeartbeatRunCutoverIndeterminateError(
      { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false },
      new Error("rpc_-32005"));
    runMock.mockRejectedValue(err);
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: fakeClient, onEvent })).rejects.toBe(err);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 1, indeterminate: 1, rustOk: 0, fallback: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "indeterminate", source: null });
  });

  it("adapter throws non-indeterminate (tsFallback failed inside) → ts_error rethrow", async () => {
    const { wiring, runMock } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    const failure = new Error("db gone");
    runMock.mockRejectedValue(failure);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, vi.fn(),
      { env: ON, getClient: fakeClient, onEvent })).rejects.toBe(failure);
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 1, rustOk: 0, fallback: 0, indeterminate: 0, unreapedHandoff: 0 });
    expect(events.map((e) => e.outcome)).toEqual(["ts_error"]);
  });
});

describe("real adapter + fake client flag/bypass routing", () => {
  it("flag OFF (unset/'0'/'true') calls tsFallback directly; client never resolved", async () => {
    const wiring = await loadWiring();
    const getClient = vi.fn(fakeClient);
    const tsFallback = vi.fn(async () => TS_RESULT);
    const { events, onEvent } = collect();
    for (const env of [OFF,
      { PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: "0" },
      { PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER: "true" }]) {
      await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
        { env, getClient, onEvent })).resolves.toEqual({ source: "ts", value: TS_RESULT });
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(tsFallback).toHaveBeenCalledTimes(3);
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 3, rustOk: 0, fallback: 0, indeterminate: 0, unreapedHandoff: 0 });
    expect(events.map((e) => e.outcome)).toEqual(["ts_bypass", "ts_bypass", "ts_bypass"]);
  });

  it("flag ON + getClient null or throwing → ts_bypass, adapter RPC never reached", async () => {
    const wiring = await loadWiring();
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: () => { throw hostileError(); } }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(metricsOf(wiring)).toMatchObject({ totalCalls: 2, rustOk: 0, fallback: 0 });
  });

  it("flag ON + real RPC success → rust_ok through the real adapter path", async () => {
    const wiring = await loadWiring();
    const { client, calls } = stubClient(() => OK);
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: () => client })).resolves.toEqual({ source: "rust", value: OK });
    expect(calls.map((c) => c.method)).toEqual(["heartbeat.run_agent"]);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(metricsOf(wiring)).toMatchObject({ rustOk: 1, unreapedHandoff: 0 });
  });

  it("flag ON + real not_committed rpc → adapter fallback → fallback counter", async () => {
    const wiring = await loadWiring();
    const { client, calls } = stubClient(async () => { throw await rpc(-32003); });
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(calls).toHaveLength(1);
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(metricsOf(wiring)).toMatchObject({ fallback: 1, rustOk: 0, indeterminate: 0 });
  });

  it("flag ON + real commit_indeterminate rpc → IndeterminateError, never tsFallback", async () => {
    const wiring = await loadWiring();
    const { HeartbeatRunCutoverIndeterminateError } = await import(ADAPTER);
    const { client } = stubClient(async () => { throw await rpc(-32005); });
    const tsFallback = vi.fn(async () => TS_RESULT);
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, tsFallback,
      { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(HeartbeatRunCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(metricsOf(wiring)).toMatchObject({ indeterminate: 1, rustOk: 0, fallback: 0 });
  });

  it("tsFallback rejection on the bypass path → rethrown, ts_error, only totalCalls", async () => {
    const wiring = await loadWiring();
    const failure = new Error("db gone");
    const { events, onEvent } = collect();
    await expect(wiring.wireRunHeartbeatAgentCutover(BASE, async () => { throw failure; },
      { env: OFF, onEvent })).rejects.toBe(failure);
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 1, rustOk: 0, fallback: 0, indeterminate: 0, unreapedHandoff: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "ts_error", source: "ts" });
  });

  it("throwing/rejecting onEvent observers are swallowed (safeWarn), never mask outcome", async () => {
    const wiring = await loadWiring();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res1 = await wiring.wireRunHeartbeatAgentCutover(BASE, async () => OK,
        { env: OFF, onEvent: () => { throw hostileError(); } });
      expect(res1).toEqual({ source: "ts", value: OK });
      const res2 = await wiring.wireRunHeartbeatAgentCutover(BASE, async () => OK, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as
          (e: HeartbeatRunCutoverTelemetryEvent) => void,
      });
      expect(res2).toEqual({ source: "ts", value: OK });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("createHeartbeatRunCutoverHooks + module meter", () => {
  it("has an independent meter and merges per-call opts over bound defaults", async () => {
    const { wiring, runMock } = await loadWithAdapterMock();
    const { events, onEvent } = collect();
    const hooks = wiring.createHeartbeatRunCutoverHooks(
      { env: OFF, getClient: fakeClient, onEvent });
    await expect(hooks.runHeartbeatAgent(BASE, async () => TS_RESULT))
      .resolves.toEqual({ source: "ts", value: TS_RESULT });
    expect(runMock).not.toHaveBeenCalled(); // bound env OFF → bypass before adapter
    runMock.mockResolvedValue({ source: "rust", value: OK });
    await expect(hooks.runHeartbeatAgent(BASE, vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "rust", value: OK });
    expect(runMock).toHaveBeenCalledTimes(1); // per-call env ON overrode bound OFF
    expect(events.map((e) => e.outcome)).toEqual(["ts_bypass", "rust_ok"]);
    expect(hooks.getMetrics().run_agent).toMatchObject({ totalCalls: 2, rustOk: 1 });
    expect(metricsOf(wiring).totalCalls).toBe(0); // module meter untouched by hooks
  });

  it("getHeartbeatRunCutoverMetrics deep-copies; resetHeartbeatRunCutoverMetricsForTests zeroes", async () => {
    const wiring = await loadWiring();
    await wiring.wireRunHeartbeatAgentCutover(BASE, async () => OK, { env: OFF });
    const snap = metricsOf(wiring);
    Object.assign(snap, { totalCalls: 999, rustOk: 999 });
    expect(metricsOf(wiring)).toMatchObject({ totalCalls: 1, rustOk: 0 });
    wiring.resetHeartbeatRunCutoverMetricsForTests();
    expect(metricsOf(wiring)).toMatchObject(
      { totalCalls: 0, totalDurationMs: 0, rustOk: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  REDACTED_UNSCANNED, REDACTOR_MAX_TEXT_BYTES,
} from "../services/paperwork-engine-redactor.js";
import {
  createRedactorCutoverHooks, getRedactorCutoverMetrics,
  isRustRedactorCutoverEnabled, redactTextWithCutover,
  resetRedactorCutoverMetricsForTests, type RedactorCutoverTelemetryEvent,
} from "../services/redactor-cutover.js";

const mocks = vi.hoisted(() => ({
  getShared: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: mocks.getShared,
}));

vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn } }));

const SECRET = "tok sk-ant-abc123def456 ok";
const ON = { PAPERWORK_RUST_REDACTOR_CUTOVER: "1" };
const OFF = {};

function stubClient(result: unknown) {
  const call = vi.fn(async () => result);
  return { client: { call } as unknown as PaperworkEngineClient, call };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getShared.mockReset();
  mocks.warn.mockReset();
  resetRedactorCutoverMetricsForTests();
});

describe("isRustRedactorCutoverEnabled", () => {
  it("is enabled only by the literal '1'", () => {
    expect(isRustRedactorCutoverEnabled(ON)).toBe(true);
    for (const env of [
      OFF,
      { PAPERWORK_RUST_REDACTOR_CUTOVER: "0" },
      { PAPERWORK_RUST_REDACTOR_CUTOVER: "true" },
      { PAPERWORK_RUST_REDACTOR_CUTOVER: "01" },
    ]) {
      expect(isRustRedactorCutoverEnabled(env)).toBe(false);
    }
  });
});

describe("redactTextWithCutover", () => {
  it("flag OFF routes to the legacy redactor with zero RPC and no client resolution", async () => {
    const getClient = vi.fn(() => stubClient({}).client);
    const legacy = vi.fn((t: string) => `legacy:${t}`);
    for (const env of [OFF, { PAPERWORK_RUST_REDACTOR_CUTOVER: "0" },
      { PAPERWORK_RUST_REDACTOR_CUTOVER: "true" }]) {
      await expect(redactTextWithCutover(SECRET, legacy, { env, getClient }))
        .resolves.toEqual({ source: "legacy", value: `legacy:${SECRET}` });
    }
    expect(legacy).toHaveBeenCalledTimes(3);
    expect(getClient).not.toHaveBeenCalled();
    expect(mocks.getShared).not.toHaveBeenCalled();
    const m = getRedactorCutoverMetrics();
    expect(m).toMatchObject({ totalCalls: 3, legacy: 3, rustOk: 0, failClosed: 0 });
    expect(m.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON returns the engine-redacted string and counts rustOk", async () => {
    const { client, call } = stubClient({ redacted: "tok [redacted] ok", changed: true });
    const legacy = vi.fn();
    await expect(redactTextWithCutover(SECRET, legacy,
      { env: ON, engineClient: client, timeoutMs: 42 }))
      .resolves.toEqual({ source: "rust", value: "tok [redacted] ok" });
    expect(call).toHaveBeenCalledWith(
      "redactor.redact_text", { text: SECRET }, { timeoutMs: 42 });
    expect(legacy).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics())
      .toMatchObject({ rustOk: 1, failClosed: 0, legacy: 0 });
  });

  it("flag ON resolves the shared client by default and an injected getClient lazily", async () => {
    const shared = stubClient({ redacted: "a", changed: false });
    mocks.getShared.mockReturnValue(shared.client);
    await expect(redactTextWithCutover("a", vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "rust", value: "a" });
    expect(mocks.getShared).toHaveBeenCalledTimes(1);

    const injected = stubClient({ redacted: "b", changed: false });
    const getClient = vi.fn(() => injected.client);
    await expect(redactTextWithCutover("b", vi.fn(), { env: ON, getClient }))
      .resolves.toEqual({ source: "rust", value: "b" });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(mocks.getShared).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown]>([
    ["transport timeout", new Error("timeout")],
    ["process exit", new Error("engine exited")],
  ])("flag ON + RPC failure (%s) returns the sentinel, counts failClosed, never calls legacy", async (_label, error) => {
    const call = vi.fn().mockRejectedValue(error);
    const client = { call } as unknown as PaperworkEngineClient;
    const legacy = vi.fn();
    const res = await redactTextWithCutover(SECRET, legacy, { env: ON, engineClient: client });
    expect(res).toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    expect(res.value).not.toContain("sk-ant-abc123def456");
    expect(legacy).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics())
      .toMatchObject({ failClosed: 1, rustOk: 0, legacy: 0 });
  });

  it("flag ON + null/failed client resolution returns the sentinel, not legacy, not a throw", async () => {
    const legacy = vi.fn();
    await expect(redactTextWithCutover(SECRET, legacy, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    await expect(redactTextWithCutover(SECRET, legacy, {
      env: ON, engineClient: null,
      getClient: () => { throw new Error("must not be reached"); },
    })).resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    await expect(redactTextWithCutover(SECRET, legacy, {
      env: ON, getClient: () => { throw new Error("spawn failed"); },
    })).resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    expect(legacy).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics())
      .toMatchObject({ failClosed: 3, totalCalls: 3, rustOk: 0, legacy: 0 });
  });

  it.each<[string, unknown]>([
    ["number", 42], ["null", null], ["undefined", undefined],
    ["object", { text: "x" }], ["array", ["x"]], ["boolean", true],
  ])("non-string input (%s) returns the sentinel and counts failClosed (flag ON and OFF)", async (_label, input) => {
    const getClient = vi.fn();
    const legacy = vi.fn();
    for (const env of [ON, OFF]) {
      await expect(redactTextWithCutover(input, legacy, { env, getClient }))
        .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    }
    expect(legacy).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics())
      .toMatchObject({ failClosed: 2, totalCalls: 2 });
  });

  it.each<[string, string]>([
    ["ascii one over", "y".repeat(REDACTOR_MAX_TEXT_BYTES + 1)],
    ["multibyte over bytes", "€".repeat(Math.floor(REDACTOR_MAX_TEXT_BYTES / 3) + 1)],
    ["ill-formed lone surrogate", "a\ud800b"],
  ])("flag ON + %s short-circuits to the sentinel without client resolution or RPC", async (_label, input) => {
    const getClient = vi.fn();
    const legacy = vi.fn();
    await expect(redactTextWithCutover(input, legacy, { env: ON, getClient }))
      .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    expect(getClient).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics()).toMatchObject({ failClosed: 1 });
  });

  it.each<[string, unknown]>([
    ["sentinel value", { redacted: REDACTED_UNSCANNED, changed: true }],
    ["malformed response", { redacted: 7, changed: true }],
    ["missing changed", { redacted: "x" }],
  ])("flag ON + engine result (%s) converges to the sentinel counted failClosed", async (_label, reply) => {
    const { client } = stubClient(reply);
    const legacy = vi.fn();
    await expect(redactTextWithCutover(SECRET, legacy, { env: ON, engineClient: client }))
      .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    expect(legacy).not.toHaveBeenCalled();
    expect(getRedactorCutoverMetrics()).toMatchObject({ failClosed: 1, rustOk: 0 });
  });

  it("legacy redactor errors propagate with an error-bearing event and still count legacy", async () => {
    const failure = new Error("db gone");
    const events: RedactorCutoverTelemetryEvent[] = [];
    await expect(redactTextWithCutover("x", () => { throw failure; },
      { env: OFF, onEvent: (e) => events.push(e) })).rejects.toBe(failure);
    expect(events[0])
      .toMatchObject({ source: "legacy", outcome: "legacy", error: failure });
    expect(getRedactorCutoverMetrics()).toMatchObject({ legacy: 1, totalCalls: 1 });
  });
});

describe("telemetry", () => {
  it("emits structured onEvent telemetry for every path", async () => {
    const events: RedactorCutoverTelemetryEvent[] = [];
    const onEvent = (e: RedactorCutoverTelemetryEvent) => { events.push(e); };
    const { client } = stubClient({ redacted: "x!", changed: true });
    await redactTextWithCutover("x", (t) => t, { env: OFF, onEvent });
    await redactTextWithCutover("x", vi.fn(), { env: ON, engineClient: client, onEvent });
    await redactTextWithCutover(42, vi.fn(), { env: ON, onEvent });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ source: "legacy", outcome: "legacy" });
    expect(events[1]).toMatchObject({ source: "rust", outcome: "rust_ok" });
    expect(events[2]).toMatchObject({
      source: "fail-closed", outcome: "fail_closed", reason: "invalid_input",
    });
    for (const e of events) expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("getRedactorCutoverMetrics returns a deep copy; reset zeroes every counter", async () => {
    await redactTextWithCutover("x", (t) => t, { env: OFF });
    await redactTextWithCutover("x", vi.fn(), { env: ON, getClient: () => null });
    const snap = getRedactorCutoverMetrics();
    expect(snap).toMatchObject({ totalCalls: 2, legacy: 1, failClosed: 1, rustOk: 0 });
    Object.assign(snap, { legacy: 999, totalCalls: 999 });
    expect(getRedactorCutoverMetrics())
      .toMatchObject({ totalCalls: 2, legacy: 1, failClosed: 1 });
    resetRedactorCutoverMetricsForTests();
    expect(getRedactorCutoverMetrics()).toEqual({
      rustOk: 0, failClosed: 0, legacy: 0, totalCalls: 0, totalDurationMs: 0,
    });
  });

  it("a throwing onEvent observer never masks the result (sync + async)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(redactTextWithCutover("x", (t) => t, {
        env: OFF, onEvent: () => { throw new Error("observer boom"); },
      })).resolves.toEqual({ source: "legacy", value: "x" });
      await expect(redactTextWithCutover("x", (t) => t, {
        env: OFF,
        onEvent: (async () => { throw new Error("async boom"); }) as unknown as
          (e: RedactorCutoverTelemetryEvent) => void,
      })).resolves.toEqual({ source: "legacy", value: "x" });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a throwing logger never masks the outcome", async () => {
    mocks.warn.mockImplementation(() => { throw new Error("pino boom"); });
    await expect(redactTextWithCutover(42, vi.fn(), { env: ON }))
      .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
    await expect(redactTextWithCutover("x", vi.fn(), { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "fail-closed", value: REDACTED_UNSCANNED });
  });
});

describe("createRedactorCutoverHooks", () => {
  it("binds defaults, merges per-call opts, and isolates its meter", async () => {
    const { client } = stubClient({ redacted: "r", changed: true });
    const events: RedactorCutoverTelemetryEvent[] = [];
    const hooks = createRedactorCutoverHooks({
      env: ON, engineClient: client, onEvent: (e) => events.push(e),
    });
    await expect(hooks.redactText("x", vi.fn()))
      .resolves.toEqual({ source: "rust", value: "r" });
    await expect(hooks.redactText("x", (t) => `l:${t}`, { env: OFF }))
      .resolves.toEqual({ source: "legacy", value: "l:x" });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "legacy"]);
    expect(hooks.getMetrics())
      .toMatchObject({ totalCalls: 2, rustOk: 1, legacy: 1, failClosed: 0 });
    expect(getRedactorCutoverMetrics().totalCalls).toBe(0);
  });
});

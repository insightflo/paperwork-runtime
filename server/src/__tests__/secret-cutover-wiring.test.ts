import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  SecretBumpLatestVersionFencedResult, SecretMetadata, SecretVersionMetadata,
} from "../services/paperwork-engine-secret.js";
import { SecretCutoverIndeterminateError } from "../services/secret-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import { logger } from "../middleware/logger.js";
import {
  createSecretCutoverHooks,
  getSecretCutoverMetrics,
  resetSecretCutoverMetricsForTests,
  wireSecretBumpLatestVersionFencedCutover,
  wireSecretGetByIdCutover,
  wireSecretGetByNameCutover,
  wireSecretListCutover,
  wireSecretListVersionsCutover,
  SECRET_WIRED_OPERATIONS,
  type SecretCutoverTelemetryEvent,
} from "../services/secret-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: vi.fn(() => null),
}));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_SECRET_CUTOVER: "1" }, OFF = {};
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-06-02T00:00:00Z";
const SECRET: SecretMetadata = {
  id: NIL, company_id: NIL, name: "api-key", provider: "local_encrypted",
  external_ref: null, latest_version: 2, description: null,
  created_by_agent_id: U1, created_by_user_id: "u1", created_at: T0, updated_at: T1,
};
const VERSION: SecretVersionMetadata = {
  id: NIL, secret_id: U1, version: 2, created_by_agent_id: U1,
  created_by_user_id: "u1", created_at: T0, revoked_at: null,
};
const LIST = { company_id: NIL };
const GET_ID = { company_id: NIL, secret_id: U1 };
const GET_NAME = { company_id: NIL, name: "api-key" };
const VERSIONS = { company_id: NIL, secret_id: U1 };
const BUMP = { company_id: NIL, secret_id: U1, expected_latest_version: 2, new_version: 3 };
const APPLIED: SecretBumpLatestVersionFencedResult = { applied: true, secret: SECRET };
const FENCED: SecretBumpLatestVersionFencedResult = { applied: false, reason: "fenced" };

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
const sharedClient = vi.mocked(getSharedPaperworkEngineClient);

beforeEach(() => {
  resetSecretCutoverMetricsForTests();
  sharedClient.mockReset().mockReturnValue(null);
  vi.mocked(logger.warn).mockClear();
});

describe("secret-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all five ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    const events: SecretCutoverTelemetryEvent[] = [];
    for (const env of [OFF, { PAPERWORK_RUST_SECRET_CUTOVER: "0" }, { PAPERWORK_RUST_SECRET_CUTOVER: "true" }]) {
      const o = { env, getClient, onEvent: (e: SecretCutoverTelemetryEvent) => { events.push(e); } };
      await expect(wireSecretListCutover(LIST, async () => ({ secrets: [SECRET] }), o)).resolves.toEqual({ source: "ts", value: { secrets: [SECRET] } });
      await expect(wireSecretGetByIdCutover(GET_ID, async () => ({ secret: SECRET }), o)).resolves.toEqual({ source: "ts", value: { secret: SECRET } });
      await expect(wireSecretGetByNameCutover(GET_NAME, async () => ({ secret: null }), o)).resolves.toEqual({ source: "ts", value: { secret: null } });
      await expect(wireSecretListVersionsCutover(VERSIONS, async () => ({ versions: [VERSION] }), o)).resolves.toEqual({ source: "ts", value: { versions: [VERSION] } });
      await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, async () => APPLIED, o)).resolves.toEqual({ source: "ts", value: APPLIED });
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClient).not.toHaveBeenCalled();
    expect(events).toHaveLength(15);
    expect(events.every((e) => e.outcome === "ts_bypass" && e.source === "ts" && e.durationMs >= 0)).toBe(true);
    const m = getSecretCutoverMetrics();
    for (const op of SECRET_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0, indeterminate: 0, tsError: 0 });
    }
  });

  it("flag ON + null/throwing getClient or null shared client warns and fails safe to tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPLIED });
    // default resolver path: mocked shared client returning null also bypasses
    await expect(wireSecretGetByIdCutover(GET_ID, async () => ({ secret: null }), { env: ON }))
      .resolves.toEqual({ source: "ts", value: { secret: null } });
    expect(sharedClient).toHaveBeenCalledTimes(1);
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(3);
    const m = getSecretCutoverMetrics();
    expect(m.bump_latest_version_fenced).toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0 });
    expect(m.get_by_id).toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("flag ON + Rust success returns source rust, increments rustOk, emits rust_ok, clamps timeoutMs", async () => {
    const { client, calls } = stubClient((method) =>
      method === "secret.list" ? { secrets: [SECRET] } : APPLIED);
    const events: SecretCutoverTelemetryEvent[] = [];
    const opts = { env: ON, getClient: () => client, onEvent: (e: SecretCutoverTelemetryEvent) => { events.push(e); } };
    const tsWrite = vi.fn(async () => FENCED);
    const tsRead = vi.fn(async () => ({ secrets: [] as SecretMetadata[] }));

    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsWrite, opts))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(wireSecretListCutover(LIST, tsRead, opts))
      .resolves.toEqual({ source: "rust", value: { secrets: [SECRET] } });
    // explicit timeoutMs below the write floor still clamps to 17s
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsWrite, { ...opts, timeoutMs: 5 }))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    expect(tsWrite).not.toHaveBeenCalled();
    expect(tsRead).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual([
      "secret.bump_latest_version_fenced", "secret.list", "secret.bump_latest_version_fenced"]);
    expect(calls.map((c) => (c.callOpts as { timeoutMs: number }).timeoutMs))
      .toEqual([17_000, 10_000, 17_000]);
    expect(events.map((e) => [e.outcome, e.source]))
      .toEqual([["rust_ok", "rust"], ["rust_ok", "rust"], ["rust_ok", "rust"]]);
    const m = getSecretCutoverMetrics();
    expect(m.bump_latest_version_fenced).toMatchObject({ rustOk: 2, tsBypass: 0, fallback: 0 });
    expect(m.list).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0 });
  });

  it("flag ON + ANY read error falls back to the TS reader (fallback counter)", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => ({ versions: [] as SecretVersionMetadata[] }));
    await expect(wireSecretListVersionsCutover(VERSIONS, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: { versions: [] } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getSecretCutoverMetrics().list_versions)
      .toMatchObject({ fallback: 1, indeterminate: 0, rustOk: 0 });
  });

  it.each([-32001, -32004])("flag ON + not_committed write rpc %i falls back to tsFallback (fallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getSecretCutoverMetrics().bump_latest_version_fenced)
      .toMatchObject({ fallback: 1, tsBypass: 0, rustOk: 0, indeterminate: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(SecretCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getSecretCutoverMetrics().bump_latest_version_fenced)
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0 });
  });

  it("fenced write result {applied:false,reason:'fenced'} is rust_ok, never a fallback", async () => {
    const { client } = stubClient(() => FENCED);
    const tsFallback = vi.fn(async () => APPLIED);
    const events: SecretCutoverTelemetryEvent[] = [];
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, {
      env: ON, getClient: () => client, onEvent: (e) => { events.push(e); },
    })).resolves.toEqual({ source: "rust", value: FENCED });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(events.map((e) => [e.outcome, e.source])).toEqual([["rust_ok", "rust"]]);
    expect(getSecretCutoverMetrics().bump_latest_version_fenced)
      .toMatchObject({ rustOk: 1, fallback: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws (bypass path)", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async (): Promise<never> => { throw failure; });
    await expect(wireSecretListCutover(LIST, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getSecretCutoverMetrics().list)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("counts tsError and rethrows when the adapter-driven tsFallback throws (rust path)", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async (): Promise<never> => { throw failure; });
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBe(failure);
    expect(getSecretCutoverMetrics().bump_latest_version_fenced)
      .toMatchObject({ totalCalls: 1, tsError: 1, fallback: 0, rustOk: 0 });
  });

  it("read pre-send validation error still routes through the adapter fallback, params not mutated", async () => {
    const params = Object.freeze({ company_id: NIL, name: "   " });
    const { client } = stubClient(() => ({ secret: null }));
    await expect(wireSecretGetByNameCutover(params, async () => ({ secret: null }), {
      env: ON, getClient: () => client,
    })).resolves.toEqual({ source: "ts", value: { secret: null } });
    expect(params).toEqual({ company_id: NIL, name: "   " });
    expect(getSecretCutoverMetrics().get_by_name).toMatchObject({ fallback: 1, tsBypass: 0 });
  });

  it("createSecretCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "secret.list" ? { secrets: [SECRET] } : APPLIED);
    const events: SecretCutoverTelemetryEvent[] = [];
    const hooks = createSecretCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.listSecretsWired(LIST, vi.fn(async () => ({ secrets: [] as SecretMetadata[] }))))
      .resolves.toEqual({ source: "rust", value: { secrets: [SECRET] } });
    await expect(hooks.bumpSecretLatestVersionFencedWired(BUMP, vi.fn(async () => FENCED)))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && e.durationMs >= 0)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.getSecretByIdWired(GET_ID, async () => ({ secret: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { secret: null } });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.list).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.bump_latest_version_fenced).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.get_by_id).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(hooks.snapshot()).toEqual(m);
    // hooks meter is independent of the module-level meter
    expect(getSecretCutoverMetrics().list.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireSecretGetByNameCutover(GET_NAME, async () => ({ secret: null }), {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: SecretCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: { secret: null } });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getSecretCutoverMetrics returns a deep copy with exact counter names over all wired ops", async () => {
    await wireSecretGetByIdCutover(GET_ID, async () => ({ secret: null }), { env: OFF });
    const snap = getSecretCutoverMetrics();
    expect(Object.keys(snap.get_by_id).sort()).toEqual(
      ["fallback", "indeterminate", "rustOk", "totalCalls", "totalDurationMs", "tsBypass", "tsError"]);
    Object.assign(snap.get_by_id, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list, { totalCalls: 999 });
    const fresh = getSecretCutoverMetrics();
    expect(fresh.get_by_id).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list.totalCalls).toBe(0);

    resetSecretCutoverMetricsForTests();
    const zeroed = getSecretCutoverMetrics();
    for (const op of SECRET_WIRED_OPERATIONS) {
      expect(zeroed[op]).toMatchObject({
        rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0, tsError: 0,
        totalCalls: 0, totalDurationMs: 0,
      });
    }
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => APPLIED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(SecretCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getSecretCutoverMetrics().bump_latest_version_fenced)
      .toMatchObject({ indeterminate: 1, fallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireSecretBumpLatestVersionFencedCutover(BUMP, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getSecretCutoverMetrics().bump_latest_version_fenced).toMatchObject({ tsBypass: 1 });
  });
});

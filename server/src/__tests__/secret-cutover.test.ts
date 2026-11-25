import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifySecretRpcError, type SecretBumpLatestVersionFencedParams,
} from "../services/paperwork-engine-secret.js";
import {
  bumpSecretLatestVersionFencedWithCutover, getSecretByIdWithCutover,
  getSecretByNameWithCutover, isSecretEngineCutoverEnabled,
  listSecretsWithCutover, listSecretVersionsWithCutover,
  SecretCutoverIndeterminateError,
  type SecretCutoverCallOpts, type SecretCutoverResult,
} from "../services/secret-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_SECRET_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-06-02T00:00:00Z";
const SECRET = {
  id: NIL, company_id: NIL, name: "api-key", provider: "local_encrypted",
  external_ref: null, latest_version: 2, description: null,
  created_by_agent_id: U1, created_by_user_id: "u1", created_at: T0, updated_at: T1,
};
const VERSION = {
  id: NIL, secret_id: U1, version: 2, created_by_agent_id: U1,
  created_by_user_id: "u1", created_at: T0, revoked_at: null,
};
const LIST = { company_id: NIL } as const;
const GET_ID = { company_id: NIL, secret_id: U1 } as const;
const GET_NAME = { company_id: NIL, name: "api-key" } as const;
const VERSIONS = { company_id: NIL, secret_id: U1 } as const;
const BUMP: SecretBumpLatestVersionFencedParams = {
  company_id: NIL, secret_id: U1, expected_latest_version: 2, new_version: 3,
};
const APPLIED = { applied: true, secret: SECRET } as const;
const FENCED = { applied: false, reason: "fenced" } as const;

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: SecretCutoverCallOpts) => Promise<SecretCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["bump_latest_version_fenced",
    (c, ts, o) => bumpSecretLatestVersionFencedWithCutover(c, BUMP, ts, o),
    APPLIED, APPLIED, "secret.bump_latest_version_fenced", BUMP],
];
// [op, bound call, wire result, resolved value, RPC method, wire params]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["list", (c, ts, o) => listSecretsWithCutover(c, LIST, ts, o),
    { secrets: [SECRET] }, { secrets: [SECRET] }, "secret.list", LIST],
  ["get_by_id", (c, ts, o) => getSecretByIdWithCutover(c, GET_ID, ts, o),
    { secret: SECRET }, { secret: SECRET }, "secret.get_by_id", GET_ID],
  ["get_by_name", (c, ts, o) => getSecretByNameWithCutover(c, GET_NAME, ts, o),
    { secret: SECRET }, { secret: SECRET }, "secret.get_by_name", GET_NAME],
  ["list_versions", (c, ts, o) => listSecretVersionsWithCutover(c, VERSIONS, ts, o),
    { versions: [VERSION] }, { versions: [VERSION] }, "secret.list_versions", VERSIONS],
];

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

afterEach(() => { vi.mocked(logger.warn).mockReset(); });

describe("isSecretEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isSecretEngineCutoverEnabled({ PAPERWORK_RUST_SECRET_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isSecretEngineCutoverEnabled({ PAPERWORK_RUST_SECRET_CUTOVER: v })).toBe(false);
    }
    expect(isSecretEngineCutoverEnabled({})).toBe(false);
  });
  it("opts.env overrides process.env in both directions", async () => {
    const saved = process.env.PAPERWORK_RUST_SECRET_CUTOVER;
    try {
      delete process.env.PAPERWORK_RUST_SECRET_CUTOVER;
      const a = stub(() => APPLIED);
      const tsA = vi.fn(async () => "ts-result" as never);
      await expect(bumpSecretLatestVersionFencedWithCutover(a.client, BUMP, tsA, { env: ON }))
        .resolves.toEqual({ source: "rust", value: APPLIED });
      expect(a.calls).toHaveLength(1);
      expect(tsA).not.toHaveBeenCalled();
      process.env.PAPERWORK_RUST_SECRET_CUTOVER = "1";
      const b = stub(() => APPLIED);
      const tsB = vi.fn(async () => "ts-result" as never);
      await expect(bumpSecretLatestVersionFencedWithCutover(b.client, BUMP, tsB, { env: {} }))
        .resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(b.calls).toHaveLength(0);
      expect(tsB).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.PAPERWORK_RUST_SECRET_CUTOVER;
      else process.env.PAPERWORK_RUST_SECRET_CUTOVER = saved;
    }
  });
});

describe("secret write cutover", () => {
  it.each(WRITES)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => "ts-result" as never);
      for (const env of [{}, { PAPERWORK_RUST_SECRET_CUTOVER: "0" },
        { PAPERWORK_RUST_SECRET_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: "ts-result" });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 17_000 } }]);
    });
  it.each(WRITES)("%s {applied:false,reason:'fenced'} is a rust result, never a fallback",
    async (_n, op) => {
      const { client } = stub(() => FENCED);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: FENCED });
      expect(ts).not.toHaveBeenCalled();
    });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS once", async (code) => {
      for (const [name, op] of WRITES) {
        const { client } = stub(() => { throw rpc(code); });
        const ts = vi.fn(async () => "ts-result" as never);
        await expect(op(client, ts, { env: ON }))
          .resolves.toEqual({ source: "ts", value: "ts-result" });
        expect(ts).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          expect.objectContaining({ operation: name }), expect.any(String));
        vi.mocked(logger.warn).mockReset();
      }
    });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    for (const [name, op] of WRITES) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).rejects.toMatchObject({
        name: "SecretCutoverIndeterminateError",
        operation: name,
        classification: classifySecretRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["bad bump arithmetic", { ...BUMP, new_version: 5 }],
    ["non-uuid secret_id", { ...BUMP, secret_id: "nope" }],
  ])("pre-send RangeError (%s) throws indeterminate with no RPC and no tsFallback",
    async (_l, params) => {
      const { client, calls } = stub(() => APPLIED);
      const ts = vi.fn();
      await expect(bumpSecretLatestVersionFencedWithCutover(client, params, ts, { env: ON }))
        .rejects.toBeInstanceOf(SecretCutoverIndeterminateError);
      expect(calls).toHaveLength(0);
      expect(ts).not.toHaveBeenCalled();
    });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await bumpSecretLatestVersionFencedWithCutover(client, BUMP, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(SecretCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "bump_latest_version_fenced", cause: error });
    expect(err.classification).toEqual(classifySecretRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32004); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(bumpSecretLatestVersionFencedWithCutover(client, BUMP, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32004); });
    const boom = new Error("ts boom");
    await expect(bumpSecretLatestVersionFencedWithCutover(client, BUMP,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[undefined, 17_000], [0, 17_000], [5_000, 17_000], [-9, 17_000],
    [1_000_000, 600_000], [1.5, 17_000], [Number.NaN, 17_000],
    [Number.POSITIVE_INFINITY, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("secret read cutover", () => {
  it.each(READS)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op, _w, want) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => want as never);
      for (const env of [{}, { PAPERWORK_RUST_SECRET_CUTOVER: "0" },
        { PAPERWORK_RUST_SECRET_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: want });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(READS)("%s returns engine rows with snake_case params and the 10s read timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 10_000 } }]);
    });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["rpc -32602", rpc(-32602)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
  ])("any engine error (%s) warns and falls back to TS once", async (_l, error) => {
    for (const [, op, , want] of READS) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn(async () => want as never);
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(ts).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      vi.mocked(logger.warn).mockReset();
    }
  });
  it("pre-send validation errors also fall back on reads", async () => {
    const { client, calls } = stub(() => ({ secret: null }));
    const ts = vi.fn(async () => ({ secret: null }) as never);
    await expect(getSecretByNameWithCutover(client,
      { company_id: NIL, name: "   " }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { secret: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ secret: null }) as never);
    await expect(getSecretByIdWithCutover(client, GET_ID, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { secret: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, 10_000], [0, 1], [5_000, 5_000], [-9, 1], [9_000_000, 600_000],
    [1.5, 1], [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  bumpSecretLatestVersionFenced, classifySecretRpcError, getSecretById, getSecretByName,
  listSecrets, listSecretVersions,
} from "../services/paperwork-engine-secret.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
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
const BUMP = { company_id: NIL, secret_id: U1, expected_latest_version: 2, new_version: 3 } as const;
const BANNED = ["material", "value", "plaintext"] as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results.
 *  SECURITY INVARIANT: every recorded params object is asserted free of banned
 *  material keys (own or inherited), so the metadata-only surface is proven on
 *  the wire for every method in every test, not just spot-checked. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => {
      calls.push({ method, params, callOpts });
      for (const k of BANNED) expect(k in (params as Record<string, unknown>)).toBe(false);
      return results[method];
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const { updated_at: _u, ...secretMissingKey } = SECRET;

describe("secret.* typed RPC methods", () => {
  it("listSecrets unwraps secrets; limit key omitted when undefined, verbatim otherwise", async () => {
    const { client, calls } = stub({ "secret.list": { secrets: [SECRET] } });
    await expect(listSecrets(client, { ...LIST, junk: 1 } as never)).resolves.toEqual({ secrets: [SECRET] });
    expect(calls[0]).toEqual({ method: "secret.list", params: LIST, callOpts: undefined });
    const l = stub({ "secret.list": { secrets: [] } });
    await listSecrets(l.client, { ...LIST, limit: 10 }, { timeoutMs: 9 });
    expect(l.calls[0]).toEqual({ method: "secret.list", params: { ...LIST, limit: 10 }, callOpts: { timeoutMs: 9 } });
    // clamp_list_limit is engine-side: 0 and negatives go over the wire unchanged.
    const z = stub({ "secret.list": { secrets: [] } });
    await listSecrets(z.client, { ...LIST, limit: 0 });
    await listSecrets(z.client, { ...LIST, limit: -9 });
    expect(z.calls[0].params).toEqual({ ...LIST, limit: 0 });
    expect(z.calls[1].params).toEqual({ ...LIST, limit: -9 });
  });
  it("listSecrets gates params and validates the envelope + rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "no" }, { company_id: 5 }, { limit: 1.5 }, { limit: "10" },
      { limit: null }, { limit: 2 ** 53 }, { limit: true },
    ]) {
      await expect(listSecrets(s.client, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { secrets: "x" }, { secrets: null }, { secrets: [SECRET], x: 1 },
      { secrets: [secretMissingKey] }, { secrets: [{ ...SECRET, extra: 1 }] },
      { secrets: [{ ...SECRET, latest_version: 1.5 }] }, { secrets: [{ ...SECRET, latest_version: 2 ** 31 }] },
      { secrets: [{ ...SECRET, external_ref: 0 }] }, { secrets: [{ ...SECRET, description: 5 }] },
      { secrets: [{ ...SECRET, created_by_agent_id: "z" }] }, { secrets: [{ ...SECRET, created_by_user_id: 7 }] },
      { secrets: [{ ...SECRET, created_at: "2026-01-01T24:00:00Z" }] }, { secrets: [{ ...SECRET, provider: null }] }]) {
      const c = stub({ "secret.list": bad });
      await expect(listSecrets(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("getSecretById maps {secret} incl. null; validates rows and params", async () => {
    const { client, calls } = stub({ "secret.get_by_id": { secret: SECRET } });
    await expect(getSecretById(client, { ...GET_ID, junk: 1 } as never)).resolves.toEqual({ secret: SECRET });
    expect(calls[0]).toEqual({ method: "secret.get_by_id", params: GET_ID, callOpts: undefined });
    const n = stub({ "secret.get_by_id": { secret: null } });
    await expect(getSecretById(n.client, GET_ID)).resolves.toEqual({ secret: null });
    for (const bad of [null, {}, { secret: "x" }, { secret: [SECRET] }, { secret: SECRET, x: 1 },
      { secret: secretMissingKey }, { secret: { ...SECRET, extra: 1 } },
      { secret: { ...SECRET, latest_version: "2" } }, { secret: { ...SECRET, name: null } }]) {
      const c = stub({ "secret.get_by_id": bad });
      await expect(getSecretById(c.client, GET_ID)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const p of [{ company_id: "x" }, { secret_id: "x" }, { secret_id: 5 }, { secret_id: null }]) {
      await expect(getSecretById(s.client, { ...GET_ID, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("getSecretByName sends name verbatim; the trim is only for the empty gate", async () => {
    const { client, calls } = stub({ "secret.get_by_name": { secret: SECRET } });
    await expect(getSecretByName(client, { ...GET_NAME, junk: 1 } as never)).resolves.toEqual({ secret: SECRET });
    expect(calls[0]).toEqual({ method: "secret.get_by_name", params: GET_NAME, callOpts: undefined });
    const p = stub({ "secret.get_by_name": { secret: null } });
    await expect(getSecretByName(p.client, { company_id: NIL, name: "  api-key  " }, { timeoutMs: 3 }))
      .resolves.toEqual({ secret: null });
    expect(p.calls[0]).toEqual({
      method: "secret.get_by_name", params: { company_id: NIL, name: "  api-key  " }, callOpts: { timeoutMs: 3 },
    });
    for (const bad of [null, {}, { secret: undefined, x: 1 }, { secret: { ...SECRET, extra: 1 } }]) {
      const c = stub({ "secret.get_by_name": bad });
      await expect(getSecretByName(c.client, GET_NAME)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("getSecretByName gates empty/whitespace/non-string names before any RPC", async () => {
    const s = stub({});
    for (const name of ["", "   ", "\t \n", 5, null, {}] as const) {
      await expect(getSecretByName(s.client, { ...GET_NAME, name: name as never })).rejects.toThrow(RangeError);
    }
    const { name: _n, ...missing } = GET_NAME;
    await expect(getSecretByName(s.client, missing as never)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("listSecretVersions maps versions; limit omit/verbatim; validates rows", async () => {
    const { client, calls } = stub({ "secret.list_versions": { versions: [VERSION] } });
    await expect(listSecretVersions(client, { ...VERSIONS, junk: 1 } as never)).resolves.toEqual({ versions: [VERSION] });
    expect(calls[0]).toEqual({ method: "secret.list_versions", params: VERSIONS, callOpts: undefined });
    const l = stub({ "secret.list_versions": { versions: [] } });
    await listSecretVersions(l.client, { ...VERSIONS, limit: 7 }, { timeoutMs: 2 });
    expect(l.calls[0]).toEqual({
      method: "secret.list_versions", params: { ...VERSIONS, limit: 7 }, callOpts: { timeoutMs: 2 },
    });
    const e = stub({ "secret.list_versions": { versions: [] } });
    await expect(listSecretVersions(e.client, VERSIONS)).resolves.toEqual({ versions: [] });
    for (const bad of [null, {}, { versions: "x" }, { versions: [VERSION], x: 1 },
      { versions: [{ ...VERSION, extra: 1 }] }, { versions: [{ ...VERSION, version: 1.5 }] },
      { versions: [{ ...VERSION, version: 2 ** 31 }] }, { versions: [{ ...VERSION, secret_id: "z" }] },
      { versions: [{ ...VERSION, revoked_at: 0 }] }, { versions: [{ ...VERSION, created_at: "nope" }] }]) {
      const c = stub({ "secret.list_versions": bad });
      await expect(listSecretVersions(c.client, VERSIONS)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    for (const p of [{ secret_id: "z" }, { company_id: 5 }, { limit: 1.5 }, { limit: null }]) {
      await expect(listSecretVersions(s.client, { ...VERSIONS, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("bumpSecretLatestVersionFenced maps the applied union incl. {applied:false,reason:'fenced'}", async () => {
    const { client, calls } = stub({ "secret.bump_latest_version_fenced": { applied: true, secret: SECRET } });
    await expect(bumpSecretLatestVersionFenced(client, { ...BUMP, junk: 1 } as never))
      .resolves.toEqual({ applied: true, secret: SECRET });
    expect(calls[0]).toEqual({ method: "secret.bump_latest_version_fenced", params: BUMP, callOpts: undefined });
    const f = stub({ "secret.bump_latest_version_fenced": { applied: false, reason: "fenced" } });
    await expect(bumpSecretLatestVersionFenced(f.client, BUMP, { timeoutMs: 4 }))
      .resolves.toEqual({ applied: false, reason: "fenced" });
    expect(f.calls[0]).toEqual({ method: "secret.bump_latest_version_fenced", params: BUMP, callOpts: { timeoutMs: 4 } });
  });
  it("bumpSecretLatestVersionFenced gates version arithmetic before any RPC", async () => {
    const s = stub({});
    const go = (p: Record<string, unknown>) => bumpSecretLatestVersionFenced(s.client, { ...BUMP, ...p } as never);
    for (const p of [
      { expected_latest_version: 0 }, { expected_latest_version: -2 }, { expected_latest_version: 1.5 },
      { expected_latest_version: "2" }, { expected_latest_version: 2 ** 31 },
      { expected_latest_version: 2_147_483_647, new_version: 2_147_483_647 }, // i32::MAX has no successor
      { new_version: 2 }, { new_version: 4 }, { new_version: "3" }, { new_version: 1.5 },
      { new_version: 2 ** 31 }, { new_version: null },
      { company_id: "z" }, { secret_id: 5 },
    ]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("bumpSecretLatestVersionFenced validates the union envelope and secret row", async () => {
    for (const bad of [null, {}, { applied: "y" }, { applied: true }, { applied: false },
      { applied: false, reason: "stale" }, { applied: false, reason: null },
      { applied: false, reason: "fenced", x: 1 }, { applied: true, secret: null },
      { applied: true, secret: SECRET, x: 1 }, { applied: true, secret: secretMissingKey },
      { applied: true, secret: { ...SECRET, extra: 1 } }, { applied: true, secret: { ...SECRET, latest_version: "3" } }]) {
      const c = stub({ "secret.bump_latest_version_fenced": bad });
      await expect(bumpSecretLatestVersionFenced(c.client, BUMP)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("SECURITY: banned material keys fail closed — own and inherited, rows and envelopes", async () => {
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [];
    for (const k of BANNED) {
      bad.push(
        ["secret.list", { secrets: [{ ...SECRET, [k]: "x" }] }, (c) => listSecrets(c, LIST)],
        ["secret.list", { secrets: [], [k]: "x" }, (c) => listSecrets(c, LIST)],
        ["secret.get_by_id", { secret: { ...SECRET, [k]: "x" } }, (c) => getSecretById(c, GET_ID)],
        ["secret.get_by_name", { secret: { ...SECRET, [k]: "x" } }, (c) => getSecretByName(c, GET_NAME)],
        ["secret.list_versions", { versions: [{ ...VERSION, [k]: "x" }] }, (c) => listSecretVersions(c, VERSIONS)],
        ["secret.list_versions", { versions: [], [k]: "x" }, (c) => listSecretVersions(c, VERSIONS)],
        ["secret.bump_latest_version_fenced", { applied: true, secret: { ...SECRET, [k]: "x" } },
          (c) => bumpSecretLatestVersionFenced(c, BUMP)],
        ["secret.bump_latest_version_fenced", { applied: false, reason: "fenced", [k]: "x" },
          (c) => bumpSecretLatestVersionFenced(c, BUMP)],
      );
    }
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
    // Inherited-prototype variant: the exact own-key set is satisfied while the
    // banned key rides the prototype chain — only the explicit guard catches it.
    const inh = (proto: object, own: object) => Object.assign(Object.create(proto), own);
    for (const k of BANNED) {
      const proto = { [k]: "x" };
      const cases: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
        ["secret.list", { secrets: [inh(proto, SECRET)] }, (c) => listSecrets(c, LIST)],
        ["secret.list", inh(proto, { secrets: [] }), (c) => listSecrets(c, LIST)],
        ["secret.get_by_id", { secret: inh(proto, SECRET) }, (c) => getSecretById(c, GET_ID)],
        ["secret.get_by_id", inh(proto, { secret: null }), (c) => getSecretById(c, GET_ID)],
        ["secret.get_by_name", { secret: inh(proto, SECRET) }, (c) => getSecretByName(c, GET_NAME)],
        ["secret.list_versions", { versions: [inh(proto, VERSION)] }, (c) => listSecretVersions(c, VERSIONS)],
        ["secret.bump_latest_version_fenced", { applied: true, secret: inh(proto, SECRET) },
          (c) => bumpSecretLatestVersionFenced(c, BUMP)],
        ["secret.bump_latest_version_fenced", inh(proto, { applied: false, reason: "fenced" }),
          (c) => bumpSecretLatestVersionFenced(c, BUMP)],
      ];
      for (const [method, result, invoke] of cases) {
        await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
      }
    }
  });
});

describe("classifySecretRpcError", () => {
  it("delegates to the heartbeat commit contract; unclassified errors are indeterminate", () => {
    expect(classifySecretRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifySecretRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const e of [
      new Error("x"), new PaperworkEngineError("rpc_error", "m", -32601),
      new PaperworkEngineError("timeout", "m"), "x", null, undefined, 42, { rpcCode: -32005 },
    ]) {
      expect(classifySecretRpcError(e)).toEqual(unknown);
    }
  });
});

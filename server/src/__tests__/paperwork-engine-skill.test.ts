import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifySkillRpcError, deleteSkill, getSkillById, getSkillByKey, listSkills, upsertSkill,
  type SkillDeleteParams, type SkillGetByKeyParams, type SkillUpsertParams,
} from "../services/paperwork-engine-skill.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const ROW = {
  id: U1, company_id: NIL, key: "k1", slug: "slug", name: "Name",
  description: null, markdown: "# body", source_type: "local_path",
  source_locator: null, source_ref: null, trust_level: "markdown_only",
  compatibility: "compatible", file_inventory: [], metadata: { skillKey: "k1" },
  created_at: T0, updated_at: T1,
};
const UPSERT: SkillUpsertParams = {
  company_id: NIL, key: "k1", slug: "slug", name: "Name", markdown: "# body",
  source_type: "local_path", trust_level: "markdown_only", compatibility: "compatible",
  file_inventory: [],
};
const BY_KEY: SkillGetByKeyParams = { company_id: NIL, key: "k1" };
const DELETE_P: SkillDeleteParams = { company_id: NIL, skill_id: U1 };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

/** Pre-I/O gate spy: any accidental RPC fails with a non-RangeError. */
function throwingStub() {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => {
      calls.push({ method, params, callOpts });
      throw new Error("client.call must not be reached");
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("skill.* typed RPC methods", () => {
  it("listSkills sends exact params and unwraps validated rows", async () => {
    const { client, calls } = stub({ "skill.list": { skills: [ROW] } });
    await expect(listSkills(client, { company_id: NIL, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual([ROW]);
    expect(calls[0]).toEqual({
      method: "skill.list", params: { company_id: NIL }, callOpts: { timeoutMs: 9 },
    });
    const empty = stub({ "skill.list": { skills: [] } });
    await expect(listSkills(empty.client, { company_id: NIL })).resolves.toEqual([]);
  });

  it("getSkillById and getSkillByKey map found/not-found unions with exact wire params", async () => {
    const byId = stub({ "skill.get_by_id": { found: true, skill: ROW } });
    await expect(getSkillById(byId.client, DELETE_P)).resolves.toEqual({ found: true, skill: ROW });
    expect(byId.calls[0]).toEqual({ method: "skill.get_by_id", params: DELETE_P, callOpts: undefined });
    const missing = stub({ "skill.get_by_id": { found: false } });
    await expect(getSkillById(missing.client, DELETE_P)).resolves.toEqual({ found: false });

    const byKey = stub({ "skill.get_by_key": { found: true, skill: ROW } });
    await expect(getSkillByKey(byKey.client, { ...BY_KEY, junk: 0 } as never))
      .resolves.toEqual({ found: true, skill: ROW });
    expect(byKey.calls[0]).toEqual({ method: "skill.get_by_key", params: BY_KEY, callOpts: undefined });
    const missingKey = stub({ "skill.get_by_key": { found: false } });
    await expect(getSkillByKey(missingKey.client, BY_KEY)).resolves.toEqual({ found: false });
  });

  it("upsertSkill sends exact params; optional undefined omits and null is present", async () => {
    const result = { upserted: true, skill: ROW };
    const { client, calls } = stub({ "skill.upsert": result });
    const omitted = { description: undefined, source_locator: undefined, source_ref: undefined, metadata: undefined };
    await expect(upsertSkill(client, { ...UPSERT, ...omitted, junk: 1 } as never)).resolves.toEqual(result);
    expect(calls[0]).toEqual({ method: "skill.upsert", params: UPSERT, callOpts: undefined });
    expect(Object.keys(calls[0].params as Record<string, unknown>)).toHaveLength(Object.keys(UPSERT).length);

    const nullable = {
      description: null, source_locator: null, source_ref: null, metadata: null,
    };
    const n = stub({ "skill.upsert": result });
    await upsertSkill(n.client, { ...UPSERT, ...nullable });
    expect(n.calls[0].params).toEqual({ ...UPSERT, ...nullable });

    const valued = {
      description: "d", source_locator: "/tmp/s", source_ref: "main", metadata: { a: 1 },
    };
    const v = stub({ "skill.upsert": result });
    await upsertSkill(v.client, { ...UPSERT, ...valued }, { timeoutMs: 7 });
    expect(v.calls[0]).toEqual({
      method: "skill.upsert", params: { ...UPSERT, ...valued }, callOpts: { timeoutMs: 7 },
    });
  });

  it("deleteSkill maps deleted/not-deleted unions with exact wire params", async () => {
    const yes = stub({ "skill.delete": { deleted: true, skill: ROW } });
    await expect(deleteSkill(yes.client, { ...DELETE_P, junk: 0 } as never))
      .resolves.toEqual({ deleted: true, skill: ROW });
    expect(yes.calls[0]).toEqual({ method: "skill.delete", params: DELETE_P, callOpts: undefined });
    const no = stub({ "skill.delete": { deleted: false } });
    await expect(deleteSkill(no.client, DELETE_P)).resolves.toEqual({ deleted: false });
  });

  it("accepts arbitrary JSON file_inventory/metadata in rows read back from the engine", async () => {
    const loose = { ...ROW, file_inventory: { arbitrary: true }, metadata: ["arrays", 1, null] };
    const listed = stub({ "skill.list": { skills: [loose] } });
    await expect(listSkills(listed.client, { company_id: NIL })).resolves.toEqual([loose]);
    const found = stub({ "skill.get_by_key": { found: true, skill: loose } });
    await expect(getSkillByKey(found.client, BY_KEY)).resolves.toEqual({ found: true, skill: loose });
  });

  it("rejects malformed result envelopes and row field types as protocol_error", async () => {
    const noKey = { ...ROW } as Partial<typeof ROW>; delete noKey.key;
    const badRows = [
      noKey, { ...ROW, extra: 1 }, { ...ROW, id: "not-a-uuid" }, { ...ROW, company_id: 5 },
      { ...ROW, source_type: "local" }, { ...ROW, trust_level: "team" },
      { ...ROW, compatibility: "valid" }, { ...ROW, description: 4 },
      { ...ROW, file_inventory: undefined }, { ...ROW, metadata: undefined },
      { ...ROW, created_at: "2026-02-30T00:00:00Z" }, { ...ROW, updated_at: "2026-06-01T24:00:00Z" },
    ];
    for (const skill of badRows) {
      for (const [method, invoke] of [
        ["skill.list", (c: PaperworkEngineClient) => listSkills(c, { company_id: NIL })],
        ["skill.get_by_id", (c: PaperworkEngineClient) => getSkillById(c, DELETE_P)],
        ["skill.get_by_key", (c: PaperworkEngineClient) => getSkillByKey(c, BY_KEY)],
        ["skill.upsert", (c: PaperworkEngineClient) => upsertSkill(c, UPSERT)],
        ["skill.delete", (c: PaperworkEngineClient) => deleteSkill(c, DELETE_P)],
      ] as const) {
        const result = method === "skill.list" ? { skills: [skill] }
          : method === "skill.upsert" ? { upserted: true, skill }
          : method === "skill.delete" ? { deleted: true, skill }
          : { found: true, skill };
        await expect(invoke(stub({ [method]: result }).client))
          .rejects.toMatchObject({ code: "protocol_error" });
      }
    }
  });

  it("rejects missing, extra, and wrongly typed top-level result keys", async () => {
    const cases: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["skill.list", null, (c) => listSkills(c, { company_id: NIL })],
      ["skill.list", {}, (c) => listSkills(c, { company_id: NIL })],
      ["skill.list", { skills: {} }, (c) => listSkills(c, { company_id: NIL })],
      ["skill.list", { skills: [], x: 1 }, (c) => listSkills(c, { company_id: NIL })],
      ["skill.get_by_id", { found: "yes" }, (c) => getSkillById(c, DELETE_P)],
      ["skill.get_by_id", { found: true }, (c) => getSkillById(c, DELETE_P)],
      ["skill.get_by_id", { found: false, skill: ROW }, (c) => getSkillById(c, DELETE_P)],
      ["skill.get_by_key", { found: true, skill: ROW, x: 1 }, (c) => getSkillByKey(c, BY_KEY)],
      ["skill.upsert", { upserted: false, skill: ROW }, (c) => upsertSkill(c, UPSERT)],
      ["skill.upsert", { upserted: true }, (c) => upsertSkill(c, UPSERT)],
      ["skill.upsert", { upserted: true, skill: ROW, x: 1 }, (c) => upsertSkill(c, UPSERT)],
      ["skill.delete", { deleted: "yes" }, (c) => deleteSkill(c, DELETE_P)],
      ["skill.delete", { deleted: true }, (c) => deleteSkill(c, DELETE_P)],
      ["skill.delete", { deleted: false, skill: ROW }, (c) => deleteSkill(c, DELETE_P)],
    ];
    for (const [method, result, invoke] of cases) {
      await expect(invoke(stub({ [method]: result }).client))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
  });

  it("gates invalid params with RangeError before any RPC", async () => {
    const s = throwingStub();
    const upsert = (p: Record<string, unknown>) => upsertSkill(s.client, { ...UPSERT, ...p } as never);
    await expect(listSkills(s.client, { company_id: "no" })).rejects.toThrow(RangeError);
    await expect(getSkillById(s.client, { company_id: NIL, skill_id: "no" })).rejects.toThrow(RangeError);
    await expect(deleteSkill(s.client, { company_id: 1, skill_id: U1 } as never)).rejects.toThrow(RangeError);
    for (const key of ["", "  ", "\t\n"]) {
      await expect(getSkillByKey(s.client, { company_id: NIL, key })).rejects.toThrow(RangeError);
    }
    for (const p of [
      { key: " " }, { slug: "" }, { name: "\t" }, { markdown: "  " },
      { file_inventory: {} }, { file_inventory: "x" }, { file_inventory: null },
      { metadata: [] }, { metadata: "x" }, { metadata: 5 },
      { source_type: "local" }, { trust_level: "team" }, { compatibility: "valid" },
      { description: 4 }, { source_locator: {} }, { source_ref: false },
    ]) {
      await expect(upsert(p)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });

  it("validates UUIDs before non-empty text so every bad input fails pre-I/O", async () => {
    const s = throwingStub();
    await expect(upsertSkill(s.client, { ...UPSERT, company_id: "bad", key: " " } as never))
      .rejects.toThrow(RangeError);
    await expect(getSkillByKey(s.client, { company_id: "bad", key: " " })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
});

describe("classifySkillRpcError", () => {
  it("delegates indeterminate and invalid-param RPC codes to the heartbeat contract", () => {
    expect(classifySkillRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifySkillRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    expect(classifySkillRpcError(new PaperworkEngineError("rpc_error", "m", -32601)))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
    expect(classifySkillRpcError(new PaperworkEngineError("timeout", "m")))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
  });
});

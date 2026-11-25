import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyWorktreeRpcError, createWorktreeRule, deleteWorktreeRule,
  getWorktreeRuleById, listWorktreeRules, toggleWorktreeRuleEnabled, updateWorktreeRule,
} from "../services/paperwork-engine-worktree.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z";
const RULE = {
  id: U1, company_id: NIL, name: "rule", severity: "MUST", action: "tool_call",
  predicate: { resource: "src/**" }, decision_map: { deny: "blocked" }, message: "m",
  enabled: true, version: 1, created_by: "tester", created_at: T0, updated_at: T0,
};
const CREATE = {
  company_id: NIL, name: "rule", severity: "MUST", action: "tool_call",
  predicate: { resource: "src/**" }, decision_map: { deny: "blocked" }, created_by: "tester",
} as const;
const IDS = { company_id: NIL, rule_id: U1 } as const;
const UPDATE = { ...IDS, expected_version: 1 } as const;
const TOGGLE = UPDATE;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => {
      calls.push({ method, params, callOpts });
      if (Object.hasOwn(results, method)) return results[method];
      throw new Error(`unexpected call ${method}`);
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const throwingClient = () => ({
  call: async () => { throw new Error("client.call must not happen"); },
} as unknown as PaperworkEngineClient);
const proto = { code: "protocol_error" };

describe("worktree.* typed RPC methods", () => {
  it("listWorktreeRules maps rules; exact wire keys and enabled_only null/boolean behavior", async () => {
    const { client, calls } = stub({ "worktree.list": { rules: [RULE] } });
    await expect(listWorktreeRules(client, { company_id: NIL, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual({ rules: [RULE] });
    expect(calls[0]).toStrictEqual({
      method: "worktree.list", params: { company_id: NIL }, callOpts: { timeoutMs: 9 },
    });
    for (const enabled_only of [null, true, false] as const) {
      const s = stub({ "worktree.list": { rules: [] } });
      await expect(listWorktreeRules(s.client, { company_id: NIL, enabled_only })).resolves.toEqual({ rules: [] });
      expect(s.calls[0].params).toStrictEqual({ company_id: NIL, enabled_only });
    }
  });

  it("getWorktreeRuleById maps found and missing branches with exact result key sets", async () => {
    const found = stub({ "worktree.get_by_id": { found: true, rule: RULE } });
    await expect(getWorktreeRuleById(found.client, { ...IDS, junk: 1 } as never))
      .resolves.toEqual({ found: true, rule: RULE });
    expect(found.calls[0]).toStrictEqual({
      method: "worktree.get_by_id", params: IDS, callOpts: undefined,
    });
    const missing = stub({ "worktree.get_by_id": { found: false } });
    await expect(getWorktreeRuleById(missing.client, IDS)).resolves.toEqual({ found: false });
    for (const bad of [
      { found: false, rule: RULE }, { found: true }, { found: false, x: 1 },
      { found: true, rule: RULE, x: 1 },
    ]) {
      const s = stub({ "worktree.get_by_id": bad });
      await expect(getWorktreeRuleById(s.client, IDS)).rejects.toMatchObject(proto);
    }
  });

  it("createWorktreeRule sends exact wire keys; optional keys omit/value and JSON null stays null", async () => {
    const created = { created: true, rule: RULE };
    const { client, calls } = stub({ "worktree.create": created });
    await expect(createWorktreeRule(client, { ...CREATE, junk: 1 } as never)).resolves.toEqual(created);
    expect(calls[0]).toStrictEqual({ method: "worktree.create", params: CREATE, callOpts: undefined });
    const full = { ...CREATE, message: "hello", enabled: false, predicate: null, decision_map: null };
    const f = stub({ "worktree.create": created });
    await createWorktreeRule(f.client, full);
    expect(f.calls[0].params).toStrictEqual(full);
  });

  it("createWorktreeRule validates the exact created union and row", async () => {
    for (const bad of [
      null, {}, { created: false, rule: RULE }, { created: true }, { created: true, rule: RULE, x: 1 },
      { created: true, rule: null }, { created: true, rule: { ...RULE, extra: 1 } },
    ]) {
      const s = stub({ "worktree.create": bad });
      await expect(createWorktreeRule(s.client, CREATE)).rejects.toMatchObject(proto);
    }
  });

  it("updateWorktreeRule maps all three branches and omits undefined but preserves explicit null", async () => {
    const ok = stub({ "worktree.update": { updated: true, rule: RULE } });
    await expect(updateWorktreeRule(ok.client, { ...UPDATE, junk: 1 } as never))
      .resolves.toEqual({ updated: true, rule: RULE });
    expect(ok.calls[0].params).toStrictEqual(UPDATE);
    const nullable = {
      ...UPDATE, name: null, severity: null, action: null,
      predicate: null, decision_map: null, message: null,
    };
    const n = stub({ "worktree.update": { updated: false, reason: "not_found" } });
    await expect(updateWorktreeRule(n.client, nullable)).resolves.toEqual({ updated: false, reason: "not_found" });
    expect(n.calls[0].params).toStrictEqual(nullable);
    const conflict = stub({ "worktree.update": { updated: false, reason: "version_conflict", current_version: 3 } });
    await expect(updateWorktreeRule(conflict.client, UPDATE))
      .resolves.toEqual({ updated: false, reason: "version_conflict", current_version: 3 });
    const values = stub({ "worktree.update": { updated: true, rule: RULE } });
    const patch = {
      ...UPDATE, name: "renamed", severity: "SHOULD", action: "file_write",
      predicate: {}, decision_map: {}, message: "updated",
    } as const;
    await updateWorktreeRule(values.client, patch);
    expect(values.calls[0].params).toStrictEqual(patch);
  });

  it("toggleWorktreeRuleEnabled maps the same three-branch union", async () => {
    for (const [result, expected] of [
      [{ updated: true, rule: RULE }, { updated: true, rule: RULE }],
      [{ updated: false, reason: "not_found" }, { updated: false, reason: "not_found" }],
      [{ updated: false, reason: "version_conflict", current_version: 2 },
        { updated: false, reason: "version_conflict", current_version: 2 }],
    ] as const) {
      const s = stub({ "worktree.toggle_enabled": result });
      await expect(toggleWorktreeRuleEnabled(s.client, TOGGLE)).resolves.toEqual(expected);
      expect(s.calls[0]).toStrictEqual({ method: "worktree.toggle_enabled", params: TOGGLE, callOpts: undefined });
    }
  });

  it("deleteWorktreeRule maps true and false exact result shapes", async () => {
    for (const deleted of [true, false] as const) {
      const s = stub({ "worktree.delete": { deleted } });
      await expect(deleteWorktreeRule(s.client, { ...IDS, junk: 1 } as never)).resolves.toEqual({ deleted });
      expect(s.calls[0]).toStrictEqual({ method: "worktree.delete", params: IDS, callOpts: undefined });
    }
    for (const bad of [null, {}, { deleted: "yes" }, { deleted: true, x: 1 }]) {
      const s = stub({ "worktree.delete": bad });
      await expect(deleteWorktreeRule(s.client, IDS)).rejects.toMatchObject(proto);
    }
  });

  it("rejects junk rows: missing/extra keys, wrong types, bad enum/uuid/timestamp/version", async () => {
    const badRows = [
      { ...RULE, severity: "must" }, { ...RULE, action: "shell_exec" },
      { ...RULE, id: "not-a-uuid" }, { ...RULE, company_id: 7 },
      { ...RULE, updated_at: "2026-02-30T00:00:00Z" }, { ...RULE, created_at: "not-a-date" },
      { ...RULE, version: 1.5 }, { ...RULE, enabled: "yes" }, { ...RULE, extra: 1 },
    ];
    for (const row of badRows) {
      const s = stub({ "worktree.list": { rules: [row] } });
      await expect(listWorktreeRules(s.client, { company_id: NIL })).rejects.toMatchObject(proto);
    }
    const { id: _id, ...missingId } = RULE;
    for (const bad of [null, {}, { rules: RULE }, { rules: [missingId] }, { rules: [RULE], extra: 1 }]) {
      const s = stub({ "worktree.list": bad });
      await expect(listWorktreeRules(s.client, { company_id: NIL })).rejects.toMatchObject(proto);
    }
  });

  it("rejects malformed update/toggle unions fail-closed", async () => {
    for (const method of ["worktree.update", "worktree.toggle_enabled"] as const) {
      const invoke = method === "worktree.update" ? updateWorktreeRule : toggleWorktreeRuleEnabled;
      for (const bad of [
        null, {}, { updated: "yes" }, { updated: true }, { updated: true, rule: RULE, x: 1 },
        { updated: false }, { updated: false, reason: "missing" },
        { updated: false, reason: "not_found", current_version: 2 },
        { updated: false, reason: "version_conflict" },
        { updated: false, reason: "version_conflict", current_version: 1.5 },
        { updated: false, reason: "version_conflict", current_version: 2, x: 1 },
      ]) {
        const s = stub({ [method]: bad });
        await expect(invoke(s.client, UPDATE as never)).rejects.toMatchObject(proto);
      }
    }
  });

  it("gates invalid params with RangeError before any client.call", async () => {
    const c = throwingClient();
    const create = (p: object) => createWorktreeRule(c, { ...CREATE, ...p } as never);
    for (const p of [
      { company_id: "no" }, { name: "  " }, { name: 4 }, { created_by: "\t" },
      { severity: "must" }, { action: "shell_exec" }, { predicate: [] }, { predicate: 1 },
      { decision_map: [] }, { decision_map: "x" }, { predicate: undefined }, { decision_map: undefined },
      { enabled: "yes" }, { enabled: null }, { message: null }, { message: 3 },
    ]) await expect(create(p)).rejects.toThrow(RangeError);
    for (const invoke of [
      () => listWorktreeRules(c, { company_id: NIL, enabled_only: "yes" } as never),
      () => listWorktreeRules(c, { company_id: "no" } as never),
      () => getWorktreeRuleById(c, { company_id: NIL, rule_id: "no" } as never),
      () => deleteWorktreeRule(c, { company_id: "no", rule_id: U1 } as never),
    ]) await expect(invoke()).rejects.toThrow(RangeError);
    const update = (p: object) => updateWorktreeRule(c, { ...UPDATE, ...p } as never);
    for (const p of [
      { rule_id: "no" }, { expected_version: 0 }, { expected_version: -1 }, { expected_version: 1.5 },
      { expected_version: 2_147_483_648 }, { name: " " }, { severity: "must" }, { action: "shell_exec" },
      { predicate: [] }, { decision_map: 0 }, { message: 4 },
    ]) await expect(update(p)).rejects.toThrow(RangeError);
    for (const expected_version of [0, -1, 1.5]) {
      await expect(toggleWorktreeRuleEnabled(c, { ...TOGGLE, expected_version })).rejects.toThrow(RangeError);
    }
  });

  it("accepts valid boundary params without inventing or dropping wire keys", async () => {
    const s = stub({ "worktree.update": { updated: false, reason: "not_found" } });
    await updateWorktreeRule(s.client, { ...UPDATE, expected_version: 2_147_483_647 });
    expect(s.calls[0].params).toStrictEqual({ ...UPDATE, expected_version: 2_147_483_647 });
    const t = stub({ "worktree.create": { created: true, rule: RULE } });
    await createWorktreeRule(t.client, { ...CREATE, predicate: null, decision_map: null, message: "", enabled: true });
    expect(t.calls[0].params).toStrictEqual({
      ...CREATE, predicate: null, decision_map: null, message: "", enabled: true,
    });
  });
});

describe("classifyWorktreeRpcError", () => {
  it("passes through the heartbeat commit contract for worktree RPC failures", () => {
    expect(classifyWorktreeRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyWorktreeRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    expect(classifyWorktreeRpcError(new PaperworkEngineError("timeout", "m")))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
  });
});

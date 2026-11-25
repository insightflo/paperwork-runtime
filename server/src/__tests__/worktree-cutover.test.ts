import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  createWorktreeRuleWithCutover, deleteWorktreeRuleWithCutover,
  getWorktreeRuleByIdWithCutover, isWorktreeEngineCutoverEnabled,
  listWorktreeRulesWithCutover, toggleWorktreeRuleEnabledWithCutover,
  updateWorktreeRuleWithCutover, WorktreeCutoverIndeterminateError,
  type WorktreeCutoverCallOpts, type WorktreeCutoverResult,
} from "../services/worktree-cutover.js";
import type {
  WorktreeCreateParams, WorktreeDeleteParams, WorktreeGetByIdParams,
  WorktreeListParams, WorktreeToggleEnabledParams, WorktreeUpdateParams,
} from "../services/paperwork-engine-worktree.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_WORKTREE_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const RULE = {
  id: NIL, company_id: NIL, name: "guard", severity: "MUST", action: "file_write",
  predicate: {}, decision_map: {}, message: "m", enabled: true, version: 1,
  created_by: "tester", created_at: T0, updated_at: T0,
};
const CREATE: WorktreeCreateParams = {
  company_id: NIL, name: "guard", severity: "MUST", action: "file_write",
  predicate: {}, decision_map: {}, message: "m", enabled: true, created_by: "tester",
};
const UPDATE: WorktreeUpdateParams = {
  company_id: NIL, rule_id: NIL, expected_version: 1, name: "next",
};
const TOGGLE: WorktreeToggleEnabledParams = { company_id: NIL, rule_id: NIL, expected_version: 1 };
const DELETE: WorktreeDeleteParams = { company_id: NIL, rule_id: NIL };
const LIST: WorktreeListParams = { company_id: NIL };
const GET: WorktreeGetByIdParams = { company_id: NIL, rule_id: NIL };
const CREATE_RESULT = { created: true as const, rule: RULE };
const UPDATE_RESULT = { updated: true as const, rule: RULE };
const DELETE_RESULT = { deleted: true as const };
const LIST_RESULT = { rules: [RULE] };
const GET_RESULT = { found: true as const, rule: RULE };

type Invoke = (client: PaperworkEngineClient | null, tsFallback: () => Promise<unknown>,
  opts?: WorktreeCutoverCallOpts) => Promise<WorktreeCutoverResult<unknown>>;
const WRITES: { op: string; method: string; params: Readonly<Record<string, unknown>>;
  response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "create_worktree_rule", method: "worktree.create", params: CREATE,
    response: CREATE_RESULT, result: CREATE_RESULT,
    invoke: (c, f, o) => createWorktreeRuleWithCutover(c, CREATE, f as never, o) },
  { op: "update_worktree_rule", method: "worktree.update", params: UPDATE,
    response: UPDATE_RESULT, result: UPDATE_RESULT,
    invoke: (c, f, o) => updateWorktreeRuleWithCutover(c, UPDATE, f as never, o) },
  { op: "toggle_worktree_rule_enabled", method: "worktree.toggle_enabled", params: TOGGLE,
    response: UPDATE_RESULT, result: UPDATE_RESULT,
    invoke: (c, f, o) => toggleWorktreeRuleEnabledWithCutover(c, TOGGLE, f as never, o) },
  { op: "delete_worktree_rule", method: "worktree.delete", params: DELETE,
    response: DELETE_RESULT, result: DELETE_RESULT,
    invoke: (c, f, o) => deleteWorktreeRuleWithCutover(c, DELETE, f as never, o) },
];
const READS: { op: string; method: string; params: Readonly<Record<string, unknown>>;
  response: unknown; result: unknown; invoke: Invoke }[] = [
  { op: "list_worktree_rules", method: "worktree.list", params: LIST,
    response: LIST_RESULT, result: LIST_RESULT,
    invoke: (c, f, o) => listWorktreeRulesWithCutover(c, LIST, f as never, o) },
  { op: "get_worktree_rule_by_id", method: "worktree.get_by_id", params: GET,
    response: GET_RESULT, result: GET_RESULT,
    invoke: (c, f, o) => getWorktreeRuleByIdWithCutover(c, GET, f as never, o) },
];

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

describe("isWorktreeEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isWorktreeEngineCutoverEnabled(ON)).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isWorktreeEngineCutoverEnabled({ PAPERWORK_RUST_WORKTREE_CUTOVER: v })).toBe(false);
    }
    expect(isWorktreeEngineCutoverEnabled({})).toBe(false);
  });
});

describe("worktree write cutover", () => {
  it.each(WRITES)("$op: flag OFF and null client bypass with zero RPC", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it.each(WRITES)("$op: flag ON uses engine once with exact params and write timeout", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{ method: op.method, params: op.params, callOpts: { timeoutMs: 17_000 } }]);
  });
  it.each(WRITES)("$op: -32005 throws indeterminate and NEVER calls TS fallback", async (op) => {
    const { client } = stub(() => { throw rpc(-32005); });
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "WorktreeCutoverIndeterminateError", operation: op.op,
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([-32002, -32001, -32602])(
    "create not_committed rpc %i warns and falls back to TS", async (code) => {
      const { client } = stub(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => CREATE_RESULT);
      await expect(createWorktreeRuleWithCutover(client, CREATE, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    });
  it("unclassifiable non-engine write error is fail-closed indeterminate", async () => {
    const cause = new Error("transport exploded");
    const { client } = stub(() => { throw cause; });
    const tsFallback = vi.fn();
    await expect(updateWorktreeRuleWithCutover(client, UPDATE, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "WorktreeCutoverIndeterminateError", operation: "update_worktree_rule", cause,
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("engine-ineligible write input throws indeterminate before send and never falls back", async () => {
    const { client, calls } = stub(() => UPDATE_RESULT);
    const tsFallback = vi.fn();
    await expect(updateWorktreeRuleWithCutover(client,
      { ...UPDATE, expected_version: 0 }, tsFallback, { env: ON }))
      .rejects.toBeInstanceOf(WorktreeCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([
    ["not_found", { updated: false, reason: "not_found" }],
    ["version_conflict", { updated: false, reason: "version_conflict", current_version: 3 }],
  ])("update fenced miss %s is authoritative rust data, never TS fallback", async (_label, response) => {
    const { client } = stub(() => response);
    const tsFallback = vi.fn();
    await expect(updateWorktreeRuleWithCutover(client, UPDATE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: response });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("toggle fenced miss is authoritative rust data, never TS fallback", async () => {
    const response = { updated: false, reason: "version_conflict", current_version: 2 };
    const { client } = stub(() => response);
    const tsFallback = vi.fn();
    await expect(toggleWorktreeRuleEnabledWithCutover(client, TOGGLE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: response });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("delete deleted:false is a rust data passthrough, never TS fallback", async () => {
    const { client } = stub(() => ({ deleted: false }));
    const tsFallback = vi.fn();
    await expect(deleteWorktreeRuleWithCutover(client, DELETE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { deleted: false } });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([[-5, 17_000], [17_000.9, 17_000], [600_001, 600_000], [undefined, 17_000], [Number.NaN, 17_000]])(
    "writes clamp timeoutMs %s to %s", async (ms, want) => {
      const { client, calls } = stub(() => CREATE_RESULT);
      await createWorktreeRuleWithCutover(client, CREATE, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
  it("a throwing logger.warn does not mask the not_committed TS fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("pino boom"); });
    try {
      const { client } = stub(() => { throw rpc(-32001); });
      const tsFallback = vi.fn(async () => CREATE_RESULT);
      await expect(createWorktreeRuleWithCutover(client, CREATE, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("worktree read cutover", () => {
  it.each(READS)("$op: flag OFF and null client bypass with zero RPC", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(calls).toHaveLength(0);
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });
  it.each(READS)("$op: flag ON returns engine data with read timeout", async (op) => {
    const { client, calls } = stub(() => op.response);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls).toEqual([{ method: op.method, params: op.params, callOpts: { timeoutMs: 10_000 } }]);
  });
  it.each(READS)("$op: ANY engine error including -32005 falls back without throwing", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t"), new Error("x")]) {
      const { client } = stub(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
  });
  it.each([[0, 1], [10_000.9, 10_000], [600_001, 600_000], [undefined, 10_000], [Number.POSITIVE_INFINITY, 10_000]])(
    "reads clamp timeoutMs %s to %s", async (ms, want) => {
      const { client, calls } = stub(() => LIST_RESULT);
      await listWorktreeRulesWithCutover(client, LIST, vi.fn(), { env: ON, timeoutMs: ms });
      expect(timeoutOf(calls[0])).toBe(want);
    });
});

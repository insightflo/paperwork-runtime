import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type { EngineWorktreeRule } from "../services/paperwork-engine-worktree.js";
import {
  createWorktreeCutoverHooks, getWorktreeCutoverMetrics, resetWorktreeCutoverMetricsForTests,
  wireCreateWorktreeRuleCutover, wireDeleteWorktreeRuleCutover,
  wireGetWorktreeRuleByIdCutover, wireListWorktreeRulesCutover,
  wireToggleWorktreeRuleEnabledCutover, wireUpdateWorktreeRuleCutover,
  WorktreeCutoverIndeterminateError, type WorktreeCutoverResult,
  type WorktreeCutoverTelemetryEvent, type WorktreeCutoverWiringOpts,
  type WorktreeWiredOperation,
} from "../services/worktree-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_WORKTREE_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-01-01T00:00:00Z";
const RULE: EngineWorktreeRule = {
  id: NIL, company_id: NIL, name: "guard", severity: "MUST", action: "file_write",
  predicate: {}, decision_map: {}, message: "m", enabled: true, version: 1,
  created_by: "tester", created_at: T0, updated_at: T0,
};
const CREATE = {
  company_id: NIL, name: "guard", severity: "MUST" as const, action: "file_write" as const,
  predicate: {}, decision_map: {}, message: "m", enabled: true, created_by: "tester",
};
const UPDATE = { company_id: NIL, rule_id: NIL, expected_version: 1, name: "next" };
const TOGGLE = { company_id: NIL, rule_id: NIL, expected_version: 1 };
const DELETE = { company_id: NIL, rule_id: NIL };
const LIST = { company_id: NIL };
const GET = { company_id: NIL, rule_id: NIL };
const CREATE_RESULT = { created: true as const, rule: RULE };
const UPDATE_RESULT = { updated: true as const, rule: RULE };
const DELETE_RESULT = { deleted: true as const };
const LIST_RESULT = { rules: [RULE] };
const GET_RESULT = { found: true as const, rule: RULE };
const UPDATE_MISS = { updated: false as const, reason: "version_conflict" as const, current_version: 3 };
const DELETE_MISS = { deleted: false as const };

interface OpCase {
  op: WorktreeWiredOperation; method: string; response: unknown; result: unknown;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: WorktreeCutoverWiringOpts) => Promise<WorktreeCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "create_worktree_rule", method: "worktree.create", response: CREATE_RESULT,
    result: CREATE_RESULT, invoke: (f, o) => wireCreateWorktreeRuleCutover(CREATE, f as never, o) },
  { op: "update_worktree_rule", method: "worktree.update", response: UPDATE_RESULT,
    result: UPDATE_RESULT, invoke: (f, o) => wireUpdateWorktreeRuleCutover(UPDATE, f as never, o) },
  { op: "toggle_worktree_rule_enabled", method: "worktree.toggle_enabled", response: UPDATE_RESULT,
    result: UPDATE_RESULT, invoke: (f, o) => wireToggleWorktreeRuleEnabledCutover(TOGGLE, f as never, o) },
  { op: "delete_worktree_rule", method: "worktree.delete", response: DELETE_RESULT,
    result: DELETE_RESULT, invoke: (f, o) => wireDeleteWorktreeRuleCutover(DELETE, f as never, o) },
  { op: "list_worktree_rules", method: "worktree.list", response: LIST_RESULT,
    result: LIST_RESULT, invoke: (f, o) => wireListWorktreeRulesCutover(LIST, f as never, o) },
  { op: "get_worktree_rule_by_id", method: "worktree.get_by_id", response: GET_RESULT,
    result: GET_RESULT, invoke: (f, o) => wireGetWorktreeRuleByIdCutover(GET, f as never, o) },
];

function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);

beforeEach(() => resetWorktreeCutoverMetricsForTests());
afterEach(() => vi.restoreAllMocks());

describe("worktree-cutover-wiring", () => {
  it("flag OFF routes every op to tsFallback without client resolution and counts tsBypass", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_WORKTREE_CUTOVER: "0" }, { PAPERWORK_RUST_WORKTREE_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    const metrics = getWorktreeCutoverMetrics();
    for (const op of OPS) {
      expect(metrics[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    }
    expect(metrics.create_worktree_rule.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient warns and fails safe to tsBypass", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const tsFallback = vi.fn(async () => CREATE_RESULT);
    await expect(wireCreateWorktreeRuleCutover(CREATE, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    await expect(wireCreateWorktreeRuleCutover(CREATE, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(getWorktreeCutoverMetrics().create_worktree_rule)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("happy rust path counts rustSuccess and emits complete telemetry fields", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: WorktreeCutoverTelemetryEvent[] = [];
    const opts = { env: ON, getClient: () => client, onEvent: (event: WorktreeCutoverTelemetryEvent) => { events.push(event); } };
    for (const op of OPS) {
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, opts)).resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(calls.map((c) => c.method)).toEqual(OPS.map((o) => o.method));
    expect(events).toHaveLength(OPS.length);
    expect(events[0]).toMatchObject({
      operation: "create_worktree_rule", outcome: "rust_success", source: "rust", fenceMismatch: false,
    });
    expect(typeof events[0].durationMs).toBe("number");
    const metrics = getWorktreeCutoverMetrics();
    for (const op of OPS) expect(metrics[op.op]).toMatchObject({ rustSuccess: 1, fenceMismatch: 0 });
  });

  it("not_committed adapter fallback returns source ts and counts tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const tsFallback = vi.fn(async () => CREATE_RESULT);
    await expect(wireCreateWorktreeRuleCutover(CREATE, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getWorktreeCutoverMetrics().create_worktree_rule)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it("indeterminate adapter error is counted, rethrown, and never double-calls tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => UPDATE_RESULT);
    await expect(wireUpdateWorktreeRuleCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(WorktreeCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getWorktreeCutoverMetrics().update_worktree_rule)
      .toMatchObject({ indeterminateError: 1, tsFallback: 0, tsBypass: 0 });
  });

  it("tsFallback failure is counted as tsError and rethrown", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireCreateWorktreeRuleCutover(CREATE, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getWorktreeCutoverMetrics().create_worktree_rule)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("fenced update and delete misses return as-is and increment fenceMismatch", async () => {
    const updateClient = stubClient(() => UPDATE_MISS).client;
    const deleteClient = stubClient(() => DELETE_MISS).client;
    const updateFallback = vi.fn();
    const deleteFallback = vi.fn();
    await expect(wireUpdateWorktreeRuleCutover(UPDATE, updateFallback, { env: ON, getClient: () => updateClient }))
      .resolves.toEqual({ source: "rust", value: UPDATE_MISS });
    await expect(wireDeleteWorktreeRuleCutover(DELETE, deleteFallback, { env: ON, getClient: () => deleteClient }))
      .resolves.toEqual({ source: "rust", value: DELETE_MISS });
    expect(updateFallback).not.toHaveBeenCalled();
    expect(deleteFallback).not.toHaveBeenCalled();
    const metrics = getWorktreeCutoverMetrics();
    expect(metrics.update_worktree_rule).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
    expect(metrics.delete_worktree_rule).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
  });

  it("hooks bind defaults, swallow throwing observers, and use an independent meter", async () => {
    const { client } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: WorktreeCutoverTelemetryEvent[] = [];
    const hooks = createWorktreeCutoverHooks({
      env: ON, getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });
    await expect(hooks.createWorktreeRule(CREATE, vi.fn())).resolves.toEqual({ source: "rust", value: CREATE_RESULT });
    await expect(hooks.listWorktreeRules(LIST, vi.fn())).resolves.toEqual({ source: "rust", value: LIST_RESULT });
    expect(events.map((event) => event.outcome)).toEqual(["rust_success", "rust_success"]);
    const metrics = hooks.getMetrics();
    expect(metrics.create_worktree_rule).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(metrics.list_worktree_rules).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(getWorktreeCutoverMetrics().create_worktree_rule.totalCalls).toBe(0);
  });

  it("metrics snapshots are deep copies and reset clears all counters", async () => {
    await wireCreateWorktreeRuleCutover(CREATE, async () => CREATE_RESULT, { env: OFF });
    const snapshot = getWorktreeCutoverMetrics();
    Object.assign(snapshot.create_worktree_rule, { tsBypass: 999, totalCalls: 999 });
    const fresh = getWorktreeCutoverMetrics();
    expect(fresh.create_worktree_rule).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(fresh.list_worktree_rules.totalCalls).toBe(0);
    resetWorktreeCutoverMetricsForTests();
    const zeroed = getWorktreeCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });

  it("per-call opts merge over hook defaults without replacing the bound client", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const getClient = vi.fn(() => client);
    const hooks = createWorktreeCutoverHooks({ env: ON, getClient });
    await expect(hooks.createWorktreeRule(CREATE, async () => CREATE_RESULT, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(getClient).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(hooks.getMetrics().create_worktree_rule).toMatchObject({ tsBypass: 1, totalCalls: 1 });
  });
});

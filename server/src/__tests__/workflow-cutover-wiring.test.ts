import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  PendingWorkflowRun,
  WorkflowStepRunRow,
  WorkflowTransitionRunFencedResult,
  WorkflowTransitionStepFencedResult,
} from "../services/paperwork-engine-workflow.js";
import { WorkflowCutoverIndeterminateError } from "../services/paperwork-engine-workflow-cutover.js";
import {
  createWorkflowCutoverHooks,
  getWorkflowCutoverMetrics,
  resetWorkflowCutoverMetricsForTests,
  wireListPendingRunsCutover,
  wireListStepRunsCutover,
  wireTransitionRunFencedCutover,
  wireTransitionStepFencedCutover,
  type WorkflowCutoverTelemetryEvent,
  type WorkflowCutoverWiringOpts,
} from "../services/workflow-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_WORKFLOW_CUTOVER: "1" };
const OFF = {};
const TS0 = "2026-01-01T00:00:00Z";
const TS1 = "2026-01-01T00:00:01Z";
const RUN_PARAMS = { run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "completed" } as const;
const STEP_PARAMS = { step_run_id: NIL, workflow_run_id: NIL, company_id: NIL,
  expected_statuses: ["running"], next_status: "completed", expected_transition_version: 3 } as const;
const PENDING_PARAMS = { company_id: NIL, limit: 10 };
const STEPS_PARAMS = { company_id: NIL, workflow_run_id: NIL };
const RUN_OK: WorkflowTransitionRunFencedResult = {
  applied: true, run_id: NIL, status: "completed", started_at: TS0, completed_at: TS1 };
const STEP_OK: WorkflowTransitionStepFencedResult = {
  applied: true, step_run_id: NIL, status: "completed", status_transition_version: 4,
  started_at: TS0, completed_at: TS1 };
const PENDING: PendingWorkflowRun[] = [{
  id: NIL, workflow_id: NIL, company_id: NIL, mission_id: null, triggered_by: "manual", created_at: TS0 }];
const STEPS: WorkflowStepRunRow[] = [{
  id: NIL, workflow_run_id: NIL, step_id: "s1", status: "completed", retry_count: 0,
  status_transition_version: 4, execution_generation: 1, started_at: TS0, completed_at: TS1 }];

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
const rpcResult = (method: string) =>
  method === "workflow.transition_run_fenced" ? RUN_OK
    : method === "workflow.transition_step_fenced" ? STEP_OK
      : method === "workflow.list_pending_runs" ? { runs: PENDING } : { steps: STEPS };
const callAll = (opts: WorkflowCutoverWiringOpts) => Promise.all([
  wireTransitionRunFencedCutover(RUN_PARAMS, async () => RUN_OK, opts),
  wireTransitionStepFencedCutover(STEP_PARAMS, async () => STEP_OK, opts),
  wireListPendingRunsCutover(PENDING_PARAMS, async () => PENDING, opts),
  wireListStepRunsCutover(STEPS_PARAMS, async () => STEPS, opts)]);

beforeEach(() => resetWorkflowCutoverMetricsForTests());

describe("workflow-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all 4 ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_ENGINE_WORKFLOW_CUTOVER: "0" }, { PAPERWORK_ENGINE_WORKFLOW_CUTOVER: "true" }]) {
      expect(await callAll({ env, getClient })).toEqual([
        { source: "ts", value: RUN_OK }, { source: "ts", value: STEP_OK },
        { source: "ts", value: PENDING }, { source: "ts", value: STEPS }]);
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getWorkflowCutoverMetrics();
    for (const op of ["transition_run_fenced", "transition_step_fenced", "list_pending_runs", "list_step_runs"] as const) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    }
    expect(m.list_pending_runs.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => RUN_OK);
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: RUN_OK });
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: RUN_OK });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getWorkflowCutoverMetrics().transition_run_fenced)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient(rpcResult);
    const opts = { env: ON, getClient: () => client };
    const fb = [vi.fn(async () => RUN_OK), vi.fn(async () => STEP_OK), vi.fn(async () => PENDING), vi.fn(async () => STEPS)];
    const [r1, r2, r3, r4] = await Promise.all([
      wireTransitionRunFencedCutover(RUN_PARAMS, fb[0], opts),
      wireTransitionStepFencedCutover(STEP_PARAMS, fb[1], opts),
      wireListPendingRunsCutover(PENDING_PARAMS, fb[2], opts),
      wireListStepRunsCutover(STEPS_PARAMS, fb[3], opts)]);
    expect([r1, r2, r3, r4]).toEqual([
      { source: "rust", value: RUN_OK }, { source: "rust", value: STEP_OK },
      { source: "rust", value: PENDING }, { source: "rust", value: STEPS }]);
    for (const f of fb) expect(f).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["workflow.transition_run_fenced",
      "workflow.transition_step_fenced", "workflow.list_pending_runs", "workflow.list_step_runs"]);
    const m = getWorkflowCutoverMetrics();
    for (const op of Object.keys(m)) expect(m[op as keyof typeof m]).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => RUN_OK);
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: RUN_OK });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getWorkflowCutoverMetrics().transition_run_fenced)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsRun = vi.fn(async () => RUN_OK);
    const tsStep = vi.fn(async () => STEP_OK);
    const opts = { env: ON, getClient: () => client };
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsRun, opts))
      .rejects.toBeInstanceOf(WorkflowCutoverIndeterminateError);
    await expect(wireTransitionStepFencedCutover(STEP_PARAMS, tsStep, opts))
      .rejects.toBeInstanceOf(WorkflowCutoverIndeterminateError);
    expect(tsRun).not.toHaveBeenCalled();
    expect(tsStep).not.toHaveBeenCalled();
    const m = getWorkflowCutoverMetrics();
    expect(m.transition_run_fenced).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    expect(m.transition_step_fenced).toMatchObject({ indeterminateError: 1 });
  });

  it("read ops fall back to tsFallback on ANY engine error — indeterminate never applies", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const opts = { env: ON, getClient: () => client };
    const tsPending = vi.fn(async () => PENDING);
    const tsSteps = vi.fn(async () => STEPS);
    await expect(wireListPendingRunsCutover(PENDING_PARAMS, tsPending, opts))
      .resolves.toEqual({ source: "ts", value: PENDING });
    await expect(wireListStepRunsCutover(STEPS_PARAMS, tsSteps, opts))
      .resolves.toEqual({ source: "ts", value: STEPS });
    const m = getWorkflowCutoverMetrics();
    expect(m.list_pending_runs).toMatchObject({ tsFallback: 1, indeterminateError: 0 });
    expect(m.list_step_runs).toMatchObject({ tsFallback: 1, indeterminateError: 0 });
  });

  it("propagates Rust fence mismatch { applied: false } untouched; counts rustSuccess + fenceMismatch", async () => {
    const { client } = stubClient(() => ({ applied: false }));
    const tsRun = vi.fn(async () => RUN_OK);
    const tsStep = vi.fn(async () => STEP_OK);
    const opts = { env: ON, getClient: () => client };
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsRun, opts))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    await expect(wireTransitionStepFencedCutover(STEP_PARAMS, tsStep, opts))
      .resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(tsRun).not.toHaveBeenCalled();
    expect(tsStep).not.toHaveBeenCalled();
    const m = getWorkflowCutoverMetrics();
    expect(m.transition_run_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 1, tsFallback: 0 });
    expect(m.transition_step_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
  });

  it("counts fenceMismatch for TS-originated { applied: false } as well", async () => {
    await expect(wireTransitionStepFencedCutover(STEP_PARAMS, async () => ({ applied: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(getWorkflowCutoverMetrics().transition_step_fenced)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustSuccess: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireListPendingRunsCutover(PENDING_PARAMS, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getWorkflowCutoverMetrics().list_pending_runs)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ run_id: "not-a-uuid", company_id: NIL,
      expected_statuses: ["running"] as const, next_status: "completed" as const });
    await expect(wireTransitionRunFencedCutover(params, async () => RUN_OK, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: RUN_OK });
    expect(params).toEqual({ run_id: "not-a-uuid", company_id: NIL, expected_statuses: ["running"], next_status: "completed" });
  });

  it("ineligible engine input bypasses RPC via tsFallback path (tsFallback counter)", async () => {
    const { client, calls } = stubClient(rpcResult);
    const bad = { ...RUN_PARAMS, run_id: "not-a-uuid" };
    const tsFallback = vi.fn(async () => RUN_OK);
    await expect(wireTransitionRunFencedCutover(bad, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: RUN_OK });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(getWorkflowCutoverMetrics().transition_run_fenced).toMatchObject({ tsFallback: 1, rustSuccess: 0 });
  });

  it("createWorkflowCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient(rpcResult);
    const events: WorkflowCutoverTelemetryEvent[] = [];
    const hooks = createWorkflowCutoverHooks({
      env: ON, getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });
    await expect(hooks.transitionRunFenced(RUN_PARAMS, vi.fn(async () => RUN_OK)))
      .resolves.toEqual({ source: "rust", value: RUN_OK });
    await expect(hooks.listPendingRuns(PENDING_PARAMS, vi.fn(async () => PENDING)))
      .resolves.toEqual({ source: "rust", value: PENDING });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);
    await expect(hooks.listStepRuns(STEPS_PARAMS, async () => STEPS, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: STEPS });
    expect(events).toHaveLength(3);
    const m = hooks.getMetrics();
    expect(m.transition_run_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.list_pending_runs).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.list_step_runs).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(getWorkflowCutoverMetrics().transition_run_fenced.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireListPendingRunsCutover(PENDING_PARAMS, async () => PENDING, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: WorkflowCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: PENDING });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getWorkflowCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireTransitionRunFencedCutover(RUN_PARAMS, async () => RUN_OK, { env: OFF });
    const snap = getWorkflowCutoverMetrics();
    Object.assign(snap.transition_run_fenced, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.list_step_runs, { totalCalls: 999 });
    const fresh = getWorkflowCutoverMetrics();
    expect(fresh.transition_run_fenced).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.list_step_runs.totalCalls).toBe(0);
    resetWorkflowCutoverMetricsForTests();
    expect(getWorkflowCutoverMetrics().list_pending_runs.totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => RUN_OK);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireTransitionRunFencedCutover(RUN_PARAMS, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(WorkflowCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getWorkflowCutoverMetrics().transition_run_fenced).toMatchObject({ indeterminateError: 1, tsFallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => STEPS);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireListStepRunsCutover(STEPS_PARAMS, tsFallback, opts)).resolves.toEqual({ source: "ts", value: STEPS });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getWorkflowCutoverMetrics().list_step_runs).toMatchObject({ tsBypass: 1 });
  });
});

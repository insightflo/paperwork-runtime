import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyWorkflowRpcError, listPendingWorkflowRuns, listWorkflowStepRuns,
  transitionWorkflowRunFenced, transitionWorkflowStepFenced,
  validateWorkflowRunTransition, validateWorkflowStepTransition,
} from "../services/paperwork-engine-workflow.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const RUN = "11111111-1111-1111-1111-111111111111";
const WF = "22222222-2222-2222-2222-222222222222";
const STEP = "33333333-3333-3333-3333-333333333333";
const PENDING = {
  id: RUN, workflow_id: WF, company_id: NIL, mission_id: null,
  triggered_by: "schedule", created_at: "2026-01-01T00:00:00Z",
};
const STEP_ROW = {
  id: STEP, workflow_run_id: RUN, step_id: "s1", status: "pending",
  retry_count: 0, status_transition_version: 3, execution_generation: 1,
  started_at: null, completed_at: null,
};
const STEP_PARAMS = {
  step_run_id: STEP, workflow_run_id: RUN, company_id: NIL,
  expected_statuses: ["pending" as const], next_status: "running" as const, expected_transition_version: 3,
};

/** Minimal PaperworkEngineClient stub: records calls, returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("workflow.* typed RPC methods", () => {
  it("validate run/step transitions: results, wire shape, extra keys stripped", async () => {
    const { client, calls } = stub({
      "workflow.validate_run_transition": { valid: true, sets_started_at: true, sets_completed_at: false },
      "workflow.validate_step_transition": { valid: false, reason: "illegal_step_transition", from: "skipped", to: "running" },
    });
    const wide = { expected_statuses: ["pending" as const], next_status: "running" as const, bogus: 1, nested: { x: 1 } };
    await expect(validateWorkflowRunTransition(client, wide, { timeoutMs: 123 }))
      .resolves.toEqual({ valid: true, sets_started_at: true, sets_completed_at: false });
    expect(calls[0]).toEqual({
      method: "workflow.validate_run_transition",
      params: { expected_statuses: ["pending"], next_status: "running" },
      callOpts: { timeoutMs: 123 },
    });
    await expect(validateWorkflowStepTransition(client, { expected_statuses: ["skipped"], next_status: "running" }))
      .resolves.toEqual({ valid: false, reason: "illegal_step_transition", from: "skipped", to: "running" });
    // illegal transition reaches the wire: the RPC itself answers valid:false
    const s = stub({ "workflow.validate_run_transition": { valid: false, reason: "illegal_run_transition", from: "completed", to: "running" } });
    await expect(validateWorkflowRunTransition(s.client, { expected_statuses: ["completed"], next_status: "running" }))
      .resolves.toEqual({ valid: false, reason: "illegal_run_transition", from: "completed", to: "running" });
  });
  it("validate_* reject malformed results and bad params pre-call", async () => {
    for (const bad of [null, 1, { valid: true }, { valid: "y" },
      { valid: false, reason: "bogus", from: "pending", to: "running" },
      { valid: false, reason: "illegal_run_transition", from: "bogus", to: "running" },
      { valid: true, sets_started_at: true, sets_completed_at: false, reason: "illegal_run_transition" },
      { valid: true, sets_started_at: true, sets_completed_at: false, extra: 1 },
      { valid: false, reason: "illegal_run_transition", from: "pending", to: "running", extra: 1 }]) {
      const { client } = stub({ "workflow.validate_run_transition": bad });
      await expect(validateWorkflowRunTransition(client, { expected_statuses: ["pending"], next_status: "running" }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const bad of [{ valid: false, reason: "illegal_step_transition", from: "queued", to: "running" },
      { valid: true, sets_started_at: true },
      { valid: true, sets_started_at: true, sets_completed_at: false, extra: 1 },
      { valid: false, reason: "illegal_step_transition", from: "pending", to: "running", extra: 1 }]) {
      const { client } = stub({ "workflow.validate_step_transition": bad });
      await expect(validateWorkflowStepTransition(client, { expected_statuses: ["pending"], next_status: "running" }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const { client, calls } = stub({});
    await expect(validateWorkflowRunTransition(client, { expected_statuses: [], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(validateWorkflowRunTransition(client, { expected_statuses: Array(2), next_status: "running" })).rejects.toThrow(RangeError);
    await expect(validateWorkflowRunTransition(client, { expected_statuses: ["nope" as never], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(validateWorkflowStepTransition(client, { expected_statuses: ["pending"], next_status: "bogus" as never })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
  it("listPendingWorkflowRuns unwraps runs; validates rows and limit", async () => {
    const { client, calls } = stub({ "workflow.list_pending_runs": { runs: [PENDING, { ...PENDING, id: STEP, mission_id: WF }] } });
    await expect(listPendingWorkflowRuns(client, { company_id: NIL, limit: 10 }))
      .resolves.toEqual([PENDING, { ...PENDING, id: STEP, mission_id: WF }]);
    expect(calls[0]).toEqual({
      method: "workflow.list_pending_runs", params: { company_id: NIL, limit: 10 }, callOpts: undefined,
    });
    for (const bad of [null, {}, { runs: "x" }, { runs: [], extra: 1 }, { runs: [PENDING], extra: 1 },
      { runs: [{ ...PENDING, id: 1 }] },
      { runs: [{ ...PENDING, mission_id: "zzz" }] }, { runs: [{ ...PENDING, workflow_id: "x" }] },
      { runs: [{ ...PENDING, extra: 1 }] },
      { runs: [{ ...PENDING, created_at: "2026-02-30T00:00:00Z" }] },
      { runs: [{ ...PENDING, created_at: "2026-01-01T24:00:00Z" }] },
      { runs: [{ ...PENDING, created_at: "2026-01-01T00:60:00Z" }] },
      { runs: [{ ...PENDING, created_at: "2026-01-01T00:00:00+24:00" }] },
      { runs: [{ ...PENDING, created_at: "2026-01-01T00:00:00+01:60" }] }]) {
      const c = stub({ "workflow.list_pending_runs": bad });
      await expect(listPendingWorkflowRuns(c.client, { company_id: NIL, limit: 5 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const c2 = stub({});
    await expect(listPendingWorkflowRuns(c2.client, { company_id: "no", limit: 1 })).rejects.toThrow(RangeError);
    await expect(listPendingWorkflowRuns(c2.client, { company_id: NIL, limit: 1.5 })).rejects.toThrow(RangeError);
    await expect(listPendingWorkflowRuns(c2.client, { company_id: NIL, limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(RangeError);
    expect(c2.calls).toHaveLength(0);
  });
  it("transitionWorkflowRunFenced maps applied/discarded; fences pre-call", async () => {
    const applied = { applied: true, run_id: RUN, status: "running", started_at: "2026-01-01T00:00:00Z", completed_at: null };
    const { client, calls } = stub({ "workflow.transition_run_fenced": applied });
    await expect(transitionWorkflowRunFenced(client, {
      run_id: RUN, company_id: NIL, expected_statuses: ["pending"], next_status: "running",
    }, { timeoutMs: 9 })).resolves.toEqual(applied);
    expect(calls[0]).toEqual({
      method: "workflow.transition_run_fenced",
      params: { run_id: RUN, company_id: NIL, expected_statuses: ["pending"], next_status: "running" },
      callOpts: { timeoutMs: 9 },
    });
    const none = stub({ "workflow.transition_run_fenced": { applied: false } });
    await expect(transitionWorkflowRunFenced(none.client, {
      run_id: RUN, company_id: NIL, expected_statuses: ["pending"], next_status: "cancelled",
    })).resolves.toEqual({ applied: false });
    for (const bad of [null, {}, { applied: "y" }, { applied: true, run_id: RUN, status: "bogus" },
      { applied: false, run_id: RUN }, { applied: false, extra: 1 },
      { ...applied, run_id: "x" }, { ...applied, completed_at: "2025-02-29T00:00:00Z" },
      { ...applied, extra: 1 }, { ...applied, started_at: "2026-01-01T24:00:00Z" }]) {
      const c = stub({ "workflow.transition_run_fenced": bad });
      await expect(transitionWorkflowRunFenced(c.client, {
        run_id: RUN, company_id: NIL, expected_statuses: ["pending"], next_status: "running",
      })).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    const fenced = (p: object) => transitionWorkflowRunFenced(s.client, p as never);
    await expect(fenced({ run_id: "x", company_id: NIL, expected_statuses: ["pending"], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(fenced({ run_id: RUN, company_id: NIL, expected_statuses: [], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(fenced({ run_id: RUN, company_id: NIL, expected_statuses: Array(1), next_status: "running" })).rejects.toThrow(RangeError);
    await expect(fenced({ run_id: RUN, company_id: NIL, expected_statuses: ["completed"], next_status: "running" })).rejects.toThrow(RangeError);
    await expect(fenced({ run_id: RUN, company_id: NIL, expected_statuses: ["pending"], next_status: "completed" })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("transitionWorkflowStepFenced maps applied + i32 gate; fences pre-call", async () => {
    const applied = { applied: true, step_run_id: STEP, status: "running", status_transition_version: 4, started_at: "2026-01-01T00:00:00Z", completed_at: null };
    const { client, calls } = stub({ "workflow.transition_step_fenced": applied });
    await expect(transitionWorkflowStepFenced(client, STEP_PARAMS)).resolves.toEqual(applied);
    expect(calls[0]).toEqual({ method: "workflow.transition_step_fenced", params: STEP_PARAMS, callOpts: undefined });
    for (const bad of [null, { applied: false, x: 1 }, { ...applied, status_transition_version: 1.5 },
      { ...applied, status_transition_version: 2147483648 }, { ...applied, status: "bogus" },
      { ...applied, started_at: "2026-02-30T00:00:00Z" }, { ...applied, extra: 1 }]) {
      const c = stub({ "workflow.transition_step_fenced": bad });
      await expect(transitionWorkflowStepFenced(c.client, STEP_PARAMS)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    const fenced = (p: object) => transitionWorkflowStepFenced(s.client, p as never);
    for (const v of [1.5, 2147483648, -2147483649, "3", NaN]) {
      await expect(fenced({ ...STEP_PARAMS, expected_transition_version: v })).rejects.toThrow(RangeError);
    }
    await expect(fenced({ ...STEP_PARAMS, expected_statuses: ["running"], next_status: "skipped" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...STEP_PARAMS, expected_statuses: ["completed"], next_status: "failed" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...STEP_PARAMS, workflow_run_id: "x" })).rejects.toThrow(RangeError);
    await expect(fenced({ ...STEP_PARAMS, step_run_id: 5 })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
    const ok = stub({ "workflow.transition_step_fenced": { applied: false } });
    await expect(transitionWorkflowStepFenced(ok.client, { ...STEP_PARAMS, expected_transition_version: -2147483648 })).resolves.toEqual({ applied: false });
    await expect(transitionWorkflowStepFenced(ok.client, { ...STEP_PARAMS, expected_transition_version: 2147483647 })).resolves.toEqual({ applied: false });
    expect(ok.calls).toHaveLength(2);
  });
  it("listWorkflowStepRuns unwraps steps; validates UUIDs pre-call", async () => {
    const { client, calls } = stub({ "workflow.list_step_runs": { steps: [STEP_ROW] } });
    await expect(listWorkflowStepRuns(client, { company_id: NIL, workflow_run_id: RUN })).resolves.toEqual([STEP_ROW]);
    expect(calls[0]).toEqual({
      method: "workflow.list_step_runs", params: { company_id: NIL, workflow_run_id: RUN }, callOpts: undefined,
    });
    for (const bad of [null, {}, { steps: {} }, { steps: [STEP_ROW], extra: 1 }, { steps: [{ ...STEP_ROW, status: "bogus" }] },
      { steps: [{ ...STEP_ROW, retry_count: 2147483648 }] }, { steps: [{ ...STEP_ROW, execution_generation: 0.5 }] },
      { steps: [{ ...STEP_ROW, status_transition_version: -2147483649 }] }, { steps: [{ ...STEP_ROW, step_id: 7 }] },
      { steps: [{ ...STEP_ROW, extra: 1 }] }, { steps: [{ ...STEP_ROW, started_at: "2026-01-01T24:00:00Z" }] },
      { steps: [{ ...STEP_ROW, completed_at: "2026-13-01T00:00:00Z" }] }, { steps: [{ ...STEP_ROW, id: "x" }] }]) {
      const c = stub({ "workflow.list_step_runs": bad });
      await expect(listWorkflowStepRuns(c.client, { company_id: NIL, workflow_run_id: RUN }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    await expect(listWorkflowStepRuns(s.client, { company_id: NIL, workflow_run_id: "x" })).rejects.toThrow(RangeError);
    await expect(listWorkflowStepRuns(s.client, { company_id: 4 as never, workflow_run_id: RUN })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
});

describe("classifyWorkflowRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every workflow RPC code to the shared commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyWorkflowRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
  });
  it("fails closed: unknown codes and transport errors are indeterminate/never-retry", () => {
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const rpcCode of [-32601, -32000, 0, 1.5]) {
      expect(classifyWorkflowRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode))).toEqual(unknown);
    }
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "bin_not_configured", "queue_full"] as const) {
      expect(classifyWorkflowRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyWorkflowRpcError(e)).toEqual(unknown);
    }
  });
});

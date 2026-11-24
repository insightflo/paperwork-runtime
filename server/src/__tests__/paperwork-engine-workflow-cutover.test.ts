import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  WorkflowCutoverIndeterminateError, isWorkflowEngineCutoverEnabled,
  listPendingWorkflowRunsWithCutover, listWorkflowStepRunsWithCutover,
  transitionWorkflowRunFencedWithCutover, transitionWorkflowStepFencedWithCutover,
  type WorkflowCutoverCallOpts, type WorkflowCutoverResult,
} from "../services/paperwork-engine-workflow-cutover.js";
import type {
  WorkflowTransitionRunFencedParams, WorkflowTransitionStepFencedParams,
} from "../services/paperwork-engine-workflow.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_WORKFLOW_CUTOVER: "1" };
const TS = "2026-01-01T00:00:00Z";
const RUN_PARAMS: WorkflowTransitionRunFencedParams = {
  run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "completed",
};
const STEP_PARAMS: WorkflowTransitionStepFencedParams = {
  step_run_id: NIL, workflow_run_id: NIL, company_id: NIL,
  expected_statuses: ["running"], next_status: "completed", expected_transition_version: 3,
};
const RUN_WIRE = {
  applied: true, run_id: NIL, status: "completed", started_at: TS, completed_at: TS,
};
const STEP_WIRE = {
  applied: true, step_run_id: NIL, status: "completed",
  status_transition_version: 4, started_at: TS, completed_at: TS,
};
const PENDING = {
  id: NIL, workflow_id: NIL, company_id: NIL, mission_id: null,
  triggered_by: "schedule", created_at: TS,
};
const STEP_ROW = {
  id: NIL, workflow_run_id: NIL, step_id: "s1", status: "running", retry_count: 0,
  status_transition_version: 1, execution_generation: 0, started_at: TS, completed_at: null,
};

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: WorkflowCutoverCallOpts) => Promise<WorkflowCutoverResult<unknown>>;
// [op name, bound call, wire result, wire params, RPC method]
const WRITES: readonly [string, CutFn, Record<string, unknown>, Record<string, unknown>, string][] = [
  ["transition_run_fenced", (c, ts, o) => transitionWorkflowRunFencedWithCutover(c, RUN_PARAMS, ts, o),
    RUN_WIRE,
    { run_id: NIL, company_id: NIL, expected_statuses: ["running"], next_status: "completed" },
    "workflow.transition_run_fenced"],
  ["transition_step_fenced", (c, ts, o) => transitionWorkflowStepFencedWithCutover(c, STEP_PARAMS, ts, o),
    STEP_WIRE,
    { step_run_id: NIL, workflow_run_id: NIL, company_id: NIL,
      expected_statuses: ["running"], next_status: "completed", expected_transition_version: 3 },
    "workflow.transition_step_fenced"],
];
// [op name, bound call, wire result, resolved value, RPC method]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string][] = [
  ["list_pending_runs", (c, ts, o) => listPendingWorkflowRunsWithCutover(c, { company_id: NIL, limit: 5 }, ts, o),
    { runs: [PENDING] }, [PENDING], "workflow.list_pending_runs"],
  ["list_step_runs", (c, ts, o) => listWorkflowStepRunsWithCutover(c, { company_id: NIL, workflow_run_id: NIL }, ts, o),
    { steps: [STEP_ROW] }, [STEP_ROW], "workflow.list_step_runs"],
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

describe("isWorkflowEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isWorkflowEngineCutoverEnabled({ PAPERWORK_ENGINE_WORKFLOW_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isWorkflowEngineCutoverEnabled({ PAPERWORK_ENGINE_WORKFLOW_CUTOVER: v })).toBe(false);
    }
    expect(isWorkflowEngineCutoverEnabled({})).toBe(false);
  });
});

describe("workflow write cutover", () => {
  it.each(WRITES)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op, wire) => {
    const { client, calls } = stub(() => wire);
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: "ts-result" });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
  });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, wantParams, method) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: wire });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: expect.any(Number) } }]);
      expect(timeoutOf(calls[0])).toBeGreaterThanOrEqual(17_000);
    });
  it.each(WRITES)("%s applied:false is a rust result, never a fallback", async (_n, op) => {
    const { client } = stub(() => ({ applied: false }));
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: { applied: false } });
    expect(ts).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS once", async (code) => {
      for (const [, op] of WRITES) {
        const { client } = stub(() => { throw rpc(code); });
        const ts = vi.fn(async () => "ts-result" as never);
        await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
        expect(ts).toHaveBeenCalledTimes(1);
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
        name: "WorkflowCutoverIndeterminateError",
        operation: name,
        classification: { outcome: "indeterminate", retryable: false },
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await transitionWorkflowStepFencedWithCutover(client, STEP_PARAMS, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "transition_step_fenced", cause: error });
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32003); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(transitionWorkflowRunFencedWithCutover(client, RUN_PARAMS, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[1, 17_000], [17_000.5, 17_000], [600_001, 600_000], [Number.NaN, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
  const badRun: [string, WorkflowTransitionRunFencedParams][] = [
    ["non-uuid run_id", { ...RUN_PARAMS, run_id: "nope" }],
    ["empty expected_statuses", { ...RUN_PARAMS, expected_statuses: [] }],
    ["non-canonical status", { ...RUN_PARAMS, next_status: "bogus" as never }],
    ["engine-illegal transition", { ...RUN_PARAMS, next_status: "pending" }],
    ["sparse expected_statuses", { ...RUN_PARAMS, expected_statuses: Array(1) }],
  ];
  it.each(badRun)("ineligible run transition (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => RUN_WIRE);
    const ts = vi.fn(async () => ({ applied: false as const }));
    await expect(transitionWorkflowRunFencedWithCutover(client, params, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  const badStep: [string, WorkflowTransitionStepFencedParams][] = [
    ["non-uuid step_run_id", { ...STEP_PARAMS, step_run_id: "nope" }],
    ["engine-illegal transition", { ...STEP_PARAMS, next_status: "pending" }],
    ["non-i32 transition version", { ...STEP_PARAMS, expected_transition_version: 1.5 }],
    ["sparse expected_statuses", { ...STEP_PARAMS, expected_statuses: Array(1) }],
  ];
  it.each(badStep)("ineligible step transition (%s) uses TS directly with no RPC", async (_l, params) => {
    const { client, calls } = stub(() => STEP_WIRE);
    const ts = vi.fn(async () => ({ applied: false as const }));
    await expect(transitionWorkflowStepFencedWithCutover(client, params, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { applied: false } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
});

describe("workflow read cutover", () => {
  it.each(READS)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op, _w, want) => {
    const { client, calls } = stub(() => ({}));
    const ts = vi.fn(async () => want as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: want });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
  });
  it.each(READS)("%s returns engine rows with the 10s read timeout", async (_n, op, wire, want, method) => {
    const { client, calls } = stub(() => wire);
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
    expect(ts).not.toHaveBeenCalled();
    expect(calls[0].method).toBe(method);
    expect(timeoutOf(calls[0])).toBe(10_000);
  });
  it.each([
    ["rpc -32005", rpc(-32005)],
    ["rpc -32602", rpc(-32602)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("any engine error (%s) warns and falls back to TS once", async (_l, error) => {
    for (const [, op, , want] of READS) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn(async () => want as never);
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(ts).toHaveBeenCalledTimes(1);
    }
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => [] as never);
    await expect(listPendingWorkflowRunsWithCutover(client, { company_id: NIL, limit: 5 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 1], [1, 1], [600_001, 600_000], [Number.NaN, 10_000], [undefined, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
  it("engine-inexpressible read params warn and stay on TS with zero RPC calls", async () => {
    const { client, calls } = stub(() => ({ runs: [] }));
    const ts = vi.fn(async () => [] as never);
    await expect(listPendingWorkflowRunsWithCutover(client, { company_id: "nope", limit: 5 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    await expect(listPendingWorkflowRunsWithCutover(client, { company_id: NIL, limit: 1.5 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    await expect(listWorkflowStepRunsWithCutover(client, { company_id: NIL, workflow_run_id: "nope" }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(3);
  });
});

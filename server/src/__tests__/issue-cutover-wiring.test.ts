import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  Issue, IssueCheckoutFencedParams, IssueTransitionStatusFencedParams,
  IssueWorkProduct, IssueWriteResult,
} from "../services/paperwork-engine-issue.js";
import { IssueCutoverIndeterminateError } from "../services/issue-cutover.js";
import {
  createIssueCutoverHooks, getIssueCutoverMetrics, resetIssueCutoverMetricsForTests,
  wireIssueCheckoutFencedCutover, wireIssueGetCutover,
  wireIssueListByCompanyCutover, wireIssueListWorkProductsCutover,
  wireIssueReleaseCheckoutFencedCutover, wireIssueTransitionStatusFencedCutover,
  type IssueCutoverResult, type IssueCutoverTelemetryEvent,
  type IssueCutoverWiringOpts, type IssueWiredOperation,
} from "../services/issue-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_RUST_ISSUE_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z";
const T1 = "2026-07-01T00:00:00Z";
const ISSUE: Issue = {
  id: NIL, company_id: U1, project_id: U2, mission_id: null, parent_id: null, title: "t",
  description: null, status: "todo", priority: "high", assignee_agent_id: null,
  assignee_user_id: null, checkout_run_id: null, execution_run_id: null,
  execution_agent_name_key: null, execution_locked_at: null, created_by_agent_id: null,
  created_by_user_id: "u1", issue_number: 7, identifier: "P-7", origin_kind: "manual",
  origin_id: null, origin_run_id: null, request_depth: 0, billing_code: null,
  started_at: T0, completed_at: null, cancelled_at: null, hidden_at: null,
  created_at: T0, updated_at: T1,
};
const WP: IssueWorkProduct = {
  id: NIL, company_id: U1, project_id: null, issue_id: NIL, execution_workspace_id: U2,
  runtime_service_id: null, work_product_type: "pr", provider: "github", external_id: "42",
  title: "w", url: "https://x", status: "open", review_state: "pending", is_primary: true,
  health_status: "ok", summary: null, metadata: { a: [1] }, created_by_run_id: NIL,
  source_execution_generation: 2, created_at: T0, updated_at: T1,
};
const GET_P = { company_id: U1, issue_id: NIL };
const LIST_P = { company_id: U1, limit: 50 };
const CHECKOUT: IssueCheckoutFencedParams = {
  ...GET_P, agent_id: U2, run_id: NIL, expected_statuses: ["todo", "backlog"],
};
const TRANS: IssueTransitionStatusFencedParams = {
  ...GET_P, expected_status: "todo", new_status: "in_progress",
};
const RELEASE = { ...GET_P, run_id: NIL };
const APPLIED: IssueWriteResult = { applied: true, issue: ISSUE };
const FENCED: IssueWriteResult = { applied: false, reason: "fenced" };

interface OpCase {
  op: IssueWiredOperation; method: string; response: unknown; result: unknown;
  notApplied?: unknown;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: IssueCutoverWiringOpts) => Promise<IssueCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "checkout_fenced", method: "issue.checkout_fenced", response: APPLIED,
    result: APPLIED, notApplied: FENCED,
    invoke: (f, o) => wireIssueCheckoutFencedCutover(CHECKOUT, f as never, o) },
  { op: "transition_status_fenced", method: "issue.transition_status_fenced",
    response: APPLIED, result: APPLIED, notApplied: FENCED,
    invoke: (f, o) => wireIssueTransitionStatusFencedCutover(TRANS, f as never, o) },
  { op: "release_checkout_fenced", method: "issue.release_checkout_fenced",
    response: APPLIED, result: APPLIED, notApplied: FENCED,
    invoke: (f, o) => wireIssueReleaseCheckoutFencedCutover(RELEASE, f as never, o) },
  { op: "get", method: "issue.get", response: { issue: ISSUE }, result: { issue: ISSUE },
    invoke: (f, o) => wireIssueGetCutover(GET_P, f as never, o) },
  { op: "list_by_company", method: "issue.list_by_company",
    response: { issues: [ISSUE] }, result: { issues: [ISSUE] },
    invoke: (f, o) => wireIssueListByCompanyCutover(LIST_P, f as never, o) },
  { op: "list_issue_work_products", method: "issue.list_issue_work_products",
    response: { work_products: [WP] }, result: { work_products: [WP] },
    invoke: (f, o) => wireIssueListWorkProductsCutover(GET_P, f as never, o) },
];
const WRITES = OPS.slice(0, 3), READS = OPS.slice(3);

function stubClient(script: (method: string) => unknown) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) =>
      (calls.push({ method, params, callOpts }), script(method)),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc_${code}`, code);

beforeEach(() => resetIssueCutoverMetricsForTests());

describe("issue-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_ISSUE_CUTOVER: "0" }, { PAPERWORK_RUST_ISSUE_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getIssueCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    }
    expect(m.checkout_fenced.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireIssueCheckoutFencedCutover(CHECKOUT, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    await expect(wireIssueCheckoutFencedCutover(CHECKOUT, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getIssueCutoverMetrics().checkout_fenced)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess (no fenceMismatch)", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const opts = { env: ON, getClient: () => client };
    for (const op of OPS) {
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, opts)).resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(calls.map((c) => c.method)).toEqual(OPS.map((o) => o.method));
    const m = getIssueCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    }
  });

  it.each([-32001, -32003])("flag ON + not_committed rpc %i falls back to tsFallback (tsFallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireIssueCheckoutFencedCutover(CHECKOUT, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getIssueCutoverMetrics().checkout_fenced)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const opts = { env: ON, getClient: () => client };
    for (const op of WRITES) {
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, opts)).rejects.toBeInstanceOf(IssueCutoverIndeterminateError);
      expect(tsFallback).not.toHaveBeenCalled();
    }
    const m = getIssueCutoverMetrics();
    for (const op of WRITES) {
      expect(m[op.op]).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
    }
  });

  it.each(READS)("flag ON + $op read engine error falls back to tsFallback (never indeterminate)", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t")]) {
      const { client } = stubClient(() => { throw error; });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
    expect(getIssueCutoverMetrics()[op.op])
      .toMatchObject({ tsFallback: 2, indeterminateError: 0, rustSuccess: 0 });
  });

  it.each(WRITES)("$op: Rust and TS {applied:false} results propagate untouched and count fenceMismatch", async (op) => {
    const { client } = stubClient(() => op.notApplied);
    const tsFallback = vi.fn();
    await expect(op.invoke(tsFallback as never, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: op.notApplied });
    expect(tsFallback).not.toHaveBeenCalled();
    await expect(op.invoke(async () => op.notApplied, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: op.notApplied });
    expect(getIssueCutoverMetrics()[op.op])
      .toMatchObject({ rustSuccess: 1, tsBypass: 1, fenceMismatch: 2, tsFallback: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireIssueCheckoutFencedCutover(CHECKOUT, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getIssueCutoverMetrics().checkout_fenced)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("createIssueCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: IssueCutoverTelemetryEvent[] = [];
    const hooks = createIssueCutoverHooks({
      env: ON, getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.checkoutFenced(CHECKOUT, vi.fn())).resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(hooks.listByCompany(LIST_P, vi.fn())).resolves.toEqual({ source: "rust", value: { issues: [ISSUE] } });
    await expect(hooks.listWorkProducts(GET_P, vi.fn())).resolves.toEqual({ source: "rust", value: { work_products: [WP] } });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.checkoutFenced(CHECKOUT, async () => APPLIED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(events).toHaveLength(4);

    const m = hooks.getMetrics();
    expect(m.checkout_fenced).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.list_by_company).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(m.list_issue_work_products).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getIssueCutoverMetrics().checkout_fenced.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireIssueCheckoutFencedCutover(CHECKOUT, async () => APPLIED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: IssueCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: APPLIED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getIssueCutoverMetrics returns a deep copy; reset zeroes every operation", async () => {
    await wireIssueGetCutover(GET_P, async () => ({ issue: ISSUE }), { env: OFF });
    const snap = getIssueCutoverMetrics();
    Object.assign(snap.get, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.checkout_fenced, { totalCalls: 999 });
    const fresh = getIssueCutoverMetrics();
    expect(fresh.get).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.checkout_fenced.totalCalls).toBe(0);

    resetIssueCutoverMetricsForTests();
    const zeroed = getIssueCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  Approval, ApprovalCreateParams, ApprovalCreateResult, ApprovalListParams,
  ApprovalResolveParams, ApprovalResolveResult, ApprovalRevisionParams,
  ApprovalScopedParams, ApprovalUpdatedResult,
} from "../services/paperwork-engine-approval.js";
import { ApprovalCutoverIndeterminateError } from "../services/paperwork-engine-approval-cutover.js";
import {
  createApprovalCutoverHooks, getApprovalCutoverMetrics,
  resetApprovalCutoverMetricsForTests, wireCancelApprovalFencedCutover,
  wireCreateApprovalCutover, wireGetApprovalCutover, wireListApprovalsCutover,
  wireRequestApprovalRevisionFencedCutover, wireResubmitApprovalFencedCutover,
  wireResolveApprovalFencedCutover, type ApprovalCutoverTelemetryEvent,
} from "../services/approval-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_APPROVAL_CUTOVER: "1" };
const OFF = {};
const TS = "2026-01-01T00:00:00Z";
const APPROVAL: Approval = {
  id: "11111111-1111-1111-1111-111111111111", company_id: NIL, approval_type: "deploy",
  requested_by_agent_id: null, requested_by_user_id: null, requested_by_plugin_id: null,
  status: "pending", payload: { pr: 7 }, decision_note: null, decided_by_user_id: null,
  decided_at: null, created_at: TS, updated_at: TS,
};
const CREATED: ApprovalCreateResult = { created: true, approval: APPROVAL };
const RESOLVED: ApprovalResolveResult = { outcome: "applied", approval: APPROVAL };
const UPDATED: ApprovalUpdatedResult = { updated: true, approval: APPROVAL };
const CREATE: ApprovalCreateParams = { company_id: NIL, approval_type: "deploy", payload: { pr: 7 } };
const RESOLVE: ApprovalResolveParams = {
  approval_id: NIL, company_id: NIL, target_status: "approved", decided_by_user_id: "u-1",
};
const REVISION: ApprovalRevisionParams = {
  approval_id: NIL, company_id: NIL, decided_by_user_id: "u-1",
};
const SCOPED: ApprovalScopedParams = { approval_id: NIL, company_id: NIL };
const LIST: ApprovalListParams = { company_id: NIL, limit: 5 };
const okScript = (method: string): unknown => {
  if (method === "approval.create") return CREATED;
  if (method === "approval.resolve_fenced") return RESOLVED;
  if (method === "approval.get") return { approval: APPROVAL };
  if (method === "approval.list") return { approvals: [APPROVAL] };
  return UPDATED;
};

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
const hostileError = () => Object.defineProperty(new Error("boom"), "stack",
  { get() { throw new Error("stack-getter-boom"); } });

beforeEach(() => resetApprovalCutoverMetricsForTests());

describe("approval-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(okScript).client);
    for (const env of [OFF, { PAPERWORK_ENGINE_APPROVAL_CUTOVER: "0" },
      { PAPERWORK_ENGINE_APPROVAL_CUTOVER: "true" }]) {
      const created = await wireCreateApprovalCutover(CREATE, async () => CREATED, { env, getClient });
      const got = await wireGetApprovalCutover(SCOPED, async () => APPROVAL, { env, getClient });
      expect(created).toEqual({ source: "ts", value: CREATED });
      expect(got).toEqual({ source: "ts", value: APPROVAL });
    }
    expect(getClient).not.toHaveBeenCalled();
    const m = getApprovalCutoverMetrics();
    expect(m.create).toMatchObject({ totalCalls: 3, tsBypass: 3, rustSuccess: 0, tsFallback: 0 });
    expect(m.get).toMatchObject({ totalCalls: 3, tsBypass: 3 });
    expect(m.resolve_fenced.totalCalls).toBe(0);
  });

  it("flag ON + null or throwing getClient fails safe to tsFallback counted as tsBypass", async () => {
    const tsFallback = vi.fn(async () => CREATED);
    await expect(wireCreateApprovalCutover(CREATE, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: CREATED });
    await expect(wireCreateApprovalCutover(CREATE, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: CREATED });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(getApprovalCutoverMetrics().create)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("flag ON + Rust success returns source rust and increments rustSuccess", async () => {
    const { client, calls } = stubClient(okScript);
    const opts = { env: ON, getClient: () => client };
    const tsFallback = vi.fn();
    await expect(wireCreateApprovalCutover(CREATE, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: CREATED });
    await expect(wireResolveApprovalFencedCutover(RESOLVE, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: RESOLVED });
    await expect(wireRequestApprovalRevisionFencedCutover(REVISION, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(wireResubmitApprovalFencedCutover(SCOPED, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(wireCancelApprovalFencedCutover(SCOPED, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: UPDATED });
    await expect(wireGetApprovalCutover(SCOPED, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: APPROVAL });
    await expect(wireListApprovalsCutover(LIST, tsFallback, opts))
      .resolves.toEqual({ source: "rust", value: [APPROVAL] });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual([
      "approval.create", "approval.resolve_fenced", "approval.request_revision_fenced",
      "approval.resubmit_fenced", "approval.cancel_fenced", "approval.get", "approval.list",
    ]);
    const m = getApprovalCutoverMetrics();
    expect(m.create).toMatchObject({ rustSuccess: 1, tsBypass: 0, tsFallback: 0, fenceMismatch: 0 });
    expect(m.list).toMatchObject({ rustSuccess: 1, fenceMismatch: 0 });
  });

  it.each([-32001, -32602])("flag ON + not_committed rpc %i falls back to tsFallback once",
    async (code) => {
      const { client } = stubClient(() => { throw rpc(code); });
      const tsFallback = vi.fn(async () => CREATED);
      await expect(wireCreateApprovalCutover(CREATE, tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "ts", value: CREATED });
      expect(tsFallback).toHaveBeenCalledTimes(1);
      expect(getApprovalCutoverMetrics().create)
        .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
    });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback",
    async (_label, error) => {
      const { client } = stubClient(() => { throw error; });
      const tsCreate = vi.fn();
      const tsResolve = vi.fn();
      const opts = { env: ON, getClient: () => client };
      await expect(wireCreateApprovalCutover(CREATE, tsCreate, opts))
        .rejects.toBeInstanceOf(ApprovalCutoverIndeterminateError);
      await expect(wireResolveApprovalFencedCutover(RESOLVE, tsResolve, opts))
        .rejects.toBeInstanceOf(ApprovalCutoverIndeterminateError);
      expect(tsCreate).not.toHaveBeenCalled();
      expect(tsResolve).not.toHaveBeenCalled();
      const m = getApprovalCutoverMetrics();
      expect(m.create).toMatchObject({ indeterminateError: 1, tsBypass: 0, tsFallback: 0 });
      expect(m.resolve_fenced).toMatchObject({ indeterminateError: 1 });
    });

  it.each([
    ["rpc -32005", rpc(-32005)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
  ])("read ops (%s) fall back to TS once — reads never go indeterminate", async (_l, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsGet = vi.fn(async () => APPROVAL);
    const tsList = vi.fn(async () => [APPROVAL]);
    const opts = { env: ON, getClient: () => client };
    await expect(wireGetApprovalCutover(SCOPED, tsGet, opts))
      .resolves.toEqual({ source: "ts", value: APPROVAL });
    await expect(wireListApprovalsCutover(LIST, tsList, opts))
      .resolves.toEqual({ source: "ts", value: [APPROVAL] });
    expect(tsGet).toHaveBeenCalledTimes(1);
    expect(tsList).toHaveBeenCalledTimes(1);
    const m = getApprovalCutoverMetrics();
    expect(m.get).toMatchObject({ tsFallback: 1, indeterminateError: 0 });
    expect(m.list).toMatchObject({ tsFallback: 1 });
  });

  it("Rust negative results count fenceMismatch without invoking tsFallback", async () => {
    const script = (method: string) => {
      if (method === "approval.create") return { created: false };
      if (method === "approval.resolve_fenced") return { outcome: "not_found_or_conflict" };
      return { updated: false };
    };
    const { client } = stubClient(script);
    const opts = { env: ON, getClient: () => client };
    await expect(wireCreateApprovalCutover(CREATE, vi.fn(), opts))
      .resolves.toEqual({ source: "rust", value: { created: false } });
    await expect(wireResolveApprovalFencedCutover(RESOLVE, vi.fn(), opts))
      .resolves.toEqual({ source: "rust", value: { outcome: "not_found_or_conflict" } });
    await expect(wireResubmitApprovalFencedCutover(SCOPED, vi.fn(), opts))
      .resolves.toEqual({ source: "rust", value: { updated: false } });
    const m = getApprovalCutoverMetrics();
    expect(m.create).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
    expect(m.resolve_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
    expect(m.resubmit_fenced).toMatchObject({ rustSuccess: 1, fenceMismatch: 1 });
  });

  it("counts fenceMismatch for TS-originated negative results as well", async () => {
    await expect(wireCancelApprovalFencedCutover(SCOPED, async () => ({ updated: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { updated: false } });
    expect(getApprovalCutoverMetrics().cancel_fenced)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustSuccess: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireCreateApprovalCutover(CREATE, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getApprovalCutoverMetrics().create)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ company_id: "not-a-uuid", approval_type: "deploy", payload: {} });
    await expect(wireCreateApprovalCutover(params, async () => ({ created: false }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { created: false } });
    expect(params).toEqual({ company_id: "not-a-uuid", approval_type: "deploy", payload: {} });
  });

  it("createApprovalCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient(okScript);
    const events: ApprovalCutoverTelemetryEvent[] = [];
    const hooks = createApprovalCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.create(CREATE, vi.fn())).resolves.toEqual({ source: "rust", value: CREATED });
    await expect(hooks.resolveFenced(RESOLVE, vi.fn())).resolves.toEqual({ source: "rust", value: RESOLVED });
    expect(events.map((e) => e.outcome)).toEqual(["rust_success", "rust_success"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    await expect(hooks.create(CREATE, async () => CREATED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: CREATED });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.create).toMatchObject({ rustSuccess: 1, tsBypass: 1, totalCalls: 2 });
    expect(m.resolve_fenced).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(getApprovalCutoverMetrics().create.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireCreateApprovalCutover(CREATE, async () => CREATED, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as
          (e: ApprovalCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: CREATED });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getApprovalCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireCreateApprovalCutover(CREATE, async () => CREATED, { env: OFF });
    const snap = getApprovalCutoverMetrics();
    Object.assign(snap.create, { tsBypass: 999, rustSuccess: 999 });
    Object.assign(snap.get, { totalCalls: 999 });
    const fresh = getApprovalCutoverMetrics();
    expect(fresh.create).toMatchObject({ tsBypass: 1, rustSuccess: 0, totalCalls: 1 });
    expect(fresh.get.totalCalls).toBe(0);

    resetApprovalCutoverMetricsForTests();
    expect(getApprovalCutoverMetrics().create.totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => CREATED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireCreateApprovalCutover(CREATE, tsFallback,
      { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(ApprovalCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getApprovalCutoverMetrics().create).toMatchObject({ indeterminateError: 1, tsFallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => CREATED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireCreateApprovalCutover(CREATE, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: CREATED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getApprovalCutoverMetrics().create).toMatchObject({ tsBypass: 1 });
  });
});

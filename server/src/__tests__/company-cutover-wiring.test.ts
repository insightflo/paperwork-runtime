import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  CompanyCreateParams, CompanyGetByIdParams, CompanyGetByPrefixParams,
  CompanyListParams, CompanyNextCounterParams, CompanyPauseParams,
  CompanyResumeParams, CompanyUpdateParams, EngineCompany,
} from "../services/paperwork-engine-company.js";
import {
  CompanyCutoverIndeterminateError, createCompanyCutoverHooks,
  getCompanyCutoverMetrics, resetCompanyCutoverMetricsForTests,
  wireCreateCompanyCutover, wireGetCompanyByIdCutover,
  wireGetCompanyByIssuePrefixCutover, wireListCompaniesCutover,
  wireNextCompanyIssueCounterCutover, wirePauseCompanyCutover,
  wireResumeCompanyCutover, wireUpdateCompanyCutover,
  type CompanyCutoverResult, type CompanyCutoverTelemetryEvent,
  type CompanyCutoverWiringOpts, type CompanyWiredOperation,
} from "../services/company-cutover-wiring.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_COMPANY_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-01-01T00:00:00Z";
const COMPANY: EngineCompany = {
  id: NIL, name: "Acme", description: null, status: "active", pause_reason: null,
  paused_at: null, issue_prefix: "ACM", issue_counter: 1, budget_monthly_cents: 0,
  spent_monthly_cents: 0, require_board_approval_for_new_agents: false,
  timezone: null, work_product_root: null, default_language: "en", brand_color: null,
  company_kind: "business", allows_code_modify: true, created_at: T0, updated_at: T0,
};
const CREATE: CompanyCreateParams = {
  name: "Acme", description: null, issue_prefix: "ACM", budget_monthly_cents: 0,
  spent_monthly_cents: 0, require_board_approval_for_new_agents: false,
  timezone: null, work_product_root: null, default_language: "en", brand_color: null,
  company_kind: "business", allows_code_modify: true,
};
const UPDATE: CompanyUpdateParams = { company_id: NIL, name: "Next" };
const PAUSE: CompanyPauseParams = { company_id: NIL, pause_reason: "budget" };
const RESUME: CompanyResumeParams = { company_id: NIL };
const COUNTER: CompanyNextCounterParams = { company_id: NIL };
const LIST: CompanyListParams = {};
const GET_ID: CompanyGetByIdParams = { company_id: NIL };
const GET_PREFIX: CompanyGetByPrefixParams = { issue_prefix: "ACM" };
const CREATE_RESULT = { company: COMPANY };
const UPDATE_RESULT = { company: COMPANY };
const PAUSE_RESULT = { paused: true as const, company: COMPANY };
const RESUME_RESULT = { resumed: true as const, company: COMPANY };
const COUNTER_RESULT = { company: { issue_prefix: "ACM", issue_counter: 2 } };
const LIST_RESULT = { companies: [COMPANY] };
const GET_RESULT = { company: COMPANY };
const UPDATE_MISS = { company: null };
const PAUSE_MISS = { paused: false as const, company: null };
const RESUME_MISS = { resumed: false as const, company: null };
const COUNTER_MISS = { company: null };

interface OpCase {
  op: CompanyWiredOperation; method: string; response: unknown; result: unknown;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: CompanyCutoverWiringOpts) => Promise<CompanyCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "create_company", method: "company.create", response: CREATE_RESULT,
    result: CREATE_RESULT, invoke: (f, o) => wireCreateCompanyCutover(CREATE, f as never, o) },
  { op: "update_company", method: "company.update", response: UPDATE_RESULT,
    result: UPDATE_RESULT, invoke: (f, o) => wireUpdateCompanyCutover(UPDATE, f as never, o) },
  { op: "pause_company", method: "company.pause", response: PAUSE_RESULT,
    result: PAUSE_RESULT, invoke: (f, o) => wirePauseCompanyCutover(PAUSE, f as never, o) },
  { op: "resume_company", method: "company.resume", response: RESUME_RESULT,
    result: RESUME_RESULT, invoke: (f, o) => wireResumeCompanyCutover(RESUME, f as never, o) },
  { op: "next_company_issue_counter", method: "company.next_issue_counter", response: COUNTER_RESULT,
    result: COUNTER_RESULT, invoke: (f, o) => wireNextCompanyIssueCounterCutover(COUNTER, f as never, o) },
  { op: "list_companies", method: "company.list", response: LIST_RESULT,
    result: LIST_RESULT, invoke: (f, o) => wireListCompaniesCutover(LIST, f as never, o) },
  { op: "get_company_by_id", method: "company.get_by_id", response: GET_RESULT,
    result: GET_RESULT, invoke: (f, o) => wireGetCompanyByIdCutover(GET_ID, f as never, o) },
  { op: "get_company_by_issue_prefix", method: "company.get_by_issue_prefix", response: GET_RESULT,
    result: GET_RESULT, invoke: (f, o) => wireGetCompanyByIssuePrefixCutover(GET_PREFIX, f as never, o) },
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

beforeEach(() => resetCompanyCutoverMetricsForTests());
afterEach(() => vi.restoreAllMocks());

describe("company-cutover-wiring", () => {
  it("flag OFF routes every op to tsFallback without client resolution and counts tsBypass", async () => {
    const getClient = vi.fn(() => { throw new Error("must not resolve engine"); });
    for (const op of OPS) {
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: OFF, getClient }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
    expect(getClient).not.toHaveBeenCalled();
    const metrics = getCompanyCutoverMetrics();
    for (const op of OPS) {
      expect(metrics[op.op]).toMatchObject({ totalCalls: 1, tsBypass: 1, rustSuccess: 0, tsFallback: 0 });
    }
  });

  it("flag ON + client uses rust for all 8 ops and emits complete telemetry", async () => {
    const { client, calls } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    const events: CompanyCutoverTelemetryEvent[] = [];
    const opts = { env: ON, getClient: () => client,
      onEvent: (event: CompanyCutoverTelemetryEvent) => { events.push(event); } };
    for (const op of OPS) {
      const tsFallback = vi.fn();
      await expect(op.invoke(tsFallback, opts)).resolves.toEqual({ source: "rust", value: op.result });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    expect(calls.map((c) => c.method)).toEqual(OPS.map((o) => o.method));
    expect(events).toHaveLength(OPS.length);
    expect(events[0]).toMatchObject({
      operation: "create_company", outcome: "rust_success", source: "rust", fenceMismatch: false,
    });
    expect(typeof events[0].durationMs).toBe("number");
    const metrics = getCompanyCutoverMetrics();
    for (const op of OPS) expect(metrics[op.op]).toMatchObject({ totalCalls: 1, rustSuccess: 1 });
  });

  it("not_committed adapter fallback returns source ts and counts tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const tsFallback = vi.fn(async () => CREATE_RESULT);
    await expect(wireCreateCompanyCutover(CREATE, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getCompanyCutoverMetrics().create_company)
      .toMatchObject({ tsFallback: 1, tsBypass: 0, rustSuccess: 0, indeterminateError: 0 });
  });

  it("indeterminate adapter error is counted, rethrown, and never double-calls tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => UPDATE_RESULT);
    await expect(wireUpdateCompanyCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(CompanyCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getCompanyCutoverMetrics().update_company)
      .toMatchObject({ indeterminateError: 1, tsFallback: 0, tsBypass: 0 });
  });

  it("tsFallback failure under bypass is counted as tsError and rethrown", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireCreateCompanyCutover(CREATE, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getCompanyCutoverMetrics().create_company)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("flag ON + null or throwing getClient warns and fails safe to tsBypass", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const tsFallback = vi.fn(async () => CREATE_RESULT);
    await expect(wireCreateCompanyCutover(CREATE, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    await expect(wireCreateCompanyCutover(CREATE, tsFallback, {
      env: ON,
      getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(getCompanyCutoverMetrics().create_company)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustSuccess: 0, tsFallback: 0 });
  });

  it("throwing and rejecting onEvent observers never break calls or suppress counters", async () => {
    await expect(wireCreateCompanyCutover(CREATE, async () => CREATE_RESULT, {
      env: OFF, onEvent: () => { throw new Error("observer boom"); },
    })).resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    await expect(wireUpdateCompanyCutover(UPDATE, async () => UPDATE_RESULT, {
      env: OFF, onEvent: () => Promise.reject(new Error("observer rejection")) as never,
    })).resolves.toEqual({ source: "ts", value: UPDATE_RESULT });
    const metrics = getCompanyCutoverMetrics();
    expect(metrics.create_company).toMatchObject({ totalCalls: 1, tsBypass: 1 });
    expect(metrics.update_company).toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("fence misses count for pause/resume/update/counter only and still return as-is", async () => {
    const fenced = [
      ["update_company", UPDATE_MISS, (f: () => Promise<unknown>, o?: CompanyCutoverWiringOpts) => wireUpdateCompanyCutover(UPDATE, f as never, o)],
      ["pause_company", PAUSE_MISS, (f: () => Promise<unknown>, o?: CompanyCutoverWiringOpts) => wirePauseCompanyCutover(PAUSE, f as never, o)],
      ["resume_company", RESUME_MISS, (f: () => Promise<unknown>, o?: CompanyCutoverWiringOpts) => wireResumeCompanyCutover(RESUME, f as never, o)],
      ["next_company_issue_counter", COUNTER_MISS, (f: () => Promise<unknown>, o?: CompanyCutoverWiringOpts) => wireNextCompanyIssueCounterCutover(COUNTER, f as never, o)],
    ] as const;
    for (const [op, response, invoke] of fenced) {
      const { client } = stubClient(() => response);
      const tsFallback = vi.fn();
      await expect(invoke(tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "rust", value: response });
      expect(tsFallback).not.toHaveBeenCalled();
      expect(getCompanyCutoverMetrics()[op].fenceMismatch).toBe(1);
    }
    const { client } = stubClient((method) => OPS.find((o) => o.method === method)?.response);
    for (const op of OPS.filter((o) => ["create_company", "list_companies", "get_company_by_id", "get_company_by_issue_prefix"].includes(o.op))) {
      await expect(op.invoke(async () => op.result, { env: ON, getClient: () => client })).resolves.toMatchObject({ source: "rust" });
      expect(getCompanyCutoverMetrics()[op.op].fenceMismatch).toBe(0);
    }
    await expect(wirePauseCompanyCutover(PAUSE, async () => PAUSE_MISS, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: PAUSE_MISS });
    expect(getCompanyCutoverMetrics().pause_company.fenceMismatch).toBe(2);
  });

  it("metrics snapshots are deep copies and reset clears all counters", async () => {
    await wireCreateCompanyCutover(CREATE, async () => CREATE_RESULT, { env: OFF });
    const snapshot = getCompanyCutoverMetrics();
    Object.assign(snapshot.create_company, { tsBypass: 999, totalCalls: 999 });
    const fresh = getCompanyCutoverMetrics();
    expect(fresh.create_company).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(fresh.list_companies.totalCalls).toBe(0);
    resetCompanyCutoverMetricsForTests();
    const zeroed = getCompanyCutoverMetrics();
    for (const op of OPS) expect(zeroed[op.op].totalCalls).toBe(0);
  });

  it("hook meters are independent from the module meter and from each other", async () => {
    const { client } = stubClient(() => CREATE_RESULT);
    const hooksA = createCompanyCutoverHooks({ env: ON, getClient: () => client });
    const hooksB = createCompanyCutoverHooks({ env: OFF });
    await expect(hooksA.createCompany(CREATE, vi.fn())).resolves.toEqual({ source: "rust", value: CREATE_RESULT });
    await expect(hooksB.createCompany(CREATE, async () => CREATE_RESULT)).resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(hooksA.getMetrics().create_company).toMatchObject({ rustSuccess: 1, totalCalls: 1 });
    expect(hooksB.getMetrics().create_company).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(getCompanyCutoverMetrics().create_company.totalCalls).toBe(0);
  });

  it("hook defaults merge with per-call opts and per-call values win", async () => {
    const { client, calls } = stubClient(() => CREATE_RESULT);
    const events: CompanyCutoverTelemetryEvent[] = [];
    const getClient = vi.fn(() => client);
    const hooks = createCompanyCutoverHooks({
      env: ON, getClient, timeoutMs: 20_000,
      onEvent: (event) => { events.push(event); },
    });
    await expect(hooks.createCompany(CREATE, vi.fn(), { timeoutMs: 30_000 }))
      .resolves.toEqual({ source: "rust", value: CREATE_RESULT });
    expect(calls[0].callOpts).toEqual({ timeoutMs: 30_000 });
    expect(events).toHaveLength(1);
    await expect(hooks.createCompany(CREATE, async () => CREATE_RESULT, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.outcome)).toEqual(["rust_success", "ts_bypass"]);
    expect(hooks.getMetrics().create_company).toMatchObject({ totalCalls: 2, rustSuccess: 1, tsBypass: 1 });
  });

  it("durationMs and totalDurationMs accumulate across calls", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100).mockReturnValueOnce(107)
      .mockReturnValueOnce(200).mockReturnValueOnce(205);
    const events: CompanyCutoverTelemetryEvent[] = [];
    const opts = { env: OFF, onEvent: (event: CompanyCutoverTelemetryEvent) => { events.push(event); } };
    await wireCreateCompanyCutover(CREATE, async () => CREATE_RESULT, opts);
    await wireCreateCompanyCutover(CREATE, async () => CREATE_RESULT, opts);
    expect(events.map((event) => event.durationMs)).toEqual([7, 5]);
    expect(getCompanyCutoverMetrics().create_company.totalDurationMs).toBe(12);
  });
});

import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  CompanyCutoverIndeterminateError, createCompanyWithCutover,
  cutoverReadTimeoutMs, cutoverWriteTimeoutMs, getCompanyByIdWithCutover,
  getCompanyByIssuePrefixWithCutover, isCompanyEngineCutoverEnabled,
  listCompaniesWithCutover, nextCompanyIssueCounterWithCutover,
  pauseCompanyWithCutover, resumeCompanyWithCutover, updateCompanyWithCutover,
  type CompanyCutoverCallOpts, type CompanyCutoverResult,
} from "../services/company-cutover.js";
import type {
  CompanyCreateParams, CompanyGetByIdParams, CompanyGetByPrefixParams,
  CompanyListParams, CompanyNextCounterParams, CompanyPauseParams,
  CompanyResumeParams, CompanyUpdateParams,
} from "../services/paperwork-engine-company.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_COMPANY_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const COMPANY = {
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

type Invoke = (client: PaperworkEngineClient | null, tsFallback: () => Promise<unknown>,
  opts?: CompanyCutoverCallOpts) => Promise<CompanyCutoverResult<unknown>>;
interface Op {
  op: string; method: string; params: Readonly<Record<string, unknown>>;
  response: unknown; result: unknown; invoke: Invoke;
}
const WRITES: Op[] = [
  { op: "create_company", method: "company.create", params: CREATE,
    response: CREATE_RESULT, result: CREATE_RESULT,
    invoke: (c, f, o) => createCompanyWithCutover(c, CREATE, f as never, o) },
  { op: "update_company", method: "company.update", params: UPDATE,
    response: UPDATE_RESULT, result: UPDATE_RESULT,
    invoke: (c, f, o) => updateCompanyWithCutover(c, UPDATE, f as never, o) },
  { op: "pause_company", method: "company.pause", params: PAUSE,
    response: PAUSE_RESULT, result: PAUSE_RESULT,
    invoke: (c, f, o) => pauseCompanyWithCutover(c, PAUSE, f as never, o) },
  { op: "resume_company", method: "company.resume", params: RESUME,
    response: RESUME_RESULT, result: RESUME_RESULT,
    invoke: (c, f, o) => resumeCompanyWithCutover(c, RESUME, f as never, o) },
  { op: "next_company_issue_counter", method: "company.next_issue_counter", params: COUNTER,
    response: COUNTER_RESULT, result: COUNTER_RESULT,
    invoke: (c, f, o) => nextCompanyIssueCounterWithCutover(c, COUNTER, f as never, o) },
];
const READS: Op[] = [
  { op: "list_companies", method: "company.list", params: {},
    response: LIST_RESULT, result: LIST_RESULT,
    invoke: (c, f, o) => listCompaniesWithCutover(c, LIST, f as never, o) },
  { op: "get_company_by_id", method: "company.get_by_id", params: GET_ID,
    response: GET_RESULT, result: GET_RESULT,
    invoke: (c, f, o) => getCompanyByIdWithCutover(c, GET_ID, f as never, o) },
  { op: "get_company_by_issue_prefix", method: "company.get_by_issue_prefix", params: GET_PREFIX,
    response: GET_RESULT, result: GET_RESULT,
    invoke: (c, f, o) => getCompanyByIssuePrefixWithCutover(c, GET_PREFIX, f as never, o) },
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

describe("isCompanyEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isCompanyEngineCutoverEnabled(ON)).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isCompanyEngineCutoverEnabled({ PAPERWORK_RUST_COMPANY_CUTOVER: v })).toBe(false);
    }
    expect(isCompanyEngineCutoverEnabled({})).toBe(false);
  });
});

describe("cutover timeout clamps", () => {
  it.each([[0, 17_000], [Number.NaN, 17_000], [-5, 17_000], [5, 17_000],
    [60_000, 60_000], [700_000, 600_000]])("write %s => %s", (input, want) => {
    expect(cutoverWriteTimeoutMs(input)).toBe(want);
  });
  it.each([[0, 10_000], [Number.NaN, 10_000], [5, 5], [700_000, 600_000]])(
    "read %s => %s", (input, want) => {
      expect(cutoverReadTimeoutMs(input)).toBe(want);
    });
});

describe("company write cutover", () => {
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
        name: "CompanyCutoverIndeterminateError", operation: op.op,
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("not_committed -32602 warns and falls back to TS", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const { client } = stub(() => { throw rpc(-32602); });
    const tsFallback = vi.fn(async () => CREATE_RESULT);
    await expect(createCompanyWithCutover(client, CREATE, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
  it.each([
    ["engine timeout", new PaperworkEngineError("timeout", "t")],
    ["unknown transport failure", new Error("transport exploded")],
  ])("%s is fail-closed indeterminate and never falls back", async (_label, cause) => {
    const { client } = stub(() => { throw cause; });
    const tsFallback = vi.fn();
    await expect(updateCompanyWithCutover(client, UPDATE, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "CompanyCutoverIndeterminateError", operation: "update_company", cause,
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([
    ["pause", { paused: false, company: null }, PAUSE_RESULT,
      (c: PaperworkEngineClient, f: () => Promise<unknown>, o?: CompanyCutoverCallOpts) =>
        pauseCompanyWithCutover(c, PAUSE, f as never, o)],
    ["resume", { resumed: false, company: null }, RESUME_RESULT,
      (c: PaperworkEngineClient, f: () => Promise<unknown>, o?: CompanyCutoverCallOpts) =>
        resumeCompanyWithCutover(c, RESUME, f as never, o)],
    ["update", { company: null }, UPDATE_RESULT,
      (c: PaperworkEngineClient, f: () => Promise<unknown>, o?: CompanyCutoverCallOpts) =>
        updateCompanyWithCutover(c, UPDATE, f as never, o)],
    ["next counter", { company: null }, COUNTER_RESULT,
      (c: PaperworkEngineClient, f: () => Promise<unknown>, o?: CompanyCutoverCallOpts) =>
        nextCompanyIssueCounterWithCutover(c, COUNTER, f as never, o)],
  ])("%s fenced miss is authoritative rust data, never TS fallback", async (_label, response, _ok, invoke) => {
    const { client } = stub(() => response);
    const tsFallback = vi.fn();
    await expect(invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: response });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("passes a clamped custom write timeout to the engine", async () => {
    const { client, calls } = stub(() => CREATE_RESULT);
    await createCompanyWithCutover(client, CREATE, vi.fn(), { env: ON, timeoutMs: 700_000 });
    expect(timeoutOf(calls[0])).toBe(600_000);
  });
  it("a throwing logger.warn does not mask the not_committed TS fallback", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("pino boom"); });
    try {
      const { client } = stub(() => { throw rpc(-32602); });
      const tsFallback = vi.fn(async () => CREATE_RESULT);
      await expect(createCompanyWithCutover(client, CREATE, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: CREATE_RESULT });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("company read cutover", () => {
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
  it("passes a clamped custom read timeout to the engine", async () => {
    const { client, calls } = stub(() => LIST_RESULT);
    await listCompaniesWithCutover(client, LIST, vi.fn(), { env: ON, timeoutMs: 5 });
    expect(timeoutOf(calls[0])).toBe(5);
  });
});

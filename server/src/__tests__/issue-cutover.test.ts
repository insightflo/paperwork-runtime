import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyIssueRpcError, type IssueCheckoutFencedParams,
  type IssueTransitionStatusFencedParams,
} from "../services/paperwork-engine-issue.js";
import {
  checkoutIssueFencedWithCutover, getIssueWithCutover,
  IssueCutoverIndeterminateError, isIssueEngineCutoverEnabled,
  listIssueWorkProductsWithCutover, listIssuesByCompanyWithCutover,
  releaseIssueCheckoutFencedWithCutover, transitionIssueStatusFencedWithCutover,
  type IssueCutoverCallOpts, type IssueCutoverResult,
} from "../services/issue-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_RUST_ISSUE_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const ISSUE = {
  id: NIL, company_id: U1, project_id: U2, mission_id: null, parent_id: null, title: "t",
  description: null, status: "todo", priority: "high", assignee_agent_id: null,
  assignee_user_id: null, checkout_run_id: null, execution_run_id: null,
  execution_agent_name_key: null, execution_locked_at: null, created_by_agent_id: null,
  created_by_user_id: "u1", issue_number: 7, identifier: "P-7", origin_kind: "manual",
  origin_id: null, origin_run_id: null, request_depth: 0, billing_code: null,
  started_at: T0, completed_at: null, cancelled_at: null, hidden_at: null,
  created_at: T0, updated_at: T1,
};
const WP = {
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
const APPLIED = { applied: true, issue: ISSUE };

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: IssueCutoverCallOpts) => Promise<IssueCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["checkout_fenced",
    (c, ts, o) => checkoutIssueFencedWithCutover(c, CHECKOUT, ts, o),
    APPLIED, APPLIED, "issue.checkout_fenced", CHECKOUT],
  ["transition_status_fenced",
    (c, ts, o) => transitionIssueStatusFencedWithCutover(c, TRANS, ts, o),
    APPLIED, APPLIED, "issue.transition_status_fenced", TRANS],
  ["release_checkout_fenced",
    (c, ts, o) => releaseIssueCheckoutFencedWithCutover(c, RELEASE, ts, o),
    APPLIED, APPLIED, "issue.release_checkout_fenced", RELEASE],
];
// [op, bound call, wire result, resolved value, RPC method]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string][] = [
  ["get", (c, ts, o) => getIssueWithCutover(c, GET_P, ts, o),
    { issue: ISSUE }, { issue: ISSUE }, "issue.get"],
  ["list_by_company", (c, ts, o) => listIssuesByCompanyWithCutover(c, LIST_P, ts, o),
    { issues: [ISSUE] }, { issues: [ISSUE] }, "issue.list_by_company"],
  ["list_issue_work_products",
    (c, ts, o) => listIssueWorkProductsWithCutover(c, GET_P, ts, o),
    { work_products: [WP] }, { work_products: [WP] }, "issue.list_issue_work_products"],
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

describe("isIssueEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isIssueEngineCutoverEnabled({ PAPERWORK_RUST_ISSUE_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isIssueEngineCutoverEnabled({ PAPERWORK_RUST_ISSUE_CUTOVER: v })).toBe(false);
    }
    expect(isIssueEngineCutoverEnabled({})).toBe(false);
  });
});

describe("issue write cutover", () => {
  it.each(WRITES)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op) => {
    const { client, calls } = stub(() => ({}));
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: "ts-result" });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
  });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 17_000 } }]);
    });
  it.each(WRITES)("%s {applied:false,reason} is a rust result, never a fallback", async (_n, op) => {
    const { client } = stub(() => ({ applied: false, reason: "fenced" }));
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { applied: false, reason: "fenced" } });
    expect(ts).not.toHaveBeenCalled();
  });
  it.each([-32001, -32002, -32003, -32004, -32602])(
    "not_committed rpc %i warns and falls back to TS once", async (code) => {
      for (const [name, op] of WRITES) {
        const { client } = stub(() => { throw rpc(code); });
        const ts = vi.fn(async () => "ts-result" as never);
        await expect(op(client, ts, { env: ON }))
          .resolves.toEqual({ source: "ts", value: "ts-result" });
        expect(ts).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          expect.objectContaining({ operation: name }), expect.any(String));
        vi.mocked(logger.warn).mockReset();
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
        name: "IssueCutoverIndeterminateError",
        operation: name,
        classification: classifyIssueRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => ({ applied: false, reason: "fenced" }));
    const ts = vi.fn();
    await expect(checkoutIssueFencedWithCutover(client,
      { ...CHECKOUT, expected_statuses: [] }, ts, { env: ON }))
      .rejects.toBeInstanceOf(IssueCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await transitionIssueStatusFencedWithCutover(client, TRANS, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(IssueCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "transition_status_fenced", cause: error });
    expect(err.classification).toEqual(classifyIssueRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32003); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(transitionIssueStatusFencedWithCutover(client, TRANS, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32003); });
    const boom = new Error("ts boom");
    await expect(transitionIssueStatusFencedWithCutover(client, TRANS,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[0, 17_000], [17_000, 17_000], [17_000.5, 17_000], [700_000, 600_000],
    [Number.NaN, 17_000], [Number.POSITIVE_INFINITY, 17_000], [12.7, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("issue read cutover", () => {
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
  it("pre-send validation errors also fall back on reads", async () => {
    const { client, calls } = stub(() => ({ issue: null }));
    const ts = vi.fn(async () => ({ issue: null }) as never);
    await expect(getIssueWithCutover(client,
      { issue_id: "nope", company_id: U1 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { issue: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ issue: null }) as never);
    await expect(getIssueWithCutover(client, GET_P, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { issue: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 1], [10_000, 10_000], [10_000.9, 10_000], [700_000, 600_000],
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000], [12.7, 12], [undefined, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

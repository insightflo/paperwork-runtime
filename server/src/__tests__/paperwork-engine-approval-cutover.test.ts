import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  ApprovalCutoverIndeterminateError, cancelApprovalFencedWithCutover,
  createApprovalWithCutover, getApprovalWithCutover, isApprovalEngineCutoverEnabled,
  listApprovalsWithCutover, requestApprovalRevisionFencedWithCutover,
  resubmitApprovalFencedWithCutover, resolveApprovalFencedWithCutover,
  type ApprovalCutoverCallOpts, type ApprovalCutoverResult,
} from "../services/paperwork-engine-approval-cutover.js";
import type {
  ApprovalCreateParams, ApprovalResolveParams, ApprovalRevisionParams,
  ApprovalScopedParams,
} from "../services/paperwork-engine-approval.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_ENGINE_APPROVAL_CUTOVER: "1" };
const TS = "2026-01-01T00:00:00Z";
const APPROVAL_ROW = {
  id: NIL, company_id: NIL, approval_type: "deploy",
  requested_by_agent_id: null, requested_by_user_id: null, requested_by_plugin_id: null,
  status: "pending", payload: { pr: 7 }, decision_note: null, decided_by_user_id: null,
  decided_at: null, created_at: TS, updated_at: TS,
};
const CREATE_PARAMS: ApprovalCreateParams = {
  company_id: NIL, approval_type: "deploy", payload: { pr: 7 },
};
const RESOLVE_PARAMS: ApprovalResolveParams = {
  approval_id: NIL, company_id: NIL, target_status: "approved", decided_by_user_id: "u-1",
};
const REVISION_PARAMS: ApprovalRevisionParams = {
  approval_id: NIL, company_id: NIL, decided_by_user_id: "u-1",
};
const SCOPED_PARAMS: ApprovalScopedParams = { approval_id: NIL, company_id: NIL };

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: ApprovalCutoverCallOpts) => Promise<ApprovalCutoverResult<unknown>>;
// [op name, bound call, wire result, wire params, RPC method]
const WRITES: readonly [string, CutFn, Record<string, unknown>, Record<string, unknown>, string][] = [
  ["create", (c, ts, o) => createApprovalWithCutover(c, CREATE_PARAMS, ts, o),
    { created: true, approval: APPROVAL_ROW },
    { company_id: NIL, approval_type: "deploy", payload: { pr: 7 } }, "approval.create"],
  ["resolve_fenced", (c, ts, o) => resolveApprovalFencedWithCutover(c, RESOLVE_PARAMS, ts, o),
    { outcome: "applied", approval: APPROVAL_ROW },
    { approval_id: NIL, company_id: NIL, target_status: "approved", decided_by_user_id: "u-1" },
    "approval.resolve_fenced"],
  ["request_revision_fenced",
    (c, ts, o) => requestApprovalRevisionFencedWithCutover(c, REVISION_PARAMS, ts, o),
    { updated: true, approval: APPROVAL_ROW },
    { approval_id: NIL, company_id: NIL, decided_by_user_id: "u-1" },
    "approval.request_revision_fenced"],
  ["resubmit_fenced", (c, ts, o) => resubmitApprovalFencedWithCutover(c, SCOPED_PARAMS, ts, o),
    { updated: true, approval: APPROVAL_ROW },
    { approval_id: NIL, company_id: NIL }, "approval.resubmit_fenced"],
  ["cancel_fenced", (c, ts, o) => cancelApprovalFencedWithCutover(c, SCOPED_PARAMS, ts, o),
    { updated: true, approval: APPROVAL_ROW },
    { approval_id: NIL, company_id: NIL }, "approval.cancel_fenced"],
];
// [op name, bound call, wire result, resolved value, RPC method]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string][] = [
  ["get", (c, ts, o) => getApprovalWithCutover(c, SCOPED_PARAMS, ts, o),
    { approval: APPROVAL_ROW }, APPROVAL_ROW, "approval.get"],
  ["list", (c, ts, o) => listApprovalsWithCutover(c, { company_id: NIL, limit: 5 }, ts, o),
    { approvals: [APPROVAL_ROW] }, [APPROVAL_ROW], "approval.list"],
];
const NEGATIVE_WRITES: readonly [string, CutFn, Record<string, unknown>][] = [
  ["create", (c, ts, o) => createApprovalWithCutover(c, CREATE_PARAMS, ts, o), { created: false }],
  ["resolve_fenced", (c, ts, o) => resolveApprovalFencedWithCutover(c, RESOLVE_PARAMS, ts, o),
    { outcome: "not_found_or_conflict" }],
  ["cancel_fenced", (c, ts, o) => cancelApprovalFencedWithCutover(c, SCOPED_PARAMS, ts, o),
    { updated: false }],
];
const BAD_WRITES: readonly [string, CutFn][] = [
  ["create non-uuid company_id",
    (c, ts, o) => createApprovalWithCutover(c, { ...CREATE_PARAMS, company_id: "nope" }, ts, o)],
  ["create empty approval_type",
    (c, ts, o) => createApprovalWithCutover(c, { ...CREATE_PARAMS, approval_type: "" }, ts, o)],
  ["create missing payload",
    (c, ts, o) => createApprovalWithCutover(c, { ...CREATE_PARAMS, payload: undefined }, ts, o)],
  ["create non-uuid requested_by_agent_id",
    (c, ts, o) => createApprovalWithCutover(c, { ...CREATE_PARAMS, requested_by_agent_id: "nope" }, ts, o)],
  ["resolve non-target status",
    (c, ts, o) => resolveApprovalFencedWithCutover(c,
      { ...RESOLVE_PARAMS, target_status: "pending" as never }, ts, o)],
  ["resolve blank decided_by_user_id",
    (c, ts, o) => resolveApprovalFencedWithCutover(c, { ...RESOLVE_PARAMS, decided_by_user_id: "  " }, ts, o)],
  ["revision blank decided_by_user_id",
    (c, ts, o) => requestApprovalRevisionFencedWithCutover(c,
      { ...REVISION_PARAMS, decided_by_user_id: "" }, ts, o)],
  ["resubmit non-uuid approval_id",
    (c, ts, o) => resubmitApprovalFencedWithCutover(c, { approval_id: "nope", company_id: NIL }, ts, o)],
  ["cancel non-uuid company_id",
    (c, ts, o) => cancelApprovalFencedWithCutover(c, { approval_id: NIL, company_id: "nope" }, ts, o)],
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

describe("isApprovalEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isApprovalEngineCutoverEnabled({ PAPERWORK_ENGINE_APPROVAL_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isApprovalEngineCutoverEnabled({ PAPERWORK_ENGINE_APPROVAL_CUTOVER: v })).toBe(false);
    }
    expect(isApprovalEngineCutoverEnabled({})).toBe(false);
  });
});

describe("approval write cutover", () => {
  it.each(WRITES)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op) => {
    const { client, calls } = stub(() => ({}));
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
  it.each(NEGATIVE_WRITES)("%s negative result is a rust result, never a fallback",
    async (_n, op, wire) => {
      const { client } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: wire });
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
        name: "ApprovalCutoverIndeterminateError",
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
    const err = await cancelApprovalFencedWithCutover(client, SCOPED_PARAMS, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "cancel_fenced", cause: error });
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32003); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(createApprovalWithCutover(client, CREATE_PARAMS, ts, { env: ON }))
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
  it.each(BAD_WRITES)("ineligible %s uses TS directly with no RPC", async (_l, op) => {
    const { client, calls } = stub(() => ({ updated: true, approval: APPROVAL_ROW }));
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
});

describe("approval read cutover", () => {
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
    await expect(listApprovalsWithCutover(client, { company_id: NIL, limit: 5 }, ts, { env: ON }))
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
    const { client, calls } = stub(() => ({ approvals: [] }));
    const ts = vi.fn(async () => [] as never);
    await expect(getApprovalWithCutover(client, { approval_id: "nope", company_id: NIL }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    await expect(listApprovalsWithCutover(client, { company_id: NIL, limit: 1.5 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    await expect(listApprovalsWithCutover(client,
      { company_id: NIL, status: "bogus" as never, limit: 5 }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [] });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import * as decisionClient from "../services/paperwork-engine-decision.js";
import {
  cancelDecisionWithCutover, createDecisionWithCutover, DecisionCutoverIndeterminateError,
  getDecisionByIdWithCutover, getDecisionByRequestKeyWithCutover, isDecisionEngineCutoverEnabled,
  listDecisionsWithCutover, resolveDecisionWithCutover,
  type DecisionCutoverCallOpts, type DecisionCutoverOperation, type DecisionCutoverResult,
} from "../services/decision-cutover.js";
import type {
  DecisionCancelResult, DecisionCreateResult, DecisionGetResult, DecisionResolveResult, DecisionRow,
} from "../services/paperwork-engine-decision.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-decision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/paperwork-engine-decision.js")>();
  return {
    ...actual,
    listDecisions: vi.fn(), getDecisionById: vi.fn(), getDecisionByRequestKey: vi.fn(),
    createDecision: vi.fn(), resolveDecision: vi.fn(), cancelDecision: vi.fn(),
  };
});

type AnyMock = ReturnType<typeof vi.fn>;
const listMock = decisionClient.listDecisions as unknown as AnyMock;
const getIdMock = decisionClient.getDecisionById as unknown as AnyMock;
const getKeyMock = decisionClient.getDecisionByRequestKey as unknown as AnyMock;
const createMock = decisionClient.createDecision as unknown as AnyMock;
const resolveMock = decisionClient.resolveDecision as unknown as AnyMock;
const cancelMock = decisionClient.cancelDecision as unknown as AnyMock;
const writeMocks = [createMock, resolveMock, cancelMock];
const readMocks = [listMock, getIdMock, getKeyMock];
const warnMock = logger.warn as unknown as AnyMock;

const NIL = "00000000-0000-0000-0000-000000000000";
const T0 = "2026-01-01T00:00:00Z";
const ON = { PAPERWORK_RUST_DECISION_CUTOVER: "1" };
const client = { call: vi.fn() } as unknown as PaperworkEngineClient;
const ROW: DecisionRow = {
  id: NIL, company_id: NIL, quality_action_id: null, quality_binding: null,
  request_key: "rk", request_hash: "rh", schema_version: 1, status: "pending",
  priority: "high", interaction_type: "single_select", title: "t", description: "d",
  source_type: "agent", source_id: NIL, source_context: {}, issue_id: null,
  requested_by_agent_id: null, requested_by_user_id: null, definition: {}, result: null,
  resolved_by_user_id: null, resolved_at: null, cancelled_at: null,
  continuation_mode: "none", created_at: T0, updated_at: T0,
};
const CREATE_PARAMS = {
  company_id: NIL, request_key: "rk", request_hash: "rh", priority: "high" as const,
  interaction_type: "single_select" as const, title: "t", description: "d",
  source_type: "agent", source_id: NIL, source_context: {}, definition: {}, continuation_mode: "none" as const,
};
const RESOLVE_PARAMS = { decision_id: NIL, company_id: NIL, result: { ok: true }, resolved_by_user_id: "u" };
const CANCEL_PARAMS = { decision_id: NIL, company_id: NIL };
const GET_RESULT: DecisionGetResult = { decision: ROW };
const CREATE_TRUE: DecisionCreateResult = { created: true, decision: ROW };
const RESOLVE_TRUE: DecisionResolveResult = { resolved: true, decision: ROW };
const CANCEL_TRUE: DecisionCancelResult = { cancelled: true, decision: ROW };

type Invoke = (c: PaperworkEngineClient | null, f: () => Promise<unknown>,
  o?: DecisionCutoverCallOpts) => Promise<DecisionCutoverResult<unknown>>;
type WriteCase = { op: DecisionCutoverOperation; positive: unknown; negatives: unknown[]; invoke: Invoke; mock: AnyMock };
const WRITES: WriteCase[] = [
  { op: "create", positive: CREATE_TRUE, negatives: [
      { created: false, conflict: "request_key" },
      { created: false, replayed: true, decision: ROW },
    ], invoke: (c, f, o) => createDecisionWithCutover(c, CREATE_PARAMS,
      f as () => Promise<DecisionCreateResult>, o), mock: createMock },
  { op: "resolve", positive: RESOLVE_TRUE, negatives: [{ resolved: false, decision: ROW }],
    invoke: (c, f, o) => resolveDecisionWithCutover(c, RESOLVE_PARAMS,
      f as () => Promise<DecisionResolveResult>, o), mock: resolveMock },
  { op: "cancel", positive: CANCEL_TRUE, negatives: [{ cancelled: false, decision: null }],
    invoke: (c, f, o) => cancelDecisionWithCutover(c, CANCEL_PARAMS,
      f as () => Promise<DecisionCancelResult>, o), mock: cancelMock },
];
const READS: { op: string; positive: unknown; invoke: Invoke; mock: AnyMock }[] = [
  { op: "list", positive: [ROW], invoke: (c, f, o) => listDecisionsWithCutover(c,
      { company_id: NIL }, f as () => Promise<DecisionRow[]>, o), mock: listMock },
  { op: "get_by_id", positive: GET_RESULT, invoke: (c, f, o) => getDecisionByIdWithCutover(c,
      CANCEL_PARAMS, f as () => Promise<DecisionGetResult>, o), mock: getIdMock },
  { op: "get_by_request_key", positive: GET_RESULT, invoke: (c, f, o) => getDecisionByRequestKeyWithCutover(c,
      { company_id: NIL, request_key: "rk" }, f as () => Promise<DecisionGetResult>, o), mock: getKeyMock },
];
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `e${code}`, code);

beforeEach(() => vi.resetAllMocks());

describe("isDecisionEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isDecisionEngineCutoverEnabled(ON)).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isDecisionEngineCutoverEnabled({ PAPERWORK_RUST_DECISION_CUTOVER: v })).toBe(false);
    }
    expect(isDecisionEngineCutoverEnabled({})).toBe(false);
  });
});

describe("decision write cutover", () => {
  it.each(WRITES)("$op: flag OFF and null client bypass with zero typed-client calls", async (op) => {
    const tsFallback = vi.fn(async () => op.positive);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    for (const mock of [...writeMocks, ...readMocks]) expect(mock).not.toHaveBeenCalled();
  });
  it.each(WRITES)("$op: rust success passes through with the 17s write timeout", async (op) => {
    op.mock.mockResolvedValue(op.positive);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.positive });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(op.mock).toHaveBeenCalledTimes(1);
    expect(op.mock.mock.calls[0][2]).toEqual({ timeoutMs: 17_000 });
  });
  it.each(WRITES)("$op: negative-normal results pass through as rust without fallback", async (op) => {
    const tsFallback = vi.fn();
    for (const negative of op.negatives) {
      op.mock.mockResolvedValueOnce(negative);
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "rust", value: negative });
    }
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each(WRITES)("$op: not_committed rpc errors warn and fall back to TS", async (op) => {
    for (const code of [-32001, -32003]) op.mock.mockRejectedValueOnce(rpc(code));
    const tsFallback = vi.fn(async () => op.positive);
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ operation: op.op }),
      expect.stringContaining("decision write not committed"));
  });
  it.each(WRITES)("$op: indeterminate rpc -32005 throws and NEVER calls tsFallback", async (op) => {
    op.mock.mockRejectedValue(rpc(-32005));
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "DecisionCutoverIndeterminateError", operation: op.op,
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it.each([
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["unclassified RangeError", new RangeError("not sent")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never falls back", async (_label, error) => {
    createMock.mockRejectedValue(error);
    const tsFallback = vi.fn();
    await expect(createDecisionWithCutover(client, CREATE_PARAMS, tsFallback, { env: ON }))
      .rejects.toBeInstanceOf(DecisionCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
  });
  it("surfaces operation, classification, and cause on the thrown error", async () => {
    const error = rpc(-32005);
    cancelMock.mockRejectedValue(error);
    const err = await cancelDecisionWithCutover(client, CANCEL_PARAMS, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "cancel", cause: error });
  });
  it.each([[0, 17_000], [10_000, 17_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 17_000], [Infinity, 17_000], [12.7, 17_000]])(
    "writes clamp timeoutMs %s to %s", async (ms, want) => {
      createMock.mockResolvedValue(CREATE_TRUE);
      await createDecisionWithCutover(client, CREATE_PARAMS, vi.fn(), { env: ON, timeoutMs: ms });
      expect(createMock.mock.calls[0][2]).toEqual({ timeoutMs: want });
    });
  it("tsFallback rejection propagates unchanged", async () => {
    const boom = new Error("ts failed");
    const tsFallback = vi.fn(async () => { throw boom; });
    await expect(createDecisionWithCutover(client, CREATE_PARAMS, tsFallback, { env: {} }))
      .rejects.toBe(boom);
  });
  it("a throwing logger.warn does not mask the not_committed TS fallback", async () => {
    warnMock.mockImplementation(() => { throw new Error("pino boom"); });
    createMock.mockRejectedValue(rpc(-32003));
    const tsFallback = vi.fn(async () => CREATE_TRUE);
    await expect(createDecisionWithCutover(client, CREATE_PARAMS, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: CREATE_TRUE });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});

describe("decision read cutover", () => {
  it.each(READS)("$op: flag OFF and null client bypass with zero typed-client calls", async (op) => {
    const tsFallback = vi.fn(async () => op.positive);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.positive });
    expect(tsFallback).toHaveBeenCalledTimes(2);
    for (const mock of readMocks) expect(mock).not.toHaveBeenCalled();
  });
  it.each(READS)("$op: rust success passes through with the 10s read timeout", async (op) => {
    op.mock.mockResolvedValue(op.positive);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.positive });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(op.mock.mock.calls[0][2]).toEqual({ timeoutMs: 10_000 });
  });
  it.each(READS)("$op: any engine error warns and falls back to TS", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t"), new Error("x")]) {
      op.mock.mockRejectedValueOnce(error);
    }
    const tsFallback = vi.fn(async () => op.positive);
    for (let i = 0; i < 3; i++) {
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.positive });
    }
    expect(tsFallback).toHaveBeenCalledTimes(3);
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ operation: op.op }),
      expect.stringContaining("decision read failed"));
  });
  it.each([[0, 1], [10_000, 10_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 10_000], [Infinity, 10_000], [12.7, 12]])(
    "reads clamp timeoutMs %s to %s", async (ms, want) => {
      listMock.mockResolvedValue([ROW]);
      await listDecisionsWithCutover(client, { company_id: NIL }, vi.fn(), { env: ON, timeoutMs: ms });
      expect(listMock.mock.calls[0][2]).toEqual({ timeoutMs: want });
    });
});

describe("classification passthrough", () => {
  it("uses the real decision RPC classification table", () => {
    expect(decisionClient.classifyDecisionRpcError(rpc(-32001)))
      .toMatchObject({ outcome: "not_committed", retryable: true });
    expect(decisionClient.classifyDecisionRpcError(rpc(-32003)))
      .toMatchObject({ outcome: "not_committed", kind: "busy" });
    expect(decisionClient.classifyDecisionRpcError(rpc(-32005)))
      .toMatchObject({ outcome: "indeterminate", retryable: false });
    expect(decisionClient.classifyDecisionRpcError(new PaperworkEngineError("protocol_error", "p")))
      .toMatchObject({ outcome: "indeterminate", kind: "unknown" });
    expect(decisionClient.classifyDecisionRpcError(new RangeError("not sent")))
      .toMatchObject({ outcome: "indeterminate", kind: "unknown" });
  });
});

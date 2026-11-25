import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { classifyWikiRpcError, type WikiEntryRow } from "../services/paperwork-engine-wiki.js";
import {
  WikiCutoverIndeterminateError, closeEntryWithCutover, isWikiEngineCutoverEnabled,
  listWikiEntriesWithCutover, markResolvedWithCutover, recordFailureWithCutover,
  searchRelevantWithCutover,
} from "../services/wiki-cutover.js";

const mocks = vi.hoisted(() => ({
  recordFailure: vi.fn(), markResolved: vi.fn(), closeEntry: vi.fn(),
  searchRelevant: vi.fn(), listEntries: vi.fn(), warn: vi.fn(),
}));

vi.mock("../services/paperwork-engine-wiki.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/paperwork-engine-wiki.js")>();
  return {
    ...actual,
    recordWikiFailure: mocks.recordFailure,
    markWikiEntryResolved: mocks.markResolved,
    closeWikiEntry: mocks.closeEntry,
    searchRelevantWiki: mocks.searchRelevant,
    listWikiEntries: mocks.listEntries,
  };
});
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z";
const ON = { PAPERWORK_RUST_WIKI_CUTOVER: "1" };
const ENTRY: WikiEntryRow = {
  id: NIL, company_id: NIL, agent_id: U1, mission_id: null,
  pattern: "pattern", cause: "cause", solution: "solution", error_code: "E",
  step_id: "step-1", frequency: 2, status: "active", audience: "agent",
  last_seen_at: T0, resolved_at: null, created_at: T0, updated_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: U1, mission_id: null, pattern: "pattern", cause: "cause",
  solution: "solution", error_code: "E", step_id: "step-1", audience: "agent" as const,
};
const IDPARAMS = { entry_id: NIL, company_id: NIL };
const SEARCH = { company_id: NIL, agent_id: U1, now: T0, step_id: "step-1", limit: 3 };
const LIST = { company_id: NIL, limit: 5 };
const client = {} as PaperworkEngineClient;
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `rpc ${code}`, code);
const callOptsOf = (mock: typeof mocks.recordFailure) =>
  mock.mock.calls[0]?.[2] as { timeoutMs: number };

type WriteCase = {
  op: "record_failure" | "mark_resolved" | "close";
  params: unknown; success: unknown; falseResult: unknown;
  invoke: (client: PaperworkEngineClient | null, fallback: () => Promise<unknown>, opts?: object) => Promise<unknown>;
  mock: typeof mocks.recordFailure;
};
const WRITES: WriteCase[] = [
  {
    op: "record_failure", params: RECORD as never,
    success: { recorded: true, entry: ENTRY } as never, falseResult: { recorded: false } as never,
    invoke: (c, fallback, opts) => recordFailureWithCutover(c, RECORD, fallback as never, opts as never),
    mock: mocks.recordFailure,
  },
  {
    op: "mark_resolved", params: IDPARAMS as never,
    success: { resolved: true, entry: ENTRY } as never, falseResult: { resolved: false } as never,
    invoke: (c, fallback, opts) => markResolvedWithCutover(c, IDPARAMS, fallback as never, opts as never),
    mock: mocks.markResolved,
  },
  {
    op: "close", params: IDPARAMS as never,
    success: { closed: true, entry: ENTRY } as never, falseResult: { closed: false } as never,
    invoke: (c, fallback, opts) => closeEntryWithCutover(c, IDPARAMS, fallback as never, opts as never),
    mock: mocks.closeEntry,
  },
];
const READS = [
  {
    op: "search_relevant", params: SEARCH, result: { entries: [ENTRY] },
    invoke: (c: PaperworkEngineClient | null, fallback: () => Promise<unknown>, opts?: object) =>
      searchRelevantWithCutover(c, SEARCH, fallback as never, opts as never),
    mock: mocks.searchRelevant,
  },
  {
    op: "list", params: LIST, result: { entries: [ENTRY] },
    invoke: (c: PaperworkEngineClient | null, fallback: () => Promise<unknown>, opts?: object) =>
      listWikiEntriesWithCutover(c, LIST, fallback as never, opts as never),
    mock: mocks.listEntries,
  },
];

beforeEach(() => vi.resetAllMocks());

describe("isWikiEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isWikiEngineCutoverEnabled(ON)).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isWikiEngineCutoverEnabled({ PAPERWORK_RUST_WIKI_CUTOVER: v })).toBe(false);
    }
    expect(isWikiEngineCutoverEnabled({})).toBe(false);
  });
});

describe("wiki write cutover", () => {
  it.each(WRITES)("$op: flag OFF and null client use TS without the typed client", async (op) => {
    const fallback = vi.fn(async () => op.falseResult);
    await expect(op.invoke(client, fallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.falseResult });
    await expect(op.invoke(null, fallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.falseResult });
    expect(op.mock).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it.each(WRITES)("$op: rust success passes through with source rust and write timeout", async (op) => {
    op.mock.mockResolvedValueOnce(op.success);
    const fallback = vi.fn();
    await expect(op.invoke(client, fallback as never, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.success });
    expect(fallback).not.toHaveBeenCalled();
    expect(op.mock).toHaveBeenCalledWith(client, op.params, { timeoutMs: 17_000 });
  });

  it.each(WRITES)("$op: false negative results are normal rust results, never fallback", async (op) => {
    op.mock.mockResolvedValueOnce(op.falseResult);
    const fallback = vi.fn();
    await expect(op.invoke(client, fallback as never, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.falseResult });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(WRITES)("$op: not_committed classifications warn once and fall back to TS", async (op) => {
    for (const code of [-32001, -32003]) {
      const error = rpc(code);
      expect(classifyWikiRpcError(error).outcome).toBe("not_committed");
      op.mock.mockReset(); mocks.warn.mockClear();
      op.mock.mockRejectedValueOnce(error);
      const fallback = vi.fn(async () => op.falseResult);
      await expect(op.invoke(client, fallback as never, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.falseResult });
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: op.op, kind: classifyWikiRpcError(error).kind, err: error }),
        "paperwork-engine wiki write not committed; falling back to TS writer",
      );
    }
  });

  it.each(WRITES)("$op: indeterminate classifications throw and NEVER fall back", async (op) => {
    for (const error of [
      rpc(-32005), new PaperworkEngineError("protocol_error", "bad shape"), new RangeError("pre-send invalid"),
    ]) {
      const expected = classifyWikiRpcError(error);
      expect(expected.outcome).toBe("indeterminate");
      op.mock.mockReset();
      op.mock.mockRejectedValueOnce(error);
      const fallback = vi.fn();
      await expect(op.invoke(client, fallback as never, { env: ON }))
        .rejects.toMatchObject({
          name: "WikiCutoverIndeterminateError", operation: op.op,
          classification: expected, cause: error,
        });
      expect(fallback).not.toHaveBeenCalled();
    }
  });

  it("preserves operation/classification/cause on the typed error instance", async () => {
    const error = rpc(-32005);
    mocks.closeEntry.mockRejectedValueOnce(error);
    const thrown = await closeEntryWithCutover(client, IDPARAMS, vi.fn() as never, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(WikiCutoverIndeterminateError);
    expect(thrown).toMatchObject({ operation: "close", classification: classifyWikiRpcError(error), cause: error });
  });

  it("tsFallback rejection propagates unchanged", async () => {
    const fallbackError = new Error("ts failed");
    mocks.recordFailure.mockRejectedValueOnce(rpc(-32001));
    const fallback = vi.fn(async () => { throw fallbackError; });
    await expect(recordFailureWithCutover(client, RECORD, fallback as never, { env: ON }))
      .rejects.toBe(fallbackError);
  });

  it.each([[0, 17_000], [10_000, 17_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 17_000], [Number.POSITIVE_INFINITY, 17_000], [12.7, 17_000]])(
    "writes clamp timeoutMs %s to %s", async (timeoutMs, want) => {
      mocks.recordFailure.mockResolvedValueOnce({ recorded: false });
      await recordFailureWithCutover(client, RECORD, vi.fn() as never, { env: ON, timeoutMs });
      expect(callOptsOf(mocks.recordFailure).timeoutMs).toBe(want);
    });
});

describe("wiki read cutover", () => {
  it.each(READS)("$op: flag OFF and null client use TS without the typed client", async (op) => {
    const fallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, fallback, { env: {} })).resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, fallback, { env: ON })).resolves.toEqual({ source: "ts", value: op.result });
    expect(op.mock).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it.each(READS)("$op: rust rows pass through with the 10s read timeout", async (op) => {
    op.mock.mockResolvedValueOnce(op.result);
    const fallback = vi.fn();
    await expect(op.invoke(client, fallback, { env: ON })).resolves.toEqual({ source: "rust", value: op.result });
    expect(fallback).not.toHaveBeenCalled();
    expect(op.mock).toHaveBeenCalledWith(client, op.params, { timeoutMs: 10_000 });
  });

  it.each(READS)("$op: any typed-client error warns and falls back to TS", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t"), new RangeError("invalid")]) {
      op.mock.mockReset(); mocks.warn.mockClear();
      op.mock.mockRejectedValueOnce(error);
      const fallback = vi.fn(async () => op.result);
      await expect(op.invoke(client, fallback, { env: ON })).resolves.toEqual({ source: "ts", value: op.result });
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: op.op, err: error }),
        "paperwork-engine wiki read failed; falling back to TS reader",
      );
    }
  });

  it("read tsFallback rejection propagates unchanged", async () => {
    const fallbackError = new Error("reader failed");
    mocks.searchRelevant.mockRejectedValueOnce(rpc(-32005));
    await expect(searchRelevantWithCutover(client, SEARCH, vi.fn(async () => { throw fallbackError; }) as never, { env: ON }))
      .rejects.toBe(fallbackError);
  });

  it.each([[0, 1], [10_000, 10_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000], [12.7, 12]])(
    "reads clamp timeoutMs %s to %s", async (timeoutMs, want) => {
      mocks.listEntries.mockResolvedValueOnce({ entries: [] });
      await listWikiEntriesWithCutover(client, LIST, vi.fn() as never, { env: ON, timeoutMs });
      expect(callOptsOf(mocks.listEntries).timeoutMs).toBe(want);
    });
});

describe("classification and injection-gate preservation", () => {
  it("uses the real classifyWikiRpcError table without adapter reclassification", () => {
    for (const code of [-32001, -32002, -32003, -32004, -32602]) {
      expect(classifyWikiRpcError(rpc(code))).toMatchObject({ outcome: "not_committed" });
    }
    for (const error of [rpc(-32005), rpc(-39999), new PaperworkEngineError("closed", "c"), new RangeError("x")]) {
      expect(classifyWikiRpcError(error)).toMatchObject({ outcome: "indeterminate", retryable: false });
    }
  });

  it("passes write params deep-equal and UNMUTATED, including audience", async () => {
    const params = { ...RECORD };
    const before = { ...params };
    mocks.recordFailure.mockResolvedValueOnce({ recorded: false });
    await recordFailureWithCutover(client, params, vi.fn() as never, { env: ON });
    expect(mocks.recordFailure.mock.calls[0]?.[1]).toEqual(before);
    expect(mocks.recordFailure.mock.calls[0]?.[1]).toEqual(params);
    expect(params).toEqual(before);
    expect(mocks.recordFailure.mock.calls[0]?.[1]).toMatchObject({ audience: "agent", step_id: "step-1" });
  });

  it("passes read params deep-equal and UNMUTATED, including now/step_id/limit", async () => {
    const params = { ...SEARCH };
    const before = { ...params };
    mocks.searchRelevant.mockResolvedValueOnce({ entries: [] });
    await searchRelevantWithCutover(client, params, vi.fn() as never, { env: ON });
    expect(mocks.searchRelevant.mock.calls[0]?.[1]).toEqual(before);
    expect(mocks.searchRelevant.mock.calls[0]?.[1]).toEqual(params);
    expect(params).toEqual(before);
    expect(mocks.searchRelevant.mock.calls[0]?.[1]).toMatchObject({ now: T0, step_id: "step-1", limit: 3 });
  });
});

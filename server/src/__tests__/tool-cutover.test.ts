import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyToolRpcError, type ToolClaimExecutionReceiptIdempotentParams,
} from "../services/paperwork-engine-tool.js";
import {
  ToolCutoverIndeterminateError, claimToolExecutionReceiptIdempotentWithCutover,
  getToolDefinitionWithCutover, isToolEngineCutoverEnabled,
  listCompanySkillsWithCutover, listToolDefinitionsWithCutover,
  listToolExecutionReceiptsWithCutover,
  type ToolCutoverCallOpts, type ToolCutoverResult,
} from "../services/tool-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_TOOL_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const DEF = {
  id: NIL, company_id: U1, name: "web_search", description: "d",
  input_schema: { type: "object" }, adapter_type: "http", adapter_config: { url: "u" },
  enabled: true, created_at: T0, updated_at: T1,
};
const SKILL = {
  id: NIL, company_id: U1, key: "k", slug: "s", name: "n", description: null,
  markdown: "# m", source_type: "local_path", source_locator: null, source_ref: null,
  trust_level: "markdown_only", compatibility: "compatible", file_inventory: [],
  metadata: null, created_at: T0, updated_at: T1,
};
const RECEIPT = {
  id: NIL, company_id: U1, run_id: "r1", tool: "ns.tool", idempotency_key: "k1",
  status: "executing", request_parameters: { x: 1 }, result_status: null, result_body: null,
  claimed_at: T0, completed_at: null, workflow_run_id: null, step_id: null,
};
const DEFS = { company_id: U1, limit: 10 } as const;
const GETD = { company_id: U1, tool_id: NIL } as const;
const SKILLS = { company_id: U1, limit: 25 } as const;
const RCPTS = { company_id: U1, limit: 50 } as const;
const CLAIM: ToolClaimExecutionReceiptIdempotentParams = {
  company_id: U1, run_id: "r1", tool: "ns.tool", idempotency_key: "k1", parameters: { x: 1 },
};
const CLAIMED = { outcome: "claimed", receipt: RECEIPT } as const;

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: ToolCutoverCallOpts) => Promise<ToolCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["claim_execution_receipt_idempotent",
    (c, ts, o) => claimToolExecutionReceiptIdempotentWithCutover(c, CLAIM, ts, o),
    CLAIMED, CLAIMED, "tool.claim_execution_receipt_idempotent", CLAIM],
];
// [op, bound call, wire result, resolved value, RPC method, wire params]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["list_definitions", (c, ts, o) => listToolDefinitionsWithCutover(c, DEFS, ts, o),
    { definitions: [DEF] }, { definitions: [DEF] }, "tool.list_definitions", DEFS],
  ["get_definition", (c, ts, o) => getToolDefinitionWithCutover(c, GETD, ts, o),
    { definition: DEF }, { definition: DEF }, "tool.get_definition", GETD],
  ["list_skills", (c, ts, o) => listCompanySkillsWithCutover(c, SKILLS, ts, o),
    { skills: [SKILL] }, { skills: [SKILL] }, "tool.list_skills", SKILLS],
  ["list_execution_receipts", (c, ts, o) => listToolExecutionReceiptsWithCutover(c, RCPTS, ts, o),
    { receipts: [RECEIPT] }, { receipts: [RECEIPT] }, "tool.list_execution_receipts", RCPTS],
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

describe("isToolEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isToolEngineCutoverEnabled({ PAPERWORK_RUST_TOOL_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isToolEngineCutoverEnabled({ PAPERWORK_RUST_TOOL_CUTOVER: v })).toBe(false);
    }
    expect(isToolEngineCutoverEnabled({})).toBe(false);
  });
  it("opts.env overrides process.env in both directions", async () => {
    const saved = process.env.PAPERWORK_RUST_TOOL_CUTOVER;
    try {
      delete process.env.PAPERWORK_RUST_TOOL_CUTOVER;
      const a = stub(() => CLAIMED);
      const tsA = vi.fn(async () => "ts-result" as never);
      await expect(claimToolExecutionReceiptIdempotentWithCutover(a.client, CLAIM, tsA, { env: ON }))
        .resolves.toEqual({ source: "rust", value: CLAIMED });
      expect(a.calls).toHaveLength(1);
      expect(tsA).not.toHaveBeenCalled();
      process.env.PAPERWORK_RUST_TOOL_CUTOVER = "1";
      const b = stub(() => CLAIMED);
      const tsB = vi.fn(async () => "ts-result" as never);
      await expect(claimToolExecutionReceiptIdempotentWithCutover(b.client, CLAIM, tsB, { env: {} }))
        .resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(b.calls).toHaveLength(0);
      expect(tsB).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.PAPERWORK_RUST_TOOL_CUTOVER;
      else process.env.PAPERWORK_RUST_TOOL_CUTOVER = saved;
    }
  });
});

describe("tool write cutover", () => {
  it.each(WRITES)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => "ts-result" as never);
      for (const env of [{}, { PAPERWORK_RUST_TOOL_CUTOVER: "0" },
        { PAPERWORK_RUST_TOOL_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: "ts-result" });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(WRITES)("%s returns source rust with snake_case params and a write timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 17_000 } }]);
    });
  it.each(WRITES)("every %s outcome arm (claimed/replay/in_progress) is a rust result, never a fallback",
    async (_n, op) => {
      for (const outcome of ["claimed", "replay", "in_progress"]) {
        const { client } = stub(() => ({ outcome, receipt: RECEIPT }));
        const ts = vi.fn();
        await expect(op(client, ts, { env: ON }))
          .resolves.toEqual({ source: "rust", value: { outcome, receipt: RECEIPT } });
        expect(ts).not.toHaveBeenCalled();
      }
    });
  it.each([-32001, -32002, -32004, -32602])(
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
    ["unknown rpc -32601", rpc(-32601)],
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["untyped error", new Error("x")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_l, error) => {
    for (const [name, op] of WRITES) {
      const { client } = stub(() => { throw error; });
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).rejects.toMatchObject({
        name: "ToolCutoverIndeterminateError",
        operation: name,
        classification: classifyToolRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => CLAIMED);
    const ts = vi.fn();
    await expect(claimToolExecutionReceiptIdempotentWithCutover(client,
      { ...CLAIM, company_id: "not-a-uuid" }, ts, { env: ON }))
      .rejects.toBeInstanceOf(ToolCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await claimToolExecutionReceiptIdempotentWithCutover(client, CLAIM, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(ToolCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "claim_execution_receipt_idempotent", cause: error });
    expect(err.classification).toEqual(classifyToolRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32004); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(claimToolExecutionReceiptIdempotentWithCutover(client, CLAIM, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32004); });
    const boom = new Error("ts boom");
    await expect(claimToolExecutionReceiptIdempotentWithCutover(client, CLAIM,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[undefined, 17_000], [0, 17_000], [5_000, 17_000], [1_000_000, 600_000],
    [1.5, 17_000], [Number.NaN, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("tool read cutover", () => {
  it.each(READS)("flag OFF(0/arbitrary/unset) or null client bypasses %s with zero RPC calls",
    async (_n, op, _w, want) => {
      const { client, calls } = stub(() => ({}));
      const ts = vi.fn(async () => want as never);
      for (const env of [{}, { PAPERWORK_RUST_TOOL_CUTOVER: "0" },
        { PAPERWORK_RUST_TOOL_CUTOVER: "yes" }]) {
        await expect(op(client, ts, { env })).resolves.toEqual({ source: "ts", value: want });
      }
      await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
      expect(calls).toHaveLength(0);
      expect(ts).toHaveBeenCalledTimes(4);
    });
  it.each(READS)("%s returns engine rows with the 10s read timeout",
    async (_n, op, wire, want, method, wantParams) => {
      const { client, calls } = stub(() => wire);
      const ts = vi.fn();
      await expect(op(client, ts, { env: ON })).resolves.toEqual({ source: "rust", value: want });
      expect(ts).not.toHaveBeenCalled();
      expect(calls).toEqual([{ method, params: wantParams, callOpts: { timeoutMs: 10_000 } }]);
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
    const { client, calls } = stub(() => ({ definition: null }));
    const ts = vi.fn(async () => ({ definition: null }) as never);
    await expect(getToolDefinitionWithCutover(client,
      { ...GETD, tool_id: "nope" }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { definition: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ definition: null }) as never);
    await expect(getToolDefinitionWithCutover(client, GETD, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { definition: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, 10_000], [0, 1], [5_000, 5_000], [9_000_000, 600_000],
    [1.5, 1], [Number.NaN, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

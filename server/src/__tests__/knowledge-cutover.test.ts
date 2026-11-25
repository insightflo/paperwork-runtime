import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import { logger } from "../middleware/logger.js";
import {
  classifyKnowledgeRpcError, type KnowledgeUpdateNodeFencedParams,
} from "../services/paperwork-engine-knowledge.js";
import {
  getKnowledgeNodeWithCutover, isKnowledgeEngineCutoverEnabled,
  KnowledgeCutoverIndeterminateError, listAgentKbGrantsWithCutover,
  listKnowledgeBasesWithCutover, listKnowledgeNodesWithCutover,
  updateKnowledgeNodeFencedWithCutover,
  type KnowledgeCutoverCallOpts, type KnowledgeCutoverResult,
} from "../services/knowledge-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_RUST_KNOWLEDGE_CUTOVER: "1" };
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const KB = {
  id: NIL, company_id: U1, name: "kb", kb_type: "static", description: "d",
  max_token_budget: 4096, config_json: { chunk: 512 }, created_at: T0, updated_at: T1,
};
const NODE = {
  id: NIL, company_id: U1, kb_id: U2, parent_id: null, slug: "s", title: "t",
  summary: "sm", content: "c", node_type: "concept", certified: true, status: "active",
  tags: ["a", "b"], linked_node_ids: ["n1"], source_refs: [{ r: 1 }], created_at: T0, updated_at: T1,
};
const GRANT = { id: NIL, agent_id: U1, kb_id: U2, granted_by: "u1", created_at: T0 };
const BASES = { company_id: U1 };
const GETN = { company_id: U1, kb_id: U2, node_id: NIL };
const NODES = { company_id: U1, kb_id: U2 };
const GRANTS = { company_id: U1, agent_id: U1 };
const UPDATE: KnowledgeUpdateNodeFencedParams = { ...GETN, expected_updated_at: T0, new_title: "t2" };
const APPLIED = { applied: true, node: NODE };

type CutFn = (client: PaperworkEngineClient | null, ts: () => Promise<never>,
  opts?: KnowledgeCutoverCallOpts) => Promise<KnowledgeCutoverResult<unknown>>;
// [op, bound call, wire result, resolved value, RPC method, wire params]
const WRITES: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["update_node_fenced",
    (c, ts, o) => updateKnowledgeNodeFencedWithCutover(c, UPDATE, ts, o),
    APPLIED, APPLIED, "knowledge.update_node_fenced", UPDATE],
];
// [op, bound call, wire result, resolved value, RPC method, wire params]
const READS: readonly [string, CutFn, Record<string, unknown>, unknown, string,
  Record<string, unknown>][] = [
  ["list_bases", (c, ts, o) => listKnowledgeBasesWithCutover(c, BASES, ts, o),
    { kbs: [KB] }, { kbs: [KB] }, "knowledge.list_bases", BASES],
  ["get_node", (c, ts, o) => getKnowledgeNodeWithCutover(c, GETN, ts, o),
    { node: NODE }, { node: NODE }, "knowledge.get_node", GETN],
  ["list_nodes", (c, ts, o) => listKnowledgeNodesWithCutover(c, NODES, ts, o),
    { nodes: [NODE] }, { nodes: [NODE] }, "knowledge.list_nodes", NODES],
  ["list_agent_grants", (c, ts, o) => listAgentKbGrantsWithCutover(c, GRANTS, ts, o),
    { grants: [GRANT] }, { grants: [GRANT] }, "knowledge.list_agent_grants", GRANTS],
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

describe("isKnowledgeEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isKnowledgeEngineCutoverEnabled({ PAPERWORK_RUST_KNOWLEDGE_CUTOVER: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isKnowledgeEngineCutoverEnabled({ PAPERWORK_RUST_KNOWLEDGE_CUTOVER: v })).toBe(false);
    }
    expect(isKnowledgeEngineCutoverEnabled({})).toBe(false);
  });
  it("opts.env overrides process.env in both directions", async () => {
    const saved = process.env.PAPERWORK_RUST_KNOWLEDGE_CUTOVER;
    try {
      delete process.env.PAPERWORK_RUST_KNOWLEDGE_CUTOVER;
      const a = stub(() => APPLIED);
      const tsA = vi.fn(async () => "ts-result" as never);
      await expect(updateKnowledgeNodeFencedWithCutover(a.client, UPDATE, tsA, { env: ON }))
        .resolves.toEqual({ source: "rust", value: APPLIED });
      expect(a.calls).toHaveLength(1);
      expect(tsA).not.toHaveBeenCalled();
      process.env.PAPERWORK_RUST_KNOWLEDGE_CUTOVER = "1";
      const b = stub(() => APPLIED);
      const tsB = vi.fn(async () => "ts-result" as never);
      await expect(updateKnowledgeNodeFencedWithCutover(b.client, UPDATE, tsB, { env: {} }))
        .resolves.toEqual({ source: "ts", value: "ts-result" });
      expect(b.calls).toHaveLength(0);
      expect(tsB).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.PAPERWORK_RUST_KNOWLEDGE_CUTOVER;
      else process.env.PAPERWORK_RUST_KNOWLEDGE_CUTOVER = saved;
    }
  });
});

describe("knowledge write cutover", () => {
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
  it.each(WRITES)("%s {applied:false,reason:'fenced'} is a rust result, never a fallback", async (_n, op) => {
    const { client } = stub(() => ({ applied: false, reason: "fenced" }));
    const ts = vi.fn();
    await expect(op(client, ts, { env: ON }))
      .resolves.toEqual({ source: "rust", value: { applied: false, reason: "fenced" } });
    expect(ts).not.toHaveBeenCalled();
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
        name: "KnowledgeCutoverIndeterminateError",
        operation: name,
        classification: classifyKnowledgeRpcError(error),
      });
      expect(ts).not.toHaveBeenCalled();
    }
  });
  it("pre-send RangeError throws indeterminate with no RPC and no tsFallback", async () => {
    const { client, calls } = stub(() => APPLIED);
    const ts = vi.fn();
    await expect(updateKnowledgeNodeFencedWithCutover(client,
      { ...GETN, expected_updated_at: T0 }, ts, { env: ON }))
      .rejects.toBeInstanceOf(KnowledgeCutoverIndeterminateError);
    expect(calls).toHaveLength(0);
    expect(ts).not.toHaveBeenCalled();
  });
  it("exposes operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    const { client } = stub(() => { throw error; });
    const ts = vi.fn();
    const err = await updateKnowledgeNodeFencedWithCutover(client, UPDATE, ts, { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(KnowledgeCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "update_node_fenced", cause: error });
    expect(err.classification).toEqual(classifyKnowledgeRpcError(error));
    expect(ts).not.toHaveBeenCalled();
  });
  it("a throwing logger still allows the not_committed TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32004); });
    const ts = vi.fn(async () => "ts-result" as never);
    await expect(updateKnowledgeNodeFencedWithCutover(client, UPDATE, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: "ts-result" });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a rejecting tsFallback propagates unchanged", async () => {
    const { client } = stub(() => { throw rpc(-32004); });
    const boom = new Error("ts boom");
    await expect(updateKnowledgeNodeFencedWithCutover(client, UPDATE,
      async () => { throw boom; }, { env: ON })).rejects.toBe(boom);
  });
  it.each([[undefined, 17_000], [5_000, 17_000], [9_000_000, 600_000],
    [1.5, 17_000], [Number.NaN, 17_000]])(
    "write RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of WRITES) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

describe("knowledge read cutover", () => {
  it.each(READS)("flag OFF/null client bypasses %s with zero RPC calls", async (_n, op, _w, want) => {
    const { client, calls } = stub(() => ({}));
    const ts = vi.fn(async () => want as never);
    await expect(op(client, ts, { env: {} })).resolves.toEqual({ source: "ts", value: want });
    await expect(op(null, ts, { env: ON })).resolves.toEqual({ source: "ts", value: want });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(2);
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
    const { client, calls } = stub(() => ({ node: null }));
    const ts = vi.fn(async () => ({ node: null }) as never);
    await expect(getKnowledgeNodeWithCutover(client,
      { ...GETN, node_id: "nope" }, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { node: null } });
    expect(calls).toHaveLength(0);
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it("a throwing logger still allows the read TS fallback", async () => {
    vi.mocked(logger.warn).mockImplementation(() => { throw new Error("log boom"); });
    const { client } = stub(() => { throw rpc(-32005); });
    const ts = vi.fn(async () => ({ node: null }) as never);
    await expect(getKnowledgeNodeWithCutover(client, GETN, ts, { env: ON }))
      .resolves.toEqual({ source: "ts", value: { node: null } });
    expect(ts).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, 10_000], [5_000, 5_000], [9_000_000, 600_000],
    [1.5, 1], [Number.NaN, 10_000]])(
    "read RPCs clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      for (const [, op, wire] of READS) {
        const a = stub(() => wire);
        await op(a.client, vi.fn(), { env: ON, timeoutMs: ms });
        expect(timeoutOf(a.calls[0])).toBe(want);
      }
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  AgentKbGrant, KnowledgeBase, KnowledgeNode,
} from "../services/paperwork-engine-knowledge.js";
import { KnowledgeCutoverIndeterminateError } from "../services/knowledge-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import { logger } from "../middleware/logger.js";
import {
  createKnowledgeCutoverHooks,
  getKnowledgeCutoverMetrics,
  resetKnowledgeCutoverMetricsForTests,
  wireKnowledgeGetNodeCutover,
  wireKnowledgeListAgentGrantsCutover,
  wireKnowledgeListBasesCutover,
  wireKnowledgeListNodesCutover,
  wireKnowledgeUpdateNodeFencedCutover,
  KNOWLEDGE_WIRED_OPERATIONS,
  type KnowledgeCutoverTelemetryEvent,
} from "../services/knowledge-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: vi.fn(() => null),
}));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const ON = { PAPERWORK_RUST_KNOWLEDGE_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const KB: KnowledgeBase = {
  id: NIL, company_id: U1, name: "kb", kb_type: "static", description: "d",
  max_token_budget: 4096, config_json: { chunk: 512 }, created_at: T0, updated_at: T1,
};
const NODE: KnowledgeNode = {
  id: NIL, company_id: U1, kb_id: U2, parent_id: null, slug: "s", title: "t",
  summary: "sm", content: "c", node_type: "concept", certified: true, status: "active",
  tags: ["a", "b"], linked_node_ids: ["n1"], source_refs: [{ r: 1 }],
  created_at: T0, updated_at: T1,
};
const GRANT: AgentKbGrant = { id: NIL, agent_id: U1, kb_id: U2, granted_by: "u1", created_at: T0 };
const BASES = { company_id: U1 };
const GETN = { company_id: U1, kb_id: U2, node_id: NIL };
const NODES = { company_id: U1, kb_id: U2 };
const GRANTS = { company_id: U1, agent_id: U1 };
const UPDATE = { ...GETN, expected_updated_at: T0, new_title: "t2" };
const APPLIED = { applied: true as const, node: NODE };
const FENCED = { applied: false as const, reason: "fenced" as const };

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
const hostileError = () => Object.defineProperty(new Error("boom"), "stack", { get() { throw new Error("stack-getter-boom"); } });
const sharedClient = vi.mocked(getSharedPaperworkEngineClient);

beforeEach(() => {
  resetKnowledgeCutoverMetricsForTests();
  sharedClient.mockReset().mockReturnValue(null);
  vi.mocked(logger.warn).mockClear();
});

describe("knowledge-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all five ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_KNOWLEDGE_CUTOVER: "0" }, { PAPERWORK_RUST_KNOWLEDGE_CUTOVER: "true" }]) {
      const o = { env, getClient };
      await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, async () => APPLIED, o)).resolves.toEqual({ source: "ts", value: APPLIED });
      await expect(wireKnowledgeListBasesCutover(BASES, async () => ({ kbs: [KB] }), o)).resolves.toEqual({ source: "ts", value: { kbs: [KB] } });
      await expect(wireKnowledgeGetNodeCutover(GETN, async () => ({ node: NODE }), o)).resolves.toEqual({ source: "ts", value: { node: NODE } });
      await expect(wireKnowledgeListNodesCutover(NODES, async () => ({ nodes: [NODE] }), o)).resolves.toEqual({ source: "ts", value: { nodes: [NODE] } });
      await expect(wireKnowledgeListAgentGrantsCutover(GRANTS, async () => ({ grants: [GRANT] }), o)).resolves.toEqual({ source: "ts", value: { grants: [GRANT] } });
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClient).not.toHaveBeenCalled();
    const m = getKnowledgeCutoverMetrics();
    for (const op of KNOWLEDGE_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
  });

  it("flag ON + null/throwing getClient or null shared client warns and fails safe to tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: APPLIED });
    // default resolver path: mocked shared client returning null also bypasses
    await expect(wireKnowledgeGetNodeCutover(GETN, async () => ({ node: null }), { env: ON }))
      .resolves.toEqual({ source: "ts", value: { node: null } });
    expect(sharedClient).toHaveBeenCalledTimes(1);
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(3);
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
    expect(getKnowledgeCutoverMetrics().get_node)
      .toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("flag ON + Rust success returns source rust, increments rustOk, emits rust_ok events", async () => {
    const { client, calls } = stubClient((method) =>
      method === "knowledge.get_node" ? { node: NODE } : APPLIED);
    const events: KnowledgeCutoverTelemetryEvent[] = [];
    const opts = { env: ON, getClient: () => client, onEvent: (e: KnowledgeCutoverTelemetryEvent) => { events.push(e); } };
    const tsWrite = vi.fn(async () => FENCED);
    const tsRead = vi.fn(async () => ({ node: null }));

    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsWrite, opts))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(wireKnowledgeGetNodeCutover(GETN, tsRead, opts))
      .resolves.toEqual({ source: "rust", value: { node: NODE } });
    expect(tsWrite).not.toHaveBeenCalled();
    expect(tsRead).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["knowledge.update_node_fenced", "knowledge.get_node"]);
    expect(events.map((e) => [e.outcome, e.source])).toEqual([["rust_ok", "rust"], ["rust_ok", "rust"]]);
    const m = getKnowledgeCutoverMetrics();
    expect(m.update_node_fenced).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0, fenceMismatch: 0 });
    expect(m.get_node).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0 });
  });

  it.each([-32001, -32004])("flag ON + not_committed write rpc %i falls back to tsFallback (fallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ fallback: 1, tsBypass: 0, rustOk: 0, indeterminate: 0 });
  });

  it("flag ON + ANY read error (incl. -32005) falls back to TS reader", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => ({ nodes: [] }));
    await expect(wireKnowledgeListNodesCutover(NODES, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: { nodes: [] } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getKnowledgeCutoverMetrics().list_nodes)
      .toMatchObject({ fallback: 1, indeterminate: 0, rustOk: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(KnowledgeCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0 });
  });

  it("propagates Rust fence mismatch { applied: false, reason: 'fenced' } as success; counts rustOk + fenceMismatch", async () => {
    const { client } = stubClient(() => ({ applied: false, reason: "fenced" }));
    const tsFallback = vi.fn(async () => APPLIED);
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "rust", value: { applied: false, reason: "fenced" } });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ rustOk: 1, fenceMismatch: 1, fallback: 0 });
  });

  it("counts fenceMismatch for TS-originated { applied: false } as well", async () => {
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, async () => FENCED, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: FENCED });
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustOk: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws (bypass path)", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireKnowledgeListAgentGrantsCutover(GRANTS, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getKnowledgeCutoverMetrics().list_agent_grants)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("counts tsError and rethrows when the adapter-driven tsFallback throws (rust path)", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBe(failure);
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ totalCalls: 1, tsError: 1, fallback: 0, rustOk: 0 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ company_id: U1, kb_id: "not-a-uuid", node_id: NIL });
    await expect(wireKnowledgeGetNodeCutover(params, async () => ({ node: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { node: null } });
    expect(params).toEqual({ company_id: U1, kb_id: "not-a-uuid", node_id: NIL });
  });

  it("createKnowledgeCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "knowledge.list_bases" ? { kbs: [] } : APPLIED);
    const events: KnowledgeCutoverTelemetryEvent[] = [];
    const hooks = createKnowledgeCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.updateNodeFenced(UPDATE, vi.fn(async () => FENCED)))
      .resolves.toEqual({ source: "rust", value: APPLIED });
    await expect(hooks.listBases(BASES, vi.fn(async () => ({ kbs: [KB] }))))
      .resolves.toEqual({ source: "rust", value: { kbs: [] } });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.getNode(GETN, async () => ({ node: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { node: null } });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.update_node_fenced).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.list_bases).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.get_node).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getKnowledgeCutoverMetrics().get_node.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireKnowledgeGetNodeCutover(GETN, async () => ({ node: null }), {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: KnowledgeCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: { node: null } });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getKnowledgeCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireKnowledgeGetNodeCutover(GETN, async () => ({ node: null }), { env: OFF });
    const snap = getKnowledgeCutoverMetrics();
    Object.assign(snap.get_node, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list_agent_grants, { totalCalls: 999 });
    const fresh = getKnowledgeCutoverMetrics();
    expect(fresh.get_node).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list_agent_grants.totalCalls).toBe(0);

    resetKnowledgeCutoverMetricsForTests();
    const zeroed = getKnowledgeCutoverMetrics();
    for (const op of KNOWLEDGE_WIRED_OPERATIONS) expect(zeroed[op].totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => APPLIED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(KnowledgeCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getKnowledgeCutoverMetrics().update_node_fenced)
      .toMatchObject({ indeterminate: 1, fallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => APPLIED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireKnowledgeUpdateNodeFencedCutover(UPDATE, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: APPLIED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getKnowledgeCutoverMetrics().update_node_fenced).toMatchObject({ tsBypass: 1 });
  });
});

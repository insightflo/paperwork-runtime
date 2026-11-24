import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyKnowledgeRpcError, getKnowledgeNode, listAgentKbGrants, listKnowledgeBases,
  listKnowledgeNodes, updateKnowledgeNodeFenced,
} from "../services/paperwork-engine-knowledge.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
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
const UPDATE = { ...GETN, expected_updated_at: T0, new_title: "t2" } as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("knowledge.* typed RPC methods", () => {
  it("listKnowledgeBases maps {kbs}; exact wire params + callOpts passthrough", async () => {
    const { client, calls } = stub({ "knowledge.list_bases": { kbs: [KB] } });
    await expect(listKnowledgeBases(client, { ...BASES, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual({ kbs: [KB] });
    expect(calls[0]).toEqual({ method: "knowledge.list_bases", params: BASES, callOpts: { timeoutMs: 9 } });
    const e = stub({ "knowledge.list_bases": { kbs: [] } });
    await expect(listKnowledgeBases(e.client, BASES)).resolves.toEqual({ kbs: [] });
    const s = stub({});
    for (const p of [{ company_id: "x" }, { company_id: 5 }, { company_id: null }]) {
      await expect(listKnowledgeBases(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { kbs: "x" }, { kbs: [KB], x: 1 },
      { kbs: [{ ...KB, kb_type: "hybrid" }] }, { kbs: [{ ...KB, max_token_budget: 1.5 }] },
      { kbs: [{ ...KB, max_token_budget: 2 ** 31 }] }, { kbs: [{ ...KB, description: null }] },
      { kbs: [{ ...KB, config_json: undefined }] }, { kbs: [{ ...KB, extra: 1 }] },
      { kbs: [{ ...KB, created_at: "2026-02-30T00:00:00Z" }] }, { kbs: [null] }]) {
      const c = stub({ "knowledge.list_bases": bad });
      await expect(listKnowledgeBases(c.client, BASES)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("getKnowledgeNode maps {node|null} and gates uuids pre-RPC", async () => {
    const { client, calls } = stub({ "knowledge.get_node": { node: NODE } });
    await expect(getKnowledgeNode(client, GETN)).resolves.toEqual({ node: NODE });
    expect(calls[0]).toEqual({ method: "knowledge.get_node", params: GETN, callOpts: undefined });
    const n = stub({ "knowledge.get_node": { node: null } });
    await expect(getKnowledgeNode(n.client, GETN)).resolves.toEqual({ node: null });
    const s = stub({});
    for (const p of [{ company_id: "x" }, { kb_id: 1 }, { node_id: "y" }, { node_id: null }]) {
      await expect(getKnowledgeNode(s.client, { ...GETN, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { node: "x" }, { node: {} }, { node: null, x: 1 },
      { node: { ...NODE, node_type: "wiki" } }, { node: { ...NODE, parent_id: "not-a-uuid" } },
      { node: { ...NODE, extra: 1 } }]) {
      const c = stub({ "knowledge.get_node": bad });
      await expect(getKnowledgeNode(c.client, GETN)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listKnowledgeNodes maps rows; rejects malformed node rows", async () => {
    const { client, calls } = stub({ "knowledge.list_nodes": { nodes: [NODE] } });
    await expect(listKnowledgeNodes(client, { ...NODES, junk: 0 } as never)).resolves.toEqual({ nodes: [NODE] });
    expect(calls[0]).toEqual({ method: "knowledge.list_nodes", params: NODES, callOpts: undefined });
    const e = stub({ "knowledge.list_nodes": { nodes: [] } });
    await expect(listKnowledgeNodes(e.client, NODES)).resolves.toEqual({ nodes: [] });
    const s = stub({});
    for (const p of [{ company_id: "z" }, { kb_id: null }]) {
      await expect(listKnowledgeNodes(s.client, { ...NODES, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const { slug: _s, ...noSlug } = NODE;
    for (const bad of [null, {}, { nodes: {} }, { nodes: [NODE], x: 1 },
      { nodes: [{ ...NODE, node_type: "wiki" }] }, { nodes: [{ ...NODE, status: "archived" }] },
      { nodes: [{ ...NODE, certified: "y" }] }, { nodes: [{ ...NODE, tags: "x" }] },
      { nodes: [{ ...NODE, tags: [1] }] }, { nodes: [{ ...NODE, linked_node_ids: "x" }] },
      { nodes: [{ ...NODE, linked_node_ids: [2] }] }, { nodes: [{ ...NODE, source_refs: undefined }] },
      { nodes: [noSlug] }, { nodes: [{ ...NODE, extra: 1 }] }, { nodes: [null] }]) {
      const c = stub({ "knowledge.list_nodes": bad });
      await expect(listKnowledgeNodes(c.client, NODES)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listAgentKbGrants omits agent_id when undefined AND null; sends uuid when present", async () => {
    const { client, calls } = stub({ "knowledge.list_agent_grants": { grants: [GRANT] } });
    await expect(listAgentKbGrants(client, BASES)).resolves.toEqual({ grants: [GRANT] });
    expect(calls[0]).toEqual({ method: "knowledge.list_agent_grants", params: BASES, callOpts: undefined });
    const nl = stub({ "knowledge.list_agent_grants": { grants: [] } });
    await listAgentKbGrants(nl.client, { ...BASES, agent_id: null });
    expect(nl.calls[0].params).toEqual(BASES); // serde(default): null also keeps the key off the wire
    const u = stub({ "knowledge.list_agent_grants": { grants: [GRANT] } });
    await listAgentKbGrants(u.client, { ...BASES, agent_id: U2 });
    expect(u.calls[0].params).toEqual({ ...BASES, agent_id: U2 });
    const s = stub({});
    for (const p of [{ company_id: "x" }, { agent_id: "x" }, { agent_id: 5 }]) {
      await expect(listAgentKbGrants(s.client, { ...BASES, ...p } as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { grants: "x" }, { grants: [GRANT], x: 1 },
      { grants: [{ ...GRANT, agent_id: "x" }] }, { grants: [{ ...GRANT, granted_by: null }] },
      { grants: [{ ...GRANT, created_at: "soon" }] }, { grants: [{ ...GRANT, extra: 1 }] }]) {
      const c = stub({ "knowledge.list_agent_grants": bad });
      await expect(listAgentKbGrants(c.client, BASES)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("updateKnowledgeNodeFenced ships only supplied new_* fields; maps both union arms", async () => {
    const { client, calls } = stub({ "knowledge.update_node_fenced": { applied: true, node: NODE } });
    await expect(updateKnowledgeNodeFenced(client, { ...UPDATE, junk: 1 } as never, { timeoutMs: 7 }))
      .resolves.toEqual({ applied: true, node: NODE });
    expect(calls[0]).toEqual({
      method: "knowledge.update_node_fenced", params: UPDATE, callOpts: { timeoutMs: 7 },
    });
    const f = stub({ "knowledge.update_node_fenced": { applied: false, reason: "fenced" } });
    await expect(updateKnowledgeNodeFenced(f.client, UPDATE)).resolves.toEqual({ applied: false, reason: "fenced" });
    const d = stub({ "knowledge.update_node_fenced": { applied: true, node: NODE } });
    await updateKnowledgeNodeFenced(d.client, { ...UPDATE, expected_updated_at: new Date(T0) });
    expect(d.calls[0].params).toEqual({ ...GETN, expected_updated_at: "2026-06-01T00:00:00.000Z", new_title: "t2" });
    const full = {
      new_title: "t", new_summary: "s", new_content: "c",
      new_status: "retired", new_certified: false,
    } as const;
    const w = stub({ "knowledge.update_node_fenced": { applied: true, node: NODE } });
    await updateKnowledgeNodeFenced(w.client, { ...UPDATE, ...full });
    expect(w.calls[0].params).toEqual({ ...GETN, expected_updated_at: T0, ...full });
    const o = stub({ "knowledge.update_node_fenced": { applied: true, node: NODE } });
    await updateKnowledgeNodeFenced(o.client, { ...UPDATE, new_summary: null, new_certified: undefined });
    expect(o.calls[0].params).toEqual(UPDATE); // undefined AND null both mean absent
  });
  it("updateKnowledgeNodeFenced gates params before any RPC", async () => {
    const s = stub({});
    const go = (p: Record<string, unknown>) => updateKnowledgeNodeFenced(s.client, { ...UPDATE, ...p } as never);
    for (const p of [
      { company_id: "x" }, { kb_id: 1 }, { node_id: null },
      { expected_updated_at: "nope" }, { expected_updated_at: 42 }, { expected_updated_at: new Date(NaN) },
      { expected_updated_at: "2026-02-30T00:00:00Z" }, { new_title: "   " }, { new_title: "" },
      { new_summary: "  " }, { new_content: "\t\n" }, { new_title: 7 },
      { new_status: "bogus" }, { new_status: 5 }, { new_certified: "yes" }, { new_certified: 0 },
    ]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    // knowledge.rs's -32602 gate: no new_* field at all, and all-null new_* both count as empty.
    await expect(updateKnowledgeNodeFenced(s.client, { ...GETN, expected_updated_at: T0 } as never))
      .rejects.toThrow(RangeError);
    const allNull = {
      ...GETN, expected_updated_at: T0, new_title: null, new_summary: null,
      new_content: null, new_status: null, new_certified: null,
    };
    await expect(updateKnowledgeNodeFenced(s.client, allNull as never)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("updateKnowledgeNodeFenced validates the applied union + node row", async () => {
    for (const bad of [null, {}, { applied: "y" }, { applied: true }, { applied: false },
      { applied: false, reason: "stale" }, { applied: false, reason: "fenced", x: 1 },
      { applied: false, reason: "fenced", node: NODE }, { applied: true, reason: "fenced" },
      { applied: true, node: null }, { applied: true, node: NODE, x: 1 },
      { applied: true, node: { ...NODE, node_type: "wiki" } },
      { applied: true, node: { ...NODE, parent_id: "not-a-uuid" } },
      { applied: true, node: { ...NODE, tags: [1] } }, { applied: true, node: { ...NODE, extra: 1 } }]) {
      const c = stub({ "knowledge.update_node_fenced": bad });
      await expect(updateKnowledgeNodeFenced(c.client, UPDATE)).rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const status of ["active", "retired"] as const) {
      const c = stub({ "knowledge.update_node_fenced": { applied: true, node: { ...NODE, status } } });
      await expect(updateKnowledgeNodeFenced(c.client, { ...UPDATE, new_status: status }))
        .resolves.toEqual({ applied: true, node: { ...NODE, status } });
    }
  });
  it("accepts every enum value in node rows", async () => {
    for (const kb_type of ["static", "rag", "ontology"] as const) {
      const c = stub({ "knowledge.list_bases": { kbs: [{ ...KB, kb_type }] } });
      await expect(listKnowledgeBases(c.client, BASES)).resolves.toEqual({ kbs: [{ ...KB, kb_type }] });
    }
    for (const node_type of ["concept", "entity", "glossary", "fact", "index", "policy"] as const) {
      const c = stub({ "knowledge.get_node": { node: { ...NODE, node_type } } });
      await expect(getKnowledgeNode(c.client, GETN)).resolves.toEqual({ node: { ...NODE, node_type } });
    }
  });
  it("rejects shapes whose required keys are inherited, not own", async () => {
    const inh = (p: object, o: object) => Object.assign(Object.create(p), o);
    const { id: _i, ...nodeRest } = NODE;
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["knowledge.list_bases", inh({ kbs: [] }, { x: 1 }), (c) => listKnowledgeBases(c, BASES)],
      ["knowledge.get_node", { node: inh({ id: NIL }, { ...nodeRest, x: 1 }) }, (c) => getKnowledgeNode(c, GETN)],
      ["knowledge.list_nodes", inh({ nodes: [] }, { x: 1 }), (c) => listKnowledgeNodes(c, NODES)],
      ["knowledge.list_agent_grants", inh({ grants: [] }, { x: 1 }), (c) => listAgentKbGrants(c, BASES)],
      ["knowledge.update_node_fenced", inh({ applied: false }, { reason: "fenced", x: 1 }),
        (c) => updateKnowledgeNodeFenced(c, UPDATE)],
    ];
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyKnowledgeRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyKnowledgeRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const e of [
      new PaperworkEngineError("rpc_error", "m", -32601),
      new PaperworkEngineError("timeout", "m"), new PaperworkEngineError("protocol_error", "m"),
      new Error("x"), "x", null, undefined, 42,
    ]) {
      expect(classifyKnowledgeRpcError(e)).toEqual(unknown);
    }
  });
});

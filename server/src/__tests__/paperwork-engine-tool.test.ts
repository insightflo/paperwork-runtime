import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  claimToolExecutionReceiptIdempotent, classifyToolRpcError, getToolDefinition,
  listCompanySkills, listToolDefinitions, listToolExecutionReceipts,
} from "../services/paperwork-engine-tool.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
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
const CLAIM = {
  company_id: U1, run_id: "r1", tool: "ns.tool", idempotency_key: "k1", parameters: { x: 1 },
} as const;
const CLAIMED = { outcome: "claimed", receipt: RECEIPT } as const;

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("tool.* typed RPC methods", () => {
  it("listToolDefinitions maps rows; enabled omitted when nullish, sent when boolean", async () => {
    const { client, calls } = stub({ "tool.list_definitions": { definitions: [DEF] } });
    await expect(listToolDefinitions(client, DEFS, { timeoutMs: 7 }))
      .resolves.toEqual({ definitions: [DEF] });
    expect(calls[0]).toEqual({
      method: "tool.list_definitions", params: DEFS, callOpts: { timeoutMs: 7 },
    });
    for (const enabled of [undefined, null]) {
      const d = stub({ "tool.list_definitions": { definitions: [] } });
      await listToolDefinitions(d.client, { ...DEFS, enabled } as never);
      expect(d.calls[0].params).toEqual(DEFS);
    }
    for (const enabled of [true, false]) {
      const d = stub({ "tool.list_definitions": { definitions: [] } });
      await listToolDefinitions(d.client, { ...DEFS, enabled });
      expect(d.calls[0].params).toEqual({ ...DEFS, enabled });
    }
  });
  it("listToolDefinitions gates params and validates definition rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "z" }, { limit: 1.5 }, { limit: "10" }, { enabled: "yes" },
    ]) {
      await expect(listToolDefinitions(s.client, { ...DEFS, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: U1 }, { limit: 10 }, { ...DEFS, extra: 1 }]) {
      await expect(listToolDefinitions(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const { input_schema: _i, ...noSchema } = DEF;
    for (const bad of [
      null, {}, { definition: null }, { definitions: null }, { definitions: "x" },
      { definitions: [DEF], x: 1 }, { definitions: [noSchema] }, { definitions: [null] },
      { definitions: [{ ...DEF, id: "not-a-uuid" }] },
      { definitions: [{ ...DEF, created_at: "2026-13-01T00:00:00Z" }] },
      { definitions: [{ ...DEF, enabled: "true" }] }, { definitions: [{ ...DEF, extra: 1 }] },
    ]) {
      const c = stub({ "tool.list_definitions": bad });
      await expect(listToolDefinitions(c.client, DEFS)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const j = stub({ "tool.list_definitions": { definitions: [{ ...DEF, input_schema: null }] } });
    await expect(listToolDefinitions(j.client, DEFS)) // jsonb: any Value incl. null
      .resolves.toEqual({ definitions: [{ ...DEF, input_schema: null }] });
  });
  it("getToolDefinition maps {definition: row|null}; params are exact-key gated", async () => {
    const { client, calls } = stub({ "tool.get_definition": { definition: DEF } });
    await expect(getToolDefinition(client, GETD)).resolves.toEqual({ definition: DEF });
    expect(calls[0]).toEqual({ method: "tool.get_definition", params: GETD, callOpts: undefined });
    const n = stub({ "tool.get_definition": { definition: null } });
    await expect(getToolDefinition(n.client, GETD)).resolves.toEqual({ definition: null });
    const s = stub({});
    for (const p of [
      { tool_id: "z" }, { company_id: 5 }, { company_id: U1 }, { ...GETD, x: 1 }, null, "x",
    ]) {
      await expect(getToolDefinition(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [
      null, {}, { definition: "x" }, { definition: null, x: 1 }, { definitions: [DEF] },
      { definition: { ...DEF, adapter_config: undefined } },
      { definition: { ...DEF, name: null } }, { definition: { ...DEF, updated_at: 0 } },
    ]) {
      const c = stub({ "tool.get_definition": bad });
      await expect(getToolDefinition(c.client, GETD)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listCompanySkills maps rows; gates params and validates skill rows", async () => {
    const { client, calls } = stub({ "tool.list_skills": { skills: [SKILL] } });
    await expect(listCompanySkills(client, SKILLS)).resolves.toEqual({ skills: [SKILL] });
    expect(calls[0]).toEqual({ method: "tool.list_skills", params: SKILLS, callOpts: undefined });
    const e = stub({ "tool.list_skills": { skills: [] } });
    await expect(listCompanySkills(e.client, SKILLS)).resolves.toEqual({ skills: [] });
    const s = stub({});
    for (const p of [
      { company_id: "z" }, { limit: 1.5 }, { limit: "10" }, { company_id: U1 }, { ...SKILLS, x: 1 },
    ]) {
      await expect(listCompanySkills(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const { metadata: _m, ...noMeta } = SKILL;
    const { file_inventory: _f, ...noFiles } = SKILL;
    for (const bad of [
      null, {}, { definition: null }, { skills: null }, { skills: {} }, { skills: [SKILL], x: 1 },
      { skills: [{ ...SKILL, source_type: "web" }] }, { skills: [{ ...SKILL, trust_level: "high" }] },
      { skills: [{ ...SKILL, compatibility: "bad" }] }, { skills: [noMeta] }, { skills: [noFiles] },
      { skills: [{ ...SKILL, description: 7 }] }, { skills: [{ ...SKILL, extra: 1 }] },
    ]) {
      const c = stub({ "tool.list_skills": bad });
      await expect(listCompanySkills(c.client, SKILLS)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const full = { // every Option column also accepts a populated value
      ...SKILL, description: "d", source_locator: "/p", source_ref: "ref", metadata: { k: 1 },
    };
    const ok = stub({ "tool.list_skills": { skills: [full] } });
    await expect(listCompanySkills(ok.client, SKILLS)).resolves.toEqual({ skills: [full] });
  });
  it("listToolExecutionReceipts omits run_id when nullish, sends it when set", async () => {
    const { client, calls } = stub({ "tool.list_execution_receipts": { receipts: [RECEIPT] } });
    await expect(listToolExecutionReceipts(client, RCPTS)).resolves.toEqual({ receipts: [RECEIPT] });
    expect(calls[0]).toEqual({
      method: "tool.list_execution_receipts", params: RCPTS, callOpts: undefined,
    });
    for (const run_id of [undefined, null]) {
      const d = stub({ "tool.list_execution_receipts": { receipts: [] } });
      await listToolExecutionReceipts(d.client, { ...RCPTS, run_id } as never);
      expect(d.calls[0].params).toEqual(RCPTS);
    }
    const a = stub({ "tool.list_execution_receipts": { receipts: [RECEIPT] } });
    await listToolExecutionReceipts(a.client, { ...RCPTS, run_id: "r1" });
    expect(a.calls[0].params).toEqual({ ...RCPTS, run_id: "r1" });
    // Rust has no blank-text gate on the run_id filter: "" is a valid wire value.
    const e = stub({ "tool.list_execution_receipts": { receipts: [] } });
    await listToolExecutionReceipts(e.client, { ...RCPTS, run_id: "" });
    expect(e.calls[0].params).toEqual({ ...RCPTS, run_id: "" });
  });
  it("listToolExecutionReceipts gates params and validates receipt rows", async () => {
    const s = stub({});
    for (const p of [
      { company_id: "z" }, { limit: 1.5 }, { limit: "10" }, { run_id: 7 },
      { company_id: U1 }, { limit: 50 }, { ...RCPTS, x: 1 },
    ]) {
      await expect(listToolExecutionReceipts(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const { result_status: _r, ...noStatus } = RECEIPT;
    for (const bad of [
      null, {}, { receipts: null }, { receipts: "x" }, { receipts: [RECEIPT], x: 1 },
      { receipts: [{ ...RECEIPT, status: "done" }] }, { receipts: [noStatus] },
      { receipts: [{ ...RECEIPT, result_status: "x" }] },
      { receipts: [{ ...RECEIPT, result_status: 2 ** 31 }] },
      { receipts: [{ ...RECEIPT, id: "not-a-uuid" }] },
      { receipts: [{ ...RECEIPT, workflow_run_id: "z" }] },
      { receipts: [{ ...RECEIPT, completed_at: "nope" }] }, { receipts: [{ ...RECEIPT, extra: 1 }] },
    ]) {
      const c = stub({ "tool.list_execution_receipts": bad });
      await expect(listToolExecutionReceipts(c.client, RCPTS)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const full = { // populated Option columns pass
      ...RECEIPT, status: "completed", result_status: 200, result_body: { ok: 1 },
      completed_at: T1, workflow_run_id: NIL, step_id: "s1",
    };
    const ok = stub({ "tool.list_execution_receipts": { receipts: [full] } });
    await expect(listToolExecutionReceipts(ok.client, RCPTS)).resolves.toEqual({ receipts: [full] });
  });
  it("claimToolExecutionReceiptIdempotent maps all 3 outcome arms; parameters verbatim", async () => {
    const { client, calls } = stub({ "tool.claim_execution_receipt_idempotent": CLAIMED });
    await expect(claimToolExecutionReceiptIdempotent(client, CLAIM, { timeoutMs: 3 }))
      .resolves.toEqual(CLAIMED);
    expect(calls[0]).toEqual({
      method: "tool.claim_execution_receipt_idempotent", params: CLAIM, callOpts: { timeoutMs: 3 },
    });
    for (const outcome of ["replay", "in_progress"]) {
      const d = stub({ "tool.claim_execution_receipt_idempotent": { outcome, receipt: RECEIPT } });
      await expect(claimToolExecutionReceiptIdempotent(d.client, CLAIM))
        .resolves.toEqual({ outcome, receipt: RECEIPT });
    }
    for (const parameters of [{ a: [1] }, null, 0, "s", [1]]) { // any JSON value is legal
      const d = stub({ "tool.claim_execution_receipt_idempotent": CLAIMED });
      await claimToolExecutionReceiptIdempotent(d.client, { ...CLAIM, parameters });
      expect(d.calls[0].params).toMatchObject({ parameters });
    }
  });
  it("claimToolExecutionReceiptIdempotent gates params before any RPC", async () => {
    const s = stub({});
    const go = (p: Record<string, unknown>) =>
      claimToolExecutionReceiptIdempotent(s.client, { ...CLAIM, ...p } as never);
    for (const p of [
      { company_id: "z" }, { run_id: "" }, { run_id: "   " }, { run_id: 7 },
      { tool: "" }, { tool: "  " }, { tool: null },
      { idempotency_key: "" }, { idempotency_key: "   " },
      { idempotency_key: "k".repeat(201) }, { parameters: undefined },
    ]) {
      await expect(go(p)).rejects.toThrow(RangeError);
    }
    const { parameters: _p, ...noParams } = CLAIM;
    for (const p of [noParams, { ...CLAIM, x: 1 }, null, "x"]) {
      await expect(claimToolExecutionReceiptIdempotent(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    const k200 = { ...CLAIM, idempotency_key: "k".repeat(200) }; // boundary passes, hits the wire
    const d = stub({ "tool.claim_execution_receipt_idempotent": CLAIMED });
    await claimToolExecutionReceiptIdempotent(d.client, k200);
    expect(d.calls[0].params).toEqual(k200);
  });
  it("claimToolExecutionReceiptIdempotent validates the outcome union exactly", async () => {
    for (const bad of [
      null, {}, { outcome: "duplicate", receipt: RECEIPT }, { outcome: "claimed" },
      { receipt: RECEIPT }, { outcome: "claimed", receipt: null },
      { outcome: "claimed", receipt: RECEIPT, x: 1 },
      { outcome: "claimed", receipt: { ...RECEIPT, status: "done" } },
      { outcome: "claimed", receipt: { ...RECEIPT, result_body: undefined } },
    ]) {
      const c = stub({ "tool.claim_execution_receipt_idempotent": bad });
      await expect(claimToolExecutionReceiptIdempotent(c.client, CLAIM))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyToolRpcError", () => {
  it("delegates to the heartbeat commit contract (fail-closed)", () => {
    expect(classifyToolRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyToolRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    expect(classifyToolRpcError(new PaperworkEngineError("rpc_error", "m", -32601))).toEqual(unknown);
    expect(classifyToolRpcError(new PaperworkEngineError("timeout", "m"))).toEqual(unknown);
    for (const e of [new Error("x"), "x", null, { rpcCode: -32005 }]) {
      expect(classifyToolRpcError(e)).toEqual(unknown);
    }
  });
});

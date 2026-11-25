import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  CompanySkill, ToolClaimExecutionReceiptIdempotentResult, ToolDefinition,
  ToolExecutionReceipt,
} from "../services/paperwork-engine-tool.js";
import { ToolCutoverIndeterminateError } from "../services/tool-cutover.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import { logger } from "../middleware/logger.js";
import {
  createToolCutoverHooks,
  getToolCutoverMetrics,
  resetToolCutoverMetricsForTests,
  wireToolClaimExecutionReceiptIdempotentCutover,
  wireToolGetDefinitionCutover,
  wireToolListDefinitionsCutover,
  wireToolListExecutionReceiptsCutover,
  wireToolListSkillsCutover,
  TOOL_WIRED_OPERATIONS,
  type ToolCutoverTelemetryEvent,
} from "../services/tool-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: vi.fn(() => null),
}));

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_TOOL_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const DEF: ToolDefinition = {
  id: NIL, company_id: U1, name: "web_search", description: "d",
  input_schema: { type: "object" }, adapter_type: "http", adapter_config: { url: "u" },
  enabled: true, created_at: T0, updated_at: T1,
};
const SKILL: CompanySkill = {
  id: NIL, company_id: U1, key: "k", slug: "s", name: "n", description: null,
  markdown: "# m", source_type: "local_path", source_locator: null, source_ref: null,
  trust_level: "markdown_only", compatibility: "compatible", file_inventory: [],
  metadata: null, created_at: T0, updated_at: T1,
};
const RECEIPT: ToolExecutionReceipt = {
  id: NIL, company_id: U1, run_id: "r1", tool: "ns.tool", idempotency_key: "k1",
  status: "executing", request_parameters: { x: 1 }, result_status: null,
  result_body: null, claimed_at: T0, completed_at: null, workflow_run_id: null, step_id: null,
};
const DEFS = { company_id: U1, limit: 10 };
const GETD = { company_id: U1, tool_id: NIL };
const SKILLS = { company_id: U1, limit: 25 };
const RCPTS = { company_id: U1, limit: 50 };
const CLAIM = { company_id: U1, run_id: "r1", tool: "ns.tool", idempotency_key: "k1", parameters: { x: 1 } };
const CLAIMED: ToolClaimExecutionReceiptIdempotentResult = { outcome: "claimed", receipt: RECEIPT };
const REPLAY: ToolClaimExecutionReceiptIdempotentResult = { outcome: "replay", receipt: RECEIPT };

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
  resetToolCutoverMetricsForTests();
  sharedClient.mockReset().mockReturnValue(null);
  vi.mocked(logger.warn).mockClear();
});

describe("tool-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all five ops to tsFallback without resolving the client", async () => {
    const getClient = vi.fn(() => stubClient(() => ({})).client);
    for (const env of [OFF, { PAPERWORK_RUST_TOOL_CUTOVER: "0" }, { PAPERWORK_RUST_TOOL_CUTOVER: "true" }]) {
      const o = { env, getClient };
      await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, async () => CLAIMED, o)).resolves.toEqual({ source: "ts", value: CLAIMED });
      await expect(wireToolListDefinitionsCutover(DEFS, async () => ({ definitions: [DEF] }), o)).resolves.toEqual({ source: "ts", value: { definitions: [DEF] } });
      await expect(wireToolGetDefinitionCutover(GETD, async () => ({ definition: DEF }), o)).resolves.toEqual({ source: "ts", value: { definition: DEF } });
      await expect(wireToolListSkillsCutover(SKILLS, async () => ({ skills: [SKILL] }), o)).resolves.toEqual({ source: "ts", value: { skills: [SKILL] } });
      await expect(wireToolListExecutionReceiptsCutover(RCPTS, async () => ({ receipts: [RECEIPT] }), o)).resolves.toEqual({ source: "ts", value: { receipts: [RECEIPT] } });
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClient).not.toHaveBeenCalled();
    const m = getToolCutoverMetrics();
    for (const op of TOOL_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
  });

  it("flag ON + null/throwing getClient or null shared client warns and fails safe to tsBypass", async () => {
    const tsFallback = vi.fn(async () => CLAIMED);
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: CLAIMED });
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: CLAIMED });
    // default resolver path: mocked shared client returning null also bypasses
    await expect(wireToolGetDefinitionCutover(GETD, async () => ({ definition: null }), { env: ON }))
      .resolves.toEqual({ source: "ts", value: { definition: null } });
    expect(sharedClient).toHaveBeenCalledTimes(1);
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(3);
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
    expect(getToolCutoverMetrics().get_definition)
      .toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("flag ON + Rust success returns source rust, increments rustOk, emits rust_ok events", async () => {
    const { client, calls } = stubClient((method) =>
      method === "tool.get_definition" ? { definition: DEF } : CLAIMED);
    const events: ToolCutoverTelemetryEvent[] = [];
    const opts = { env: ON, getClient: () => client, onEvent: (e: ToolCutoverTelemetryEvent) => { events.push(e); } };
    const tsWrite = vi.fn(async () => REPLAY);
    const tsRead = vi.fn(async () => ({ definition: null }));

    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsWrite, opts))
      .resolves.toEqual({ source: "rust", value: CLAIMED });
    await expect(wireToolGetDefinitionCutover(GETD, tsRead, opts))
      .resolves.toEqual({ source: "rust", value: { definition: DEF } });
    expect(tsWrite).not.toHaveBeenCalled();
    expect(tsRead).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["tool.claim_execution_receipt_idempotent", "tool.get_definition"]);
    expect(events.map((e) => [e.outcome, e.source])).toEqual([["rust_ok", "rust"], ["rust_ok", "rust"]]);
    const m = getToolCutoverMetrics();
    expect(m.claim_execution_receipt_idempotent).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0, fenceMismatch: 0 });
    expect(m.get_definition).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0 });
  });

  it.each([-32001, -32004])("flag ON + not_committed write rpc %i falls back to tsFallback (fallback counter)", async (code) => {
    const { client } = stubClient(() => { throw rpc(code); });
    const tsFallback = vi.fn(async () => CLAIMED);
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: CLAIMED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ fallback: 1, tsBypass: 0, rustOk: 0, indeterminate: 0 });
  });

  it("flag ON + ANY read error (incl. -32005) falls back to TS reader", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => ({ receipts: [] }));
    await expect(wireToolListExecutionReceiptsCutover(RCPTS, tsFallback, { env: ON, getClient: () => client }))
      .resolves.toEqual({ source: "ts", value: { receipts: [] } });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getToolCutoverMetrics().list_execution_receipts)
      .toMatchObject({ fallback: 1, indeterminate: 0, rustOk: 0 });
  });

  it.each([
    ["rpc -32005 commit_indeterminate", rpc(-32005)],
    ["local transport timeout", new PaperworkEngineError("timeout", "deadline")],
  ])("flag ON + indeterminate write error (%s) fails closed without tsFallback", async (_label, error) => {
    const { client } = stubClient(() => { throw error; });
    const tsFallback = vi.fn(async () => CLAIMED);
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBeInstanceOf(ToolCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0 });
  });

  it.each([["replay", 1], ["claimed", 0], ["in_progress", 0]])(
    "claim outcome %s is a success with fenceMismatch=%i, never a fallback", async (outcome, want) => {
      const { client } = stubClient(() => ({ outcome, receipt: RECEIPT }));
      const tsFallback = vi.fn(async () => CLAIMED);
      await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => client }))
        .resolves.toEqual({ source: "rust", value: { outcome, receipt: RECEIPT } });
      expect(tsFallback).not.toHaveBeenCalled();
      expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
        .toMatchObject({ rustOk: 1, fenceMismatch: want, fallback: 0 });
      resetToolCutoverMetricsForTests();
    });

  it("counts fenceMismatch for TS-originated claim replay as well", async () => {
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, async () => REPLAY, { env: OFF }))
      .resolves.toEqual({ source: "ts", value: REPLAY });
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ tsBypass: 1, fenceMismatch: 1, rustOk: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws (bypass path)", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireToolListSkillsCutover(SKILLS, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getToolCutoverMetrics().list_skills)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("counts tsError and rethrows when the adapter-driven tsFallback throws (rust path)", async () => {
    const { client } = stubClient(() => { throw rpc(-32001); });
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => client }))
      .rejects.toBe(failure);
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ totalCalls: 1, tsError: 1, fallback: 0, rustOk: 0 });
  });

  it("does not mutate caller params", async () => {
    const params = Object.freeze({ company_id: U1, tool_id: "not-a-uuid" });
    await expect(wireToolGetDefinitionCutover(params, async () => ({ definition: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { definition: null } });
    expect(params).toEqual({ company_id: U1, tool_id: "not-a-uuid" });
  });

  it("createToolCutoverHooks binds defaults, merges per-call opts, isolates onEvent throws", async () => {
    const { client } = stubClient((method) =>
      method === "tool.list_definitions" ? { definitions: [] } : CLAIMED);
    const events: ToolCutoverTelemetryEvent[] = [];
    const hooks = createToolCutoverHooks({
      env: ON,
      getClient: () => client,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.claimExecutionReceiptIdempotent(CLAIM, vi.fn(async () => REPLAY)))
      .resolves.toEqual({ source: "rust", value: CLAIMED });
    await expect(hooks.listDefinitions(DEFS, vi.fn(async () => ({ definitions: [DEF] }))))
      .resolves.toEqual({ source: "rust", value: { definitions: [] } });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && !e.fenceMismatch)).toBe(true);

    // per-call opts merge over bound defaults
    await expect(hooks.getDefinition(GETD, async () => ({ definition: null }), { env: OFF }))
      .resolves.toEqual({ source: "ts", value: { definition: null } });
    expect(events).toHaveLength(3);

    const m = hooks.getMetrics();
    expect(m.claim_execution_receipt_idempotent).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.list_definitions).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.get_definition).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    // hooks meter is independent of the module-level meter
    expect(getToolCutoverMetrics().get_definition.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireToolGetDefinitionCutover(GETD, async () => ({ definition: null }), {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: ToolCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: { definition: null } });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getToolCutoverMetrics returns a deep copy that cannot corrupt internal state", async () => {
    await wireToolGetDefinitionCutover(GETD, async () => ({ definition: null }), { env: OFF });
    const snap = getToolCutoverMetrics();
    Object.assign(snap.get_definition, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list_execution_receipts, { totalCalls: 999 });
    const fresh = getToolCutoverMetrics();
    expect(fresh.get_definition).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list_execution_receipts.totalCalls).toBe(0);

    resetToolCutoverMetricsForTests();
    const zeroed = getToolCutoverMetrics();
    for (const op of TOOL_WIRED_OPERATIONS) expect(zeroed[op].totalCalls).toBe(0);
  });

  it("hostile onEvent error cannot mask the indeterminate error or reach tsFallback", async () => {
    const { client } = stubClient(() => { throw rpc(-32005); });
    const tsFallback = vi.fn(async () => CLAIMED);
    const onEvent = vi.fn(() => { throw hostileError(); });
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, { env: ON, getClient: () => client, onEvent }))
      .rejects.toBeInstanceOf(ToolCutoverIndeterminateError);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent)
      .toMatchObject({ indeterminate: 1, fallback: 0 });
  });

  it("hostile getClient error still reaches tsFallback once and counts tsBypass", async () => {
    const tsFallback = vi.fn(async () => CLAIMED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireToolClaimExecutionReceiptIdempotentCutover(CLAIM, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: CLAIMED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getToolCutoverMetrics().claim_execution_receipt_idempotent).toMatchObject({ tsBypass: 1 });
  });
});

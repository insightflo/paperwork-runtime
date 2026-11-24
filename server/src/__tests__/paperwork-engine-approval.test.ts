import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPaperworkEngineClient, PaperworkEngineError, type PaperworkEngineClient,
} from "../services/paperwork-engine-client.js";
import {
  cancelApprovalFenced, classifyApprovalRpcError, createApproval, getApproval,
  listApprovals, requestApprovalRevisionFenced, resolveApprovalFenced,
  resubmitApprovalFenced, validateApprovalTransition,
} from "../services/paperwork-engine-approval.js";
import { resolveDefaultPaperworkEngineBin } from "../services/paperwork-engine-runtime.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCOPED = { approval_id: NIL, company_id: NIL };
const ROW = {
  id: "11111111-1111-1111-1111-111111111111", company_id: NIL, approval_type: "deploy",
  requested_by_agent_id: null, requested_by_user_id: "u1", requested_by_plugin_id: null,
  status: "pending", payload: { x: 1 }, decision_note: null, decided_by_user_id: null,
  decided_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

/** Minimal PaperworkEngineClient stub: records calls, returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown) => (calls.push({ method, params }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const errCall = (code: number, message = "m") => Promise.reject(new PaperworkEngineError("rpc_error", message, code));

describe("approval.* typed RPC methods", () => {
  it("validateApprovalTransition: valid/invalid results and snake_case params", async () => {
    const { client, calls } = stub({ "approval.validate_transition": { valid: true } });
    await expect(validateApprovalTransition(client, { from: "pending", to: "approved" }))
      .resolves.toEqual({ valid: true });
    expect(calls[0]).toEqual({
      method: "approval.validate_transition", params: { from: "pending", to: "approved" },
    });
    const s = stub({ "approval.validate_transition": { valid: false, reason: "invalid_transition", from: "approved", to: "pending" } });
    await expect(validateApprovalTransition(s.client, { from: "approved", to: "pending" }))
      .resolves.toEqual({ valid: false, reason: "invalid_transition", from: "approved", to: "pending" });
  });
  it("validateApprovalTransition rejects malformed results and bad params", async () => {
    for (const bad of [null, 1, {}, { valid: "yes" }, { valid: true, x: 1 },
      { valid: false, reason: "bogus", from: "pending", to: "approved" },
      { valid: false, reason: "invalid_transition", from: "bogus", to: "approved" },
      { valid: false, reason: "invalid_transition", from: "pending", to: "approved", extra: 0 }]) {
      const { client } = stub({ "approval.validate_transition": bad });
      await expect(validateApprovalTransition(client, { from: "pending", to: "approved" }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const { client, calls } = stub({});
    await expect(validateApprovalTransition(client, { from: "nope" as never, to: "approved" })).rejects.toThrow(RangeError);
    await expect(validateApprovalTransition(client, { from: "pending", to: "nope" as never })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
  it("getApproval unwraps approval row or null; snake_case params", async () => {
    const { client, calls } = stub({ "approval.get": { approval: ROW } });
    await expect(getApproval(client, SCOPED)).resolves.toEqual(ROW);
    expect(calls[0]).toEqual({ method: "approval.get", params: SCOPED });
    const none = stub({ "approval.get": { approval: null } });
    await expect(getApproval(none.client, SCOPED)).resolves.toBeNull();
    for (const bad of [null, {}, { approval: "x" }, { approval: { ...ROW, id: 1 } }, { approval: ROW, x: 1 }]) {
      const c = stub({ "approval.get": bad });
      await expect(getApproval(c.client, SCOPED)).rejects.toMatchObject({ code: "protocol_error" });
    }
    await expect(getApproval(stub({}).client, { approval_id: "no", company_id: NIL })).rejects.toThrow(RangeError);
  });
  it("listApprovals unwraps approvals array; status optional, limit required", async () => {
    const { client, calls } = stub({ "approval.list": { approvals: [ROW] } });
    await expect(listApprovals(client, { company_id: NIL, limit: 10 })).resolves.toEqual([ROW]);
    expect(calls[0]).toEqual({ method: "approval.list", params: { company_id: NIL, limit: 10 } });
    await listApprovals(client, { company_id: NIL, status: "pending", limit: 5 });
    expect(calls[1].params).toEqual({ company_id: NIL, status: "pending", limit: 5 });
    for (const bad of [null, {}, { approvals: "x" }, { approvals: [ROW], x: 1 }, { approvals: [{ ...ROW, status: "bogus" }] }]) {
      const c = stub({ "approval.list": bad });
      await expect(listApprovals(c.client, { company_id: NIL, limit: 5 }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const c2 = stub({});
    await expect(listApprovals(c2.client, { company_id: NIL, limit: 1.5 })).rejects.toThrow(RangeError);
    await expect(listApprovals(c2.client, { company_id: NIL, status: "bogus" as never, limit: 5 })).rejects.toThrow(RangeError);
    expect(c2.calls).toHaveLength(0);
  });
  it("createApproval maps created/discarded, requires payload, omits undefined optionals", async () => {
    const { client, calls } = stub({ "approval.create": { created: true, approval: ROW } });
    await expect(createApproval(client, { company_id: NIL, approval_type: "deploy", payload: {} }))
      .resolves.toEqual({ created: true, approval: ROW });
    expect(calls[0]).toEqual({
      method: "approval.create", params: { company_id: NIL, approval_type: "deploy", payload: {} },
    });
    const withReq = stub({ "approval.create": { created: false } });
    await expect(createApproval(withReq.client, {
      company_id: NIL, approval_type: "t", payload: null,
      requested_by_agent_id: NIL, requested_by_user_id: "u", requested_by_plugin_id: "p",
    })).resolves.toEqual({ created: false });
    expect(withReq.calls[0].params).toEqual({
      company_id: NIL, approval_type: "t", payload: null,
      requested_by_agent_id: NIL, requested_by_user_id: "u", requested_by_plugin_id: "p",
    });
    for (const bad of [null, {}, { created: "yes" }, { created: false, approval: ROW }, { created: true }]) {
      const c = stub({ "approval.create": bad });
      await expect(createApproval(c.client, { company_id: NIL, approval_type: "t", payload: {} }))
        .rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    const mk = (p: Parameters<typeof createApproval>[1]) => createApproval(s.client, p);
    await expect(mk({ company_id: NIL, approval_type: "", payload: {} })).rejects.toThrow(RangeError);
    await expect(mk({ company_id: NIL, approval_type: 5 as never, payload: {} })).rejects.toThrow(RangeError);
    await expect(mk({ company_id: NIL, approval_type: "t" } as never)).rejects.toThrow(RangeError);
    await expect(mk({ company_id: NIL, approval_type: "t", payload: {}, requested_by_agent_id: "x" })).rejects.toThrow(RangeError);
    await expect(mk({ company_id: NIL, approval_type: "t", payload: {}, requested_by_plugin_id: 7 as never })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("resolveApprovalFenced maps three outcomes; enforces terminal target and actor", async () => {
    const base = { ...SCOPED, target_status: "approved" as const, decided_by_user_id: "u1" };
    const { client, calls } = stub({ "approval.resolve_fenced": { outcome: "applied", approval: ROW } });
    await expect(resolveApprovalFenced(client, base)).resolves.toEqual({ outcome: "applied", approval: ROW });
    expect(calls[0]).toEqual({ method: "approval.resolve_fenced", params: base });
    const other = stub({ "approval.resolve_fenced": { outcome: "already_in_target_state", approval: { ...ROW, status: "approved" } } });
    await expect(resolveApprovalFenced(other.client, { ...base, decision_note: "ok" }))
      .resolves.toMatchObject({ outcome: "already_in_target_state" });
    expect(other.calls[0].params).toMatchObject({ decision_note: "ok" });
    const miss = stub({ "approval.resolve_fenced": { outcome: "not_found_or_conflict" } });
    await expect(resolveApprovalFenced(miss.client, { ...base, target_status: "rejected" }))
      .resolves.toEqual({ outcome: "not_found_or_conflict" });
    for (const bad of [null, {}, { outcome: "bogus" }, { outcome: "applied" },
      { outcome: "not_found_or_conflict", approval: ROW }, { outcome: "applied", approval: ROW, x: 1 }]) {
      const c = stub({ "approval.resolve_fenced": bad });
      await expect(resolveApprovalFenced(c.client, base)).rejects.toMatchObject({ code: "protocol_error" });
    }
    const s = stub({});
    const mk = (p: Parameters<typeof resolveApprovalFenced>[1]) => resolveApprovalFenced(s.client, p);
    for (const target_status of ["pending", "cancelled", "revision_requested", "bogus"] as const) {
      await expect(mk({ ...base, target_status: target_status as never })).rejects.toThrow(RangeError);
    }
    for (const decided_by_user_id of ["", " \t ", 9] as const) {
      await expect(mk({ ...base, decided_by_user_id: decided_by_user_id as never })).rejects.toThrow(RangeError);
    }
    await expect(mk({ ...base, decision_note: 1 as never })).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("requestApprovalRevisionFenced maps updated/discarded; enforces actor", async () => {
    const base = { ...SCOPED, decided_by_user_id: "u1" };
    const { client, calls } = stub({ "approval.request_revision_fenced": { updated: true, approval: { ...ROW, status: "revision_requested" } } });
    await expect(requestApprovalRevisionFenced(client, { ...base, decision_note: "fix" }))
      .resolves.toMatchObject({ updated: true });
    expect(calls[0]).toEqual({
      method: "approval.request_revision_fenced",
      params: { ...SCOPED, decided_by_user_id: "u1", decision_note: "fix" },
    });
    const miss = stub({ "approval.request_revision_fenced": { updated: false } });
    await expect(requestApprovalRevisionFenced(miss.client, base)).resolves.toEqual({ updated: false });
    const s = stub({});
    for (const decided_by_user_id of ["", "  ", null] as const) {
      await expect(requestApprovalRevisionFenced(s.client, { ...base, decided_by_user_id: decided_by_user_id as never }))
        .rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
  it("resubmitApprovalFenced and cancelApprovalFenced map updated/discarded", async () => {
    const { client, calls } = stub({ "approval.resubmit_fenced": { updated: true, approval: ROW } });
    await expect(resubmitApprovalFenced(client, { ...SCOPED, payload: { v: 2 } })).resolves.toEqual({ updated: true, approval: ROW });
    expect(calls[0]).toEqual({ method: "approval.resubmit_fenced", params: { ...SCOPED, payload: { v: 2 } } });
    await resubmitApprovalFenced(client, SCOPED);
    expect(calls[1].params).toEqual(SCOPED); // payload omitted, never null
    const miss = stub({ "approval.resubmit_fenced": { updated: false } });
    await expect(resubmitApprovalFenced(miss.client, SCOPED)).resolves.toEqual({ updated: false });
    const cc = stub({ "approval.cancel_fenced": { updated: true, approval: { ...ROW, status: "cancelled" } } });
    await expect(cancelApprovalFenced(cc.client, SCOPED)).resolves.toMatchObject({ updated: true });
    expect(cc.calls[0]).toEqual({ method: "approval.cancel_fenced", params: SCOPED });
    for (const bad of [null, {}, { updated: "x" }, { updated: false, approval: ROW }, { updated: true }]) {
      const c = stub({ "approval.cancel_fenced": bad });
      await expect(cancelApprovalFenced(c.client, SCOPED)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("rejects approval rows with missing, extra, or mistyped fields", async () => {
    const { id: _i, ...noId } = ROW;
    for (const row of [
      noId, { ...ROW, extra: 1 }, { ...ROW, id: "nope" }, { ...ROW, company_id: 7 },
      { ...ROW, requested_by_agent_id: "x" }, { ...ROW, requested_by_user_id: 1 },
      { ...ROW, status: "done" }, { ...ROW, decided_at: "2026-01-01" },
      { ...ROW, created_at: "2026-02-30T00:00:00Z" }, { ...ROW, updated_at: 0 },
      { ...ROW, decided_by_user_id: [] }, { ...ROW, approval_type: null },
    ]) {
      const c = stub({ "approval.get": { approval: row } });
      await expect(getApproval(c.client, SCOPED)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyApprovalRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("maps every approval RPC code to its commit contract", async () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      await expect(errCall(rpcCode)).rejects.toMatchObject({ code: "rpc_error", rpcCode });
      expect(classifyApprovalRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
  });
  it("fails closed: unknown codes and transport errors are indeterminate/never-retry", () => {
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const code of [-32601, -32000]) {
      expect(classifyApprovalRpcError(new PaperworkEngineError("rpc_error", "m", code))).toEqual(unknown);
    }
    for (const code of ["timeout", "process_exited", "closed", "protocol_error", "bin_not_configured", "queue_full"] as const) {
      expect(classifyApprovalRpcError(new PaperworkEngineError(code, "m"))).toEqual(unknown);
    }
    for (const e of [new Error("x"), "x", null, undefined, 42, { rpcCode: -32001 }]) {
      expect(classifyApprovalRpcError(e)).toEqual(unknown);
    }
  });
});

// A directory can carry the +x bit: require a regular file AND executable access.
const usable = (b: string | null): b is string => {
  try { return b !== null && statSync(b).isFile() && (accessSync(b, constants.X_OK), true); } catch { return false; }
};

describe("real paperwork-engine binary (smoke)", () => {
  let bin: string | null = null;
  beforeAll(() => {
    bin = resolveDefaultPaperworkEngineBin();
    if (!usable(bin)) bin = null;
    if (!bin && process.env.PAPERWORK_ENGINE_BIN === undefined
      && spawnSync("cargo", ["build", "-p", "paperwork-engine"], { cwd: REPO_ROOT }).status === 0) {
      const rebuilt = resolveDefaultPaperworkEngineBin();
      bin = usable(rebuilt) ? rebuilt : null;
    }
  });
  it("approval.* live engine (skips until the binary advertises approval capabilities)", async (ctx) => {
    if (!bin) return ctx.skip();
    const env = { ...process.env };
    delete env.DATABASE_URL; // engine reads ProbeEnv::from_process() -> -32002 pre-dial
    const client = createPaperworkEngineClient({
      bin,
      spawnFn: ((b: string, a: readonly string[], o: SpawnOptionsWithoutStdio) =>
        spawn(b, a, { ...o, env })) as typeof spawn,
    });
    try {
      const health = await client.health();
      expect(health).toMatchObject({ ok: true, engine: "paperwork-engine" });
      if (!health.capabilities.includes("approval.validate_transition")) return ctx.skip();
      await expect(validateApprovalTransition(client, { from: "pending", to: "approved" }))
        .resolves.toEqual({ valid: true });
      await expect(validateApprovalTransition(client, { from: "approved", to: "pending" }))
        .resolves.toEqual({ valid: false, reason: "invalid_transition", from: "approved", to: "pending" });
      await expect(client.call("approval.get", { bogus: 1 }))
        .rejects.toMatchObject({ code: "rpc_error", rpcCode: -32602 });
      const err = await getApproval(client, SCOPED).then(
        () => { throw new Error("expected rpc_error"); }, (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "rpc_error", rpcCode: -32002 });
      expect(classifyApprovalRpcError(err)).toEqual({ kind: "unconfigured", outcome: "not_committed", retryable: false });
    } finally {
      await client.close();
    }
  });
});

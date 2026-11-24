import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  checkoutIssueFenced, classifyIssueRpcError, getIssue, ISSUE_PRIORITIES, ISSUE_STATUSES,
  type IssueStatus, listIssueWorkProducts, listIssuesByCompany,
  releaseIssueCheckoutFenced, transitionIssueStatusFenced,
} from "../services/paperwork-engine-issue.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const T0 = "2026-06-01T00:00:00Z", T1 = "2026-07-01T00:00:00Z";
const ISSUE = {
  id: NIL, company_id: U1, project_id: U2, mission_id: null, parent_id: null, title: "t",
  description: null, status: "todo", priority: "high", assignee_agent_id: null,
  assignee_user_id: null, checkout_run_id: null, execution_run_id: null,
  execution_agent_name_key: null, execution_locked_at: null, created_by_agent_id: null,
  created_by_user_id: "u1", issue_number: 7, identifier: "P-7", origin_kind: "manual",
  origin_id: null, origin_run_id: null, request_depth: 0, billing_code: null,
  started_at: T0, completed_at: null, cancelled_at: null, hidden_at: null,
  created_at: T0, updated_at: T1,
};
const WP = {
  id: NIL, company_id: U1, project_id: null, issue_id: NIL, execution_workspace_id: U2,
  runtime_service_id: null, work_product_type: "pr", provider: "github", external_id: "42",
  title: "w", url: "https://x", status: "open", review_state: "pending", is_primary: true,
  health_status: "ok", summary: null, metadata: { a: [1] }, created_by_run_id: NIL,
  source_execution_generation: 2, created_at: T0, updated_at: T1,
};
const GET = { company_id: U1, issue_id: NIL };
const LIST = { company_id: U1, limit: 50 };
const CHECKOUT = { ...GET, agent_id: U2, run_id: NIL, expected_statuses: ["todo", "backlog"] as IssueStatus[] };
const TRANS = { ...GET, expected_status: "todo", new_status: "in_progress" } as const;
const RELEASE = { ...GET, run_id: NIL };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

describe("issue.* typed RPC methods", () => {
  it("getIssue maps {issue: Issue|null}; params are exact-key gated", async () => {
    const { client, calls } = stub({ "issue.get": { issue: ISSUE } });
    await expect(getIssue(client, GET)).resolves.toEqual({ issue: ISSUE });
    expect(calls[0]).toEqual({ method: "issue.get", params: GET, callOpts: undefined });
    const n = stub({ "issue.get": { issue: null } });
    await expect(getIssue(n.client, GET)).resolves.toEqual({ issue: null }); // company boundary reads null
    const s = stub({});
    for (const p of [{ company_id: "x" }, { issue_id: 1 }, null, "x", [1],
      { company_id: U1 }, { ...GET, x: 1 }]) {
      await expect(getIssue(s.client, p as never)).rejects.toThrow(RangeError); // bad/missing/extra/non-object
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { issue: "x" }, { issue: {} }, { issue: null, x: 1 },
      { issue: { ...ISSUE, status: "bogus" } }, { issue: { ...ISSUE, priority: "urgent" } },
      { issue: { ...ISSUE, title: null } }, { issue: { ...ISSUE, created_at: null } },
      { issue: { ...ISSUE, request_depth: 1.5 } }, { issue: { ...ISSUE, issue_number: 2 ** 31 } },
      { issue: { ...ISSUE, started_at: "soon" } }, { issue: { ...ISSUE, extra: 1 } }, { issue: { id: NIL } }]) {
      const c = stub({ "issue.get": bad });
      await expect(getIssue(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("accepts every status and priority in issue rows", async () => {
    for (const status of ISSUE_STATUSES) {
      const c = stub({ "issue.get": { issue: { ...ISSUE, status } } });
      await expect(getIssue(c.client, GET)).resolves.toEqual({ issue: { ...ISSUE, status } });
    }
    for (const priority of ISSUE_PRIORITIES) {
      const c = stub({ "issue.get": { issue: { ...ISSUE, priority } } });
      await expect(getIssue(c.client, GET)).resolves.toEqual({ issue: { ...ISSUE, priority } });
    }
  });
  it("listIssuesByCompany maps rows and passes limit through unclamped", async () => {
    const { client, calls } = stub({ "issue.list_by_company": { issues: [ISSUE] } });
    await expect(listIssuesByCompany(client, LIST)).resolves.toEqual({ issues: [ISSUE] });
    expect(calls[0]).toEqual({ method: "issue.list_by_company", params: LIST, callOpts: undefined });
    const s = stub({ "issue.list_by_company": { issues: [] } });
    await listIssuesByCompany(s.client, { ...LIST, limit: 0 }); // engine clamps 1..200, not client
    expect(s.calls.at(-1)!.params).toEqual({ ...LIST, limit: 0 });
    const g = stub({});
    for (const p of [
      { company_id: "z" }, { limit: 1.5 }, { limit: "x" }, { limit: 2 ** 53 }, { limit: null },
    ]) {
      await expect(listIssuesByCompany(g.client, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: U1 }, { limit: 1 }, { ...LIST, extra: 1 }]) {
      await expect(listIssuesByCompany(g.client, p as never)).rejects.toThrow(RangeError); // missing/extra key
    }
    expect(g.calls).toHaveLength(0);
    for (const bad of [null, {}, { issues: "x" }, { issues: [ISSUE], x: 1 },
      { issues: [{ ...ISSUE, status: "bogus" }] }, { issues: [{ ...ISSUE, priority: "p1" }] },
      { issues: [{ ...ISSUE, updated_at: 0 }] }, { issues: [{ ...ISSUE, extra: 1 }] }, { issues: [null] }]) {
      const c = stub({ "issue.list_by_company": bad });
      await expect(listIssuesByCompany(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("listIssueWorkProducts maps rows and gates params", async () => {
    const { client, calls } = stub({ "issue.list_issue_work_products": { work_products: [WP] } });
    await expect(listIssueWorkProducts(client, GET)).resolves.toEqual({ work_products: [WP] });
    expect(calls[0]).toEqual({ method: "issue.list_issue_work_products", params: GET, callOpts: undefined });
    const e = stub({ "issue.list_issue_work_products": { work_products: [] } });
    await expect(listIssueWorkProducts(e.client, GET)).resolves.toEqual({ work_products: [] });
    const s = stub({});
    for (const p of [{ issue_id: "x" }, { company_id: null }, { company_id: U1 }, { ...GET, x: 1 }]) {
      await expect(listIssueWorkProducts(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { work_products: {} }, { work_products: [WP], x: 1 },
      { work_products: [{ ...WP, is_primary: "true" }] }, { work_products: [{ ...WP, metadata: undefined }] },
      { work_products: [{ ...WP, source_execution_generation: 1.5 }] },
      { work_products: [{ ...WP, external_id: 7 }] }, { work_products: [{ ...WP, provider: null }] },
      { work_products: [{ ...WP, extra: 1 }] }]) {
      const c = stub({ "issue.list_issue_work_products": bad });
      await expect(listIssueWorkProducts(c.client, GET)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("checkoutIssueFenced maps the union; agent_name_key omitted/null/string", async () => {
    const { client, calls } = stub({ "issue.checkout_fenced": { applied: true, issue: ISSUE } });
    await expect(checkoutIssueFenced(client, CHECKOUT)).resolves.toEqual({ applied: true, issue: ISSUE });
    expect(calls[0]).toEqual({ method: "issue.checkout_fenced", params: CHECKOUT, callOpts: undefined });
    const k = stub({ "issue.checkout_fenced": { applied: true, issue: ISSUE } });
    await checkoutIssueFenced(k.client, { ...CHECKOUT, agent_name_key: "agent-x" });
    expect(k.calls[0].params).toEqual({ ...CHECKOUT, agent_name_key: "agent-x" });
    await checkoutIssueFenced(k.client, { ...CHECKOUT, agent_name_key: null }); // serde Option -> null on wire
    expect(k.calls[1].params).toEqual({ ...CHECKOUT, agent_name_key: null });
    for (const reason of ["not_found", "company_mismatch", "fenced"]) {
      const d = stub({ "issue.checkout_fenced": { applied: false, reason } });
      await expect(checkoutIssueFenced(d.client, CHECKOUT)).resolves.toEqual({ applied: false, reason });
    }
    const s = stub({ "issue.checkout_fenced": { applied: false, reason: "fenced" } });
    for (const st of ISSUE_STATUSES) {
      await checkoutIssueFenced(s.client, { ...CHECKOUT, expected_statuses: [st] });
      expect(s.calls.at(-1)!.params).toMatchObject({ expected_statuses: [st] });
    }
  });
  it("checkoutIssueFenced gates params pre-RPC and rejects malformed results", async () => {
    const s = stub({});
    for (const p of [
      { agent_id: "x" }, { run_id: 5 }, { company_id: {} }, { issue_id: null },
      { expected_statuses: [] }, { expected_statuses: ["bogus"] }, { expected_statuses: "todo" },
      { expected_statuses: ["todo", 7] }, { agent_name_key: "   " }, { agent_name_key: "" },
      { agent_name_key: 9 },
    ]) {
      await expect(checkoutIssueFenced(s.client, { ...CHECKOUT, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: U1, issue_id: NIL, agent_id: U2, run_id: NIL }, { ...CHECKOUT, x: 1 }]) {
      await expect(checkoutIssueFenced(s.client, p as never)).rejects.toThrow(RangeError); // missing/extra key
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { applied: "y" }, { applied: true }, { applied: false },
      { applied: false, reason: "bogus" }, { applied: false, reason: "fenced", x: 1 },
      { applied: true, issue: null }, { applied: true, issue: ISSUE, reason: "fenced" },
      { applied: true, issue: { ...ISSUE, status: "open" } }]) {
      const c = stub({ "issue.checkout_fenced": bad });
      await expect(checkoutIssueFenced(c.client, CHECKOUT)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("transitionIssueStatusFenced maps the union; every status ships both sides", async () => {
    const { client, calls } = stub({ "issue.transition_status_fenced": { applied: true, issue: ISSUE } });
    await expect(transitionIssueStatusFenced(client, TRANS, { timeoutMs: 9 }))
      .resolves.toEqual({ applied: true, issue: ISSUE });
    expect(calls[0]).toEqual({
      method: "issue.transition_status_fenced", params: TRANS, callOpts: { timeoutMs: 9 },
    });
    const d = stub({ "issue.transition_status_fenced": { applied: false, reason: "company_mismatch" } });
    await expect(transitionIssueStatusFenced(d.client, TRANS))
      .resolves.toEqual({ applied: false, reason: "company_mismatch" });
    const s = stub({ "issue.transition_status_fenced": { applied: false, reason: "fenced" } });
    for (const st of ISSUE_STATUSES) { // engine has no same-status gate: st -> st ships as-is
      await transitionIssueStatusFenced(s.client, { ...TRANS, expected_status: st, new_status: st });
      expect(s.calls.at(-1)!.params).toEqual({ ...TRANS, expected_status: st, new_status: st });
    }
  });
  it("transitionIssueStatusFenced gates params pre-RPC and rejects malformed results", async () => {
    const s = stub({});
    for (const p of [
      { expected_status: "bogus" }, { new_status: "open" }, { expected_status: 1 },
      { new_status: null }, { issue_id: "x" }, { company_id: null },
    ]) {
      await expect(transitionIssueStatusFenced(s.client, { ...TRANS, ...p } as never)).rejects.toThrow(RangeError);
    }
    for (const p of [{ company_id: U1, issue_id: NIL, expected_status: "todo" }, { ...TRANS, x: 1 }]) {
      await expect(transitionIssueStatusFenced(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, {}, { applied: false, reason: "conflict" }, { applied: true },
      { applied: true, issue: ISSUE, x: 1 },
      { applied: true, issue: { ...ISSUE, priority: "urgent" } }]) {
      const c = stub({ "issue.transition_status_fenced": bad });
      await expect(transitionIssueStatusFenced(c.client, TRANS)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("releaseIssueCheckoutFenced maps the union and gates params", async () => {
    const { client, calls } = stub({ "issue.release_checkout_fenced": { applied: true, issue: ISSUE } });
    await expect(releaseIssueCheckoutFenced(client, RELEASE)).resolves.toEqual({ applied: true, issue: ISSUE });
    expect(calls[0]).toEqual({ method: "issue.release_checkout_fenced", params: RELEASE, callOpts: undefined });
    for (const reason of ["not_found", "company_mismatch", "fenced"]) {
      const d = stub({ "issue.release_checkout_fenced": { applied: false, reason } });
      await expect(releaseIssueCheckoutFenced(d.client, RELEASE)).resolves.toEqual({ applied: false, reason });
    }
    const s = stub({});
    for (const p of [{ run_id: "x" }, { company_id: 1 }, { run_id: null },
      { issue_id: NIL, company_id: U1 }, { ...RELEASE, x: 1 }]) {
      await expect(releaseIssueCheckoutFenced(s.client, p as never)).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
    for (const bad of [null, { applied: true }, { applied: false, reason: "stale" },
      { applied: false, reason: "fenced", issue: ISSUE },
      { applied: true, issue: { ...ISSUE, hidden_at: "now" } }]) {
      const c = stub({ "issue.release_checkout_fenced": bad });
      await expect(releaseIssueCheckoutFenced(c.client, RELEASE)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("classifyIssueRpcError", () => {
  const cases: [number, string, string, boolean][] = [
    [-32001, "timeout", "not_committed", true], [-32002, "unconfigured", "not_committed", false],
    [-32003, "busy", "not_committed", true], [-32004, "db_error", "not_committed", false],
    [-32005, "commit_indeterminate", "indeterminate", false], [-32602, "invalid_params", "not_committed", false],
  ];
  it("delegates every RPC code to the heartbeat commit contract", () => {
    for (const [rpcCode, kind, outcome, retryable] of cases) {
      expect(classifyIssueRpcError(new PaperworkEngineError("rpc_error", "m", rpcCode)))
        .toEqual({ kind, outcome, retryable });
    }
    const unknown = { kind: "unknown", outcome: "indeterminate", retryable: false };
    for (const e of [
      new PaperworkEngineError("rpc_error", "m", -32601),
      new PaperworkEngineError("timeout", "m"), new PaperworkEngineError("protocol_error", "m"),
      new Error("x"), "x", null, undefined, 42,
    ]) {
      expect(classifyIssueRpcError(e)).toEqual(unknown);
    }
  });
});

import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyCompanyRpcError, createCompany, getCompanyById, getCompanyByIssuePrefix,
  listCompanies, nextCompanyIssueCounter, pauseCompany, resumeCompany, updateCompany,
} from "../services/paperwork-engine-company.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const T0 = "2026-06-01T00:00:00Z";
const ROW = {
  id: NIL, name: "Acme", description: null, status: "active", pause_reason: null, paused_at: null,
  issue_prefix: "ACM", issue_counter: 1, budget_monthly_cents: 10, spent_monthly_cents: 0,
  require_board_approval_for_new_agents: true, timezone: null, work_product_root: null,
  default_language: "en", brand_color: null, company_kind: "business", allows_code_modify: false,
  created_at: T0, updated_at: T0,
};
const CREATE = {
  name: "Acme", description: null, issue_prefix: "ACM", budget_monthly_cents: 10, spent_monthly_cents: 0,
  require_board_approval_for_new_agents: true, timezone: null, work_product_root: null,
  default_language: "en", brand_color: null, company_kind: "business", allows_code_modify: false,
} as const;
const KEYS = {
  create: ["name", "description", "issue_prefix", "budget_monthly_cents", "spent_monthly_cents",
    "require_board_approval_for_new_agents", "timezone", "work_product_root", "default_language",
    "brand_color", "company_kind", "allows_code_modify"].sort(),
  row: ["id", "name", "description", "status", "pause_reason", "paused_at", "issue_prefix", "issue_counter",
    "budget_monthly_cents", "spent_monthly_cents", "require_board_approval_for_new_agents", "timezone",
    "work_product_root", "default_language", "brand_color", "company_kind", "allows_code_modify",
    "created_at", "updated_at"].sort(),
};
const keys = (v: unknown) => Object.keys(v as Record<string, unknown>).sort();

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
/** Spy that fails the test whenever validation accidentally reaches client.call. */
function throwing() {
  const calls: unknown[] = [];
  const client = {
    call: async (...args: unknown[]) => { calls.push(args); throw new Error("client.call reached"); },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const createPatch = (patch: object) => ({ ...CREATE, ...patch }) as never;
const withoutCreateKey = (key: string) => {
  const params = { ...CREATE } as Record<string, unknown>;
  delete params[key];
  return params as never;
};

describe("company.* typed RPC methods", () => {
  it("listCompanies sends omitted/present limit and validates the exact row set", async () => {
    const all = stub({ "company.list": { companies: [ROW] } });
    await expect(listCompanies(all.client, {})).resolves.toEqual({ companies: [ROW] });
    expect(all.calls[0]).toEqual({ method: "company.list", params: {}, callOpts: undefined });
    const limited = stub({ "company.list": { companies: [] } });
    await expect(listCompanies(limited.client, { limit: 10 }, { timeoutMs: 9 })).resolves.toEqual({ companies: [] });
    expect(limited.calls[0]).toEqual({ method: "company.list", params: { limit: 10 }, callOpts: { timeoutMs: 9 } });
    for (const limit of [-5, 0, 201]) { // engine-side clamp_list_limit(1..200); TS must not clamp
      const edge = stub({ "company.list": { companies: [] } });
      await listCompanies(edge.client, { limit });
      expect(edge.calls[0].params).toEqual({ limit });
    }
    expect(keys(ROW)).toEqual(KEYS.row);
  });

  it("getCompanyById/getCompanyByIssuePrefix map row and null branches with exact wire keys", async () => {
    const byId = stub({ "company.get_by_id": { company: ROW } });
    await expect(getCompanyById(byId.client, { company_id: NIL })).resolves.toEqual({ company: ROW });
    expect(byId.calls[0]).toEqual({ method: "company.get_by_id", params: { company_id: NIL }, callOpts: undefined });
    const missing = stub({ "company.get_by_id": { company: null } });
    await expect(getCompanyById(missing.client, { company_id: NIL })).resolves.toEqual({ company: null });
    const byPrefixHit = stub({ "company.get_by_issue_prefix": { company: ROW } });
    await expect(getCompanyByIssuePrefix(byPrefixHit.client, { issue_prefix: "ACM" })).resolves.toEqual({ company: ROW });
    const byPrefix = stub({ "company.get_by_issue_prefix": { company: null } });
    await expect(getCompanyByIssuePrefix(byPrefix.client, { issue_prefix: "ACM" })).resolves.toEqual({ company: null });
    expect(byPrefix.calls[0]).toEqual({
      method: "company.get_by_issue_prefix", params: { issue_prefix: "ACM" }, callOpts: undefined,
    });
  });

  it("createCompany sends all 12 required keys, including nullable fields as null", async () => {
    const { client, calls } = stub({ "company.create": { company: ROW } });
    await expect(createCompany(client, { ...CREATE, junk: 1 } as never)).resolves.toEqual({ company: ROW });
    expect(calls[0].method).toBe("company.create");
    expect(keys(calls[0].params)).toEqual(KEYS.create);
    expect(calls[0].params).toEqual(CREATE);
  });

  it("updateCompany omits undefined but preserves explicit null and valid enum values", async () => {
    const { client, calls } = stub({ "company.update": { company: ROW } });
    const patch = {
      company_id: NIL, name: "Acme2", description: null, status: "paused", timezone: null,
      work_product_root: undefined, default_language: "ko", brand_color: null,
      budget_monthly_cents: null, spent_monthly_cents: 2,
      require_board_approval_for_new_agents: null, allows_code_modify: true,
    } as const;
    await expect(updateCompany(client, { ...patch, junk: 1 } as never)).resolves.toEqual({ company: ROW });
    const expected = { ...patch } as Record<string, unknown>;
    delete expected.work_product_root;
    expect(calls[0]).toEqual({ method: "company.update", params: expected, callOpts: undefined });
    expect(keys(calls[0].params)).not.toContain("work_product_root");
    const missing = stub({ "company.update": { company: null } });
    await expect(updateCompany(missing.client, { company_id: NIL })).resolves.toEqual({ company: null });
    expect(missing.calls[0].params).toEqual({ company_id: NIL });
  });

  it("pauseCompany/resumeCompany map fenced hit and miss branches", async () => {
    const pausedRow = { ...ROW, status: "paused", pause_reason: "hold", paused_at: T0 };
    const p = stub({ "company.pause": { paused: true, company: pausedRow } });
    await expect(pauseCompany(p.client, { company_id: NIL, pause_reason: "hold" }))
      .resolves.toEqual({ paused: true, company: pausedRow });
    expect(p.calls[0]).toEqual({
      method: "company.pause", params: { company_id: NIL, pause_reason: "hold" }, callOpts: undefined,
    });
    const pm = stub({ "company.pause": { paused: false, company: null } });
    await expect(pauseCompany(pm.client, { company_id: NIL, pause_reason: null }))
      .resolves.toEqual({ paused: false, company: null });
    expect(pm.calls[0].params).toEqual({ company_id: NIL, pause_reason: null });
    const omitted = stub({ "company.pause": { paused: false, company: null } });
    await pauseCompany(omitted.client, { company_id: NIL, pause_reason: undefined });
    expect(omitted.calls[0].params).toEqual({ company_id: NIL });
    const r = stub({ "company.resume": { resumed: true, company: ROW } });
    await expect(resumeCompany(r.client, { company_id: NIL })).resolves.toEqual({ resumed: true, company: ROW });
    expect(r.calls[0]).toEqual({ method: "company.resume", params: { company_id: NIL }, callOpts: undefined });
    const rm = stub({ "company.resume": { resumed: false, company: null } });
    await expect(resumeCompany(rm.client, { company_id: NIL })).resolves.toEqual({ resumed: false, company: null });
  });

  it("nextCompanyIssueCounter maps the atomic inner two-key object and null miss", async () => {
    const hit = stub({ "company.next_issue_counter": { company: { issue_prefix: "ACM", issue_counter: 2 } } });
    await expect(nextCompanyIssueCounter(hit.client, { company_id: NIL }))
      .resolves.toEqual({ company: { issue_prefix: "ACM", issue_counter: 2 } });
    expect(hit.calls[0]).toEqual({
      method: "company.next_issue_counter", params: { company_id: NIL }, callOpts: undefined,
    });
    const miss = stub({ "company.next_issue_counter": { company: null } });
    await expect(nextCompanyIssueCounter(miss.client, { company_id: NIL })).resolves.toEqual({ company: null });
  });

  it("rejects malformed result envelopes, rows, unions, counters, and inherited keys", async () => {
    const { id: _id, ...missingId } = ROW;
    const inherited = Object.assign(Object.create({ company: null }), { extra: 1 });
    const bad: [string, unknown, (c: PaperworkEngineClient) => Promise<unknown>][] = [
      ["company.list", null, (c) => listCompanies(c, {})],
      ["company.list", {}, (c) => listCompanies(c, {})],
      ["company.list", { companies: [ROW], x: 1 }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, status: "bogus" }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, id: "bad" }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, created_at: "2026-02-30T00:00:00Z" }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, updated_at: "2026-01-01T24:00:00Z" }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, issue_counter: 1.5 }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [missingId] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, extra: 1 }] }, (c) => listCompanies(c, {})],
      ["company.list", { companies: [{ ...ROW, require_board_approval_for_new_agents: "yes" }] }, (c) => listCompanies(c, {})],
      ["company.get_by_id", inherited, (c) => getCompanyById(c, { company_id: NIL })],
      ["company.get_by_id", { company: ROW, x: 1 }, (c) => getCompanyById(c, { company_id: NIL })],
      ["company.get_by_issue_prefix", { company: 5 }, (c) => getCompanyByIssuePrefix(c, { issue_prefix: "ACM" })],
      ["company.create", { company: null }, (c) => createCompany(c, CREATE)],
      ["company.update", {}, (c) => updateCompany(c, { company_id: NIL })],
      ["company.pause", { paused: true, company: null }, (c) => pauseCompany(c, { company_id: NIL })],
      ["company.pause", { paused: false, company: ROW }, (c) => pauseCompany(c, { company_id: NIL })],
      ["company.pause", { paused: true }, (c) => pauseCompany(c, { company_id: NIL })],
      ["company.resume", { resumed: "yes", company: null }, (c) => resumeCompany(c, { company_id: NIL })],
      ["company.resume", { resumed: false, company: null, x: 1 }, (c) => resumeCompany(c, { company_id: NIL })],
      ["company.next_issue_counter", { company: { issue_prefix: "ACM" } },
        (c) => nextCompanyIssueCounter(c, { company_id: NIL })],
      ["company.next_issue_counter", { company: { issue_prefix: "ACM", issue_counter: 1, x: 1 } },
        (c) => nextCompanyIssueCounter(c, { company_id: NIL })],
      ["company.next_issue_counter", { company: { issue_prefix: "ACM", issue_counter: 1.5 } },
        (c) => nextCompanyIssueCounter(c, { company_id: NIL })],
      ["company.next_issue_counter", { company: { issue_prefix: 4, issue_counter: 1 } },
        (c) => nextCompanyIssueCounter(c, { company_id: NIL })],
    ];
    for (const [method, result, invoke] of bad) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });

  it("gates invalid params with RangeError before any client.call", async () => {
    const s = throwing();
    for (const key of KEYS.create) {
      await expect(createCompany(s.client, withoutCreateKey(key))).rejects.toThrow(RangeError);
    }
    const bad: ((c: PaperworkEngineClient) => Promise<unknown>)[] = [
      (c) => listCompanies(c, { limit: null as never }),
      (c) => listCompanies(c, { limit: 1.5 }),
      (c) => listCompanies(c, { limit: Number.NaN }),
      (c) => getCompanyById(c, { company_id: "no" }),
      (c) => getCompanyByIssuePrefix(c, { issue_prefix: "  " }),
      (c) => createCompany(c, createPatch({ name: "" })),
      (c) => createCompany(c, createPatch({ issue_prefix: "\t\n" })),
      (c) => createCompany(c, createPatch({ budget_monthly_cents: -1 })),
      (c) => createCompany(c, createPatch({ spent_monthly_cents: -1 })),
      (c) => createCompany(c, createPatch({ budget_monthly_cents: 2 ** 31 })),
      (c) => createCompany(c, createPatch({ require_board_approval_for_new_agents: 1 })),
      (c) => createCompany(c, createPatch({ allows_code_modify: "yes" })),
      (c) => createCompany(c, createPatch({ default_language: "EN" })),
      (c) => createCompany(c, createPatch({ company_kind: "Business" })),
      (c) => createCompany(c, createPatch({ description: [] })),
      (c) => updateCompany(c, { company_id: "no" }),
      (c) => updateCompany(c, { company_id: NIL, name: " " }),
      (c) => updateCompany(c, { company_id: NIL, status: "Active" as never }),
      (c) => updateCompany(c, { company_id: NIL, default_language: "xx" as never }),
      (c) => updateCompany(c, { company_id: NIL, budget_monthly_cents: -1 }),
      (c) => updateCompany(c, { company_id: NIL, spent_monthly_cents: -1 }),
      (c) => updateCompany(c, { company_id: NIL, allows_code_modify: 0 as never }),
      (c) => pauseCompany(c, { company_id: null as never }),
      (c) => pauseCompany(c, { company_id: NIL, pause_reason: [] as never }),
      (c) => resumeCompany(c, { company_id: 1 as never }),
      (c) => nextCompanyIssueCounter(c, { company_id: {} as never }),
    ];
    for (const invoke of bad) await expect(invoke(s.client)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
});

describe("classifyCompanyRpcError", () => {
  it("passes company.* failures through the heartbeat commit contract", () => {
    expect(classifyCompanyRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyCompanyRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    expect(classifyCompanyRpcError(new PaperworkEngineError("rpc_error", "m", -32601)))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
  });
});

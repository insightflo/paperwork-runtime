import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifyWikiRpcError, closeWikiEntry, listWikiEntries, markWikiEntryResolved,
  recordWikiFailure, searchRelevantWiki,
} from "../services/paperwork-engine-wiki.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const T0 = "2026-06-01T00:00:00Z";
const ENTRY = {
  id: NIL, company_id: NIL, agent_id: U1, mission_id: null,
  pattern: "pattern", cause: "cause", solution: "solution", error_code: "E",
  step_id: "step-1", frequency: 2, status: "active", audience: "agent",
  last_seen_at: T0, resolved_at: null, created_at: T0, updated_at: T0,
};
const RECORD = {
  company_id: NIL, agent_id: U1, pattern: "pattern", cause: "cause",
  solution: "solution", error_code: "E",
};
const SEARCH = { company_id: NIL, agent_id: U1, now: T0 };
const LIST = { company_id: NIL };
const IDPARAMS = { entry_id: NIL, company_id: NIL };

/** Minimal PaperworkEngineClient stub: records calls (+callOpts), returns scripted results. */
function stub(results: Record<string, unknown>) {
  const calls: { method: string; params: unknown; callOpts: unknown }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: unknown) => (
      calls.push({ method, params, callOpts }), results[method]),
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}

/** Pre-I/O gate spy: any client.call means the gate failed open. */
const throwingClient = {
  call: async () => { throw new Error("unexpected RPC call"); },
} as unknown as PaperworkEngineClient;

describe("wiki.record_failure typed RPC method", () => {
  it("maps both union branches and sends exact snake_case wire params", async () => {
    const ok = stub({ "wiki.record_failure": { recorded: true, entry: ENTRY } });
    await expect(recordWikiFailure(ok.client, { ...RECORD, junk: 1 } as never, { timeoutMs: 9 }))
      .resolves.toEqual({ recorded: true, entry: ENTRY });
    expect(ok.calls[0]).toEqual({ method: "wiki.record_failure", params: RECORD, callOpts: { timeoutMs: 9 } });
    expect(ok.calls[0].params).not.toHaveProperty("mission_id");
    expect(ok.calls[0].params).not.toHaveProperty("step_id");
    expect(ok.calls[0].params).not.toHaveProperty("audience");
    const no = stub({ "wiki.record_failure": { recorded: false } });
    await expect(recordWikiFailure(no.client, RECORD)).resolves.toEqual({ recorded: false });
  });
  it("omits undefined optional keys and preserves null/value optional keys", async () => {
    const n = stub({ "wiki.record_failure": { recorded: false } });
    await recordWikiFailure(n.client, { ...RECORD, mission_id: null, step_id: null, audience: null });
    expect(n.calls[0].params).toEqual({ ...RECORD, mission_id: null, step_id: null, audience: null });
    const v = stub({ "wiki.record_failure": { recorded: false } });
    await recordWikiFailure(v.client, { ...RECORD, mission_id: U1, step_id: "s", audience: "agent" });
    expect(v.calls[0].params).toEqual({ ...RECORD, mission_id: U1, step_id: "s", audience: "agent" });
  });
  it("rejects malformed result envelopes and rows fail-closed", async () => {
    for (const bad of [
      null, {}, { recorded: "yes" }, { recorded: false, entry: ENTRY }, { recorded: true },
      { recorded: false, x: 1 }, { recorded: true, entry: null },
      { recorded: true, entry: (({ id: _id, ...rest }) => rest)(ENTRY) },
      { recorded: true, entry: { ...ENTRY, extra: 1 } },
      { recorded: true, entry: { ...ENTRY, id: "bad" } },
      { recorded: true, entry: { ...ENTRY, frequency: 1.5 } },
      { recorded: true, entry: { ...ENTRY, status: "done" } },
      { recorded: true, entry: { ...ENTRY, audience: "public" } },
      { recorded: true, entry: { ...ENTRY, last_seen_at: "2026-02-30T00:00:00Z" } },
      { recorded: true, entry: { ...ENTRY, pattern: 7 } },
    ]) {
      const c = stub({ "wiki.record_failure": bad });
      await expect(recordWikiFailure(c.client, RECORD)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("gates invalid params before any RPC", async () => {
    for (const p of [
      { company_id: "x" }, { agent_id: 1 }, { mission_id: "x" },
      { pattern: "  " }, { cause: "" }, { solution: "\t" }, { error_code: " \n" },
      { step_id: 4 }, { audience: "public" },
    ]) {
      await expect(recordWikiFailure(throwingClient, { ...RECORD, ...p } as never)).rejects.toThrow(RangeError);
    }
  });
});

describe("wiki.search_relevant typed RPC method", () => {
  it("maps entries rows and exact params; Date now serializes to ISO", async () => {
    const { client, calls } = stub({ "wiki.search_relevant": { entries: [ENTRY] } });
    await expect(searchRelevantWiki(client, { ...SEARCH, junk: 1 } as never))
      .resolves.toEqual({ entries: [ENTRY] });
    expect(calls[0]).toEqual({ method: "wiki.search_relevant", params: SEARCH, callOpts: undefined });
    expect(calls[0].params).not.toHaveProperty("step_id");
    expect(calls[0].params).not.toHaveProperty("limit");
    const d = stub({ "wiki.search_relevant": { entries: [] } });
    await searchRelevantWiki(d.client, { ...SEARCH, now: new Date(T0), step_id: null, limit: 3 });
    expect(d.calls[0].params).toEqual({
      company_id: NIL, agent_id: U1, now: "2026-06-01T00:00:00.000Z", step_id: null, limit: 3,
    });
  });
  it("validates the exact entries envelope and every row", async () => {
    for (const bad of [
      null, {}, { entries: "x" }, { entries: [] , x: 1 }, { entries: [null] },
      { entries: [{ ...ENTRY, company_id: "bad" }] }, { entries: [{ ...ENTRY, status: "bogus" }] },
      { entries: [{ ...ENTRY, frequency: "2" }] }, { entries: [{ ...ENTRY, created_at: "bad" }] },
      { entries: [{ ...ENTRY, mission_id: "bad" }] }, { entries: [{ ...ENTRY, step_id: 3 }] },
    ]) {
      const c = stub({ "wiki.search_relevant": bad });
      await expect(searchRelevantWiki(c.client, SEARCH)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("gates uuid/now/step/limit before any RPC", async () => {
    for (const p of [
      { company_id: "x" }, { agent_id: "x" }, { now: "not-a-date" }, { now: new Date(NaN) },
      { now: "2026-06-01T24:00:00Z" }, { step_id: 5 },
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "5" },
    ]) {
      await expect(searchRelevantWiki(throwingClient, { ...SEARCH, ...p } as never)).rejects.toThrow(RangeError);
    }
  });
});

describe("wiki.list typed RPC method", () => {
  it("maps entries rows and exact params including optional limit", async () => {
    const { client, calls } = stub({ "wiki.list": { entries: [ENTRY] } });
    await expect(listWikiEntries(client, { ...LIST, junk: 1 } as never)).resolves.toEqual({ entries: [ENTRY] });
    expect(calls[0]).toEqual({ method: "wiki.list", params: LIST, callOpts: undefined });
    expect(calls[0].params).not.toHaveProperty("limit");
    const l = stub({ "wiki.list": { entries: [] } });
    await listWikiEntries(l.client, { company_id: NIL, limit: 500 }, { timeoutMs: 7 });
    expect(l.calls[0]).toEqual({
      method: "wiki.list", params: { company_id: NIL, limit: 500 }, callOpts: { timeoutMs: 7 },
    });
  });
  it("validates the exact entries envelope and row shape", async () => {
    for (const bad of [
      null, {}, { entries: {} }, { entries: [], extra: 1 },
      { entries: [{ ...ENTRY, extra: 1 }] }, { entries: [{ ...ENTRY, agent_id: "x" }] },
      { entries: [{ ...ENTRY, audience: "bogus" }] }, { entries: [{ ...ENTRY, frequency: 2.5 }] },
      { entries: [{ ...ENTRY, updated_at: "2026-06-01T00:00:60Z" }] },
    ]) {
      const c = stub({ "wiki.list": bad });
      await expect(listWikiEntries(c.client, LIST)).rejects.toMatchObject({ code: "protocol_error" });
    }
    for (const p of [{ company_id: "x" }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }]) {
      await expect(listWikiEntries(throwingClient, { ...LIST, ...p } as never)).rejects.toThrow(RangeError);
    }
  });
});

describe("wiki.mark_resolved and wiki.close typed RPC methods", () => {
  it("map both union branches and exact params", async () => {
    const r = stub({ "wiki.mark_resolved": { resolved: true, entry: { ...ENTRY, status: "resolved", resolved_at: T0 } } });
    const resolvedEntry = { ...ENTRY, status: "resolved", resolved_at: T0 };
    await expect(markWikiEntryResolved(r.client, { ...IDPARAMS, junk: 1 } as never))
      .resolves.toEqual({ resolved: true, entry: resolvedEntry });
    expect(r.calls[0]).toEqual({ method: "wiki.mark_resolved", params: IDPARAMS, callOpts: undefined });
    const rf = stub({ "wiki.mark_resolved": { resolved: false } });
    await expect(markWikiEntryResolved(rf.client, IDPARAMS)).resolves.toEqual({ resolved: false });
    const c = stub({ "wiki.close": { closed: true, entry: { ...ENTRY, status: "closed" } } });
    await expect(closeWikiEntry(c.client, IDPARAMS)).resolves.toEqual({ closed: true, entry: { ...ENTRY, status: "closed" } });
    expect(c.calls[0]).toEqual({ method: "wiki.close", params: IDPARAMS, callOpts: undefined });
    const cf = stub({ "wiki.close": { closed: false } });
    await expect(closeWikiEntry(cf.client, IDPARAMS)).resolves.toEqual({ closed: false });
  });
  it("validate result unions and gate ids before any RPC", async () => {
    for (const [method, invoke, flag] of [
      ["wiki.mark_resolved", markWikiEntryResolved, "resolved"],
      ["wiki.close", closeWikiEntry, "closed"],
    ] as const) {
      for (const bad of [
        null, {}, { [flag]: "yes" }, { [flag]: true }, { [flag]: false, entry: ENTRY },
        { [flag]: false, x: 1 }, { [flag]: true, entry: { ...ENTRY, extra: 1 } },
        { [flag]: true, entry: { ...ENTRY, status: "bogus" } },
        { [flag]: true, entry: { ...ENTRY, resolved_at: 5 } },
      ]) {
        const c = stub({ [method]: bad });
        await expect(invoke(c.client, IDPARAMS)).rejects.toMatchObject({ code: "protocol_error" });
      }
      for (const p of [{ entry_id: "x" }, { company_id: "x" }]) {
        await expect(invoke(throwingClient, { ...IDPARAMS, ...p } as never)).rejects.toThrow(RangeError);
      }
    }
  });
});

describe("strict shape ownership and classification", () => {
  it("rejects shapes whose required keys are inherited, not own", async () => {
    const inh = (protoObj: object, own: object) => Object.assign(Object.create(protoObj), own);
    const { id: _id, ...rest } = ENTRY;
    for (const [method, result, invoke] of [
      ["wiki.record_failure", inh({ recorded: false }, { extra: 1 }), (c: PaperworkEngineClient) => recordWikiFailure(c, RECORD)],
      ["wiki.record_failure", { recorded: true, entry: inh({ id: NIL }, { ...rest, extra: 1 }) },
        (c: PaperworkEngineClient) => recordWikiFailure(c, RECORD)],
      ["wiki.search_relevant", inh({ entries: [] }, { extra: 1 }), (c: PaperworkEngineClient) => searchRelevantWiki(c, SEARCH)],
      ["wiki.list", { entries: [inh({ id: NIL }, { ...rest, extra: 1 })] }, (c: PaperworkEngineClient) => listWikiEntries(c, LIST)],
      ["wiki.mark_resolved", inh({ resolved: false }, { extra: 1 }), (c: PaperworkEngineClient) => markWikiEntryResolved(c, IDPARAMS)],
      ["wiki.close", inh({ closed: false }, { extra: 1 }), (c: PaperworkEngineClient) => closeWikiEntry(c, IDPARAMS)],
    ] as const) {
      await expect(invoke(stub({ [method]: result }).client)).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
  it("classifyWikiRpcError passes through heartbeat commit outcomes", () => {
    expect(classifyWikiRpcError(new PaperworkEngineError("rpc_error", "m", -32005)))
      .toEqual({ kind: "commit_indeterminate", outcome: "indeterminate", retryable: false });
    expect(classifyWikiRpcError(new PaperworkEngineError("rpc_error", "m", -32602)))
      .toEqual({ kind: "invalid_params", outcome: "not_committed", retryable: false });
    expect(classifyWikiRpcError(new PaperworkEngineError("timeout", "m")))
      .toEqual({ kind: "unknown", outcome: "indeterminate", retryable: false });
  });
});

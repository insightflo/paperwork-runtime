import { describe, expect, it } from "vitest";
import {
  createAgentOpenWaitStore,
  globalAgentOpenWaitStore,
  type AgentOpenWait,
} from "../services/agent-open-waits.js";

function register(store: ReturnType<typeof createAgentOpenWaitStore>, overrides: Record<string, unknown> = {}) {
  return store.registerWait({
    companyId: (overrides.companyId as string) ?? "company-a",
    agentId: (overrides.agentId as string) ?? "agent-1",
    eventKey: (overrides.eventKey as string) ?? "approval-needed",
    note: (overrides.note as string) ?? "need approval for deploy",
    requestContext: (overrides.requestContext as Record<string, unknown>) ?? { runId: "run-1" },
    ttlMs: overrides.ttlMs as number | undefined,
    nowMs: overrides.nowMs as number | undefined,
  });
}

describe("createAgentOpenWaitStore — registerWait", () => {
  it("stores a waiting entry with generated id and null expiry/payload", () => {
    const store = createAgentOpenWaitStore();
    const wait = register(store, { nowMs: 1000 });
    expect(wait.status).toBe("waiting");
    expect(wait.id.length).toBeGreaterThan(0);
    expect(wait.companyId).toBe("company-a");
    expect(wait.agentId).toBe("agent-1");
    expect(wait.eventKey).toBe("approval-needed");
    expect(wait.note).toBe("need approval for deploy");
    expect(wait.requestContext).toEqual({ runId: "run-1" });
    expect(wait.expiresAtMs).toBeNull();
    expect(wait.matchedPayload).toBeNull();
    expect(wait.createdAtMs).toBe(1000);
    expect(wait.updatedAtMs).toBe(1000);
  });

  it("computes expiresAtMs from ttlMs", () => {
    const store = createAgentOpenWaitStore();
    const wait = register(store, { ttlMs: 500, nowMs: 1000 });
    expect(wait.expiresAtMs).toBe(1500);
  });

  it("rejects empty, whitespace-only eventKey/companyId/agentId", () => {
    const store = createAgentOpenWaitStore();
    for (const [field, bad] of [["eventKey", ""], ["eventKey", "  "], ["companyId", ""], ["agentId", ""]] as const) {
      expect(() => store.registerWait(waitInputLike({ [field]: bad }))).toThrow();
    }
  });
});

describe("createAgentOpenWaitStore — matchEvent", () => {
  it("resumes every waiting entry matching (companyId, eventKey) and returns them", () => {
    const store = createAgentOpenWaitStore();
    const w1 = register(store, { agentId: "agent-1", nowMs: 1000 });
    const w2 = register(store, { agentId: "agent-2", nowMs: 1100 });
    register(store, { companyId: "company-b", nowMs: 1200 });
    register(store, { eventKey: "other-event", nowMs: 1300 });

    const resumed = store.matchEvent({
      companyId: "company-a",
      eventKey: "approval-needed",
      payload: { approved: true },
      nowMs: 2000,
    });

    expect(resumed.map((w) => w.id).sort()).toEqual([w1.id, w2.id].sort());
    for (const wait of resumed) {
      expect(wait.status).toBe("resumed");
      expect(wait.matchedPayload).toEqual({ approved: true });
      expect(wait.note).toBe("need approval for deploy");
      expect(wait.requestContext).toEqual({ runId: "run-1" });
      expect(wait.updatedAtMs).toBe(2000);
    }
    expect(store.listActiveWaits("company-a", undefined, 2000).map((w) => w.eventKey)).toEqual(["other-event"]);
    // Cross-company wait with the same event key must remain untouched.
    const companyB = store.listActiveWaits("company-b", undefined, 2000);
    expect(companyB).toHaveLength(1);
    expect(companyB[0]!.status).toBe("waiting");
    expect(companyB[0]!.matchedPayload).toBeNull();
  });

  it("returns an empty array when nothing matches", () => {
    const store = createAgentOpenWaitStore();
    register(store, { nowMs: 1000 });
    expect(
      store.matchEvent({ companyId: "company-z", eventKey: "approval-needed", payload: {}, nowMs: 1001 }),
    ).toEqual([]);
  });

  it("prunes expired waits before matching (expired entries are not resumed)", () => {
    const store = createAgentOpenWaitStore();
    const expired = register(store, { ttlMs: 500, nowMs: 1000 });
    const cancelled = register(store, { nowMs: 1100 });
    expect(store.cancelWait("company-a", cancelled.id)).toBe(true);

    expect(
      store.matchEvent({ companyId: "company-a", eventKey: "approval-needed", payload: { late: true }, nowMs: 1500 }),
    ).toEqual([]);

    expect(store.listActiveWaits("company-a", undefined, 1500)).toEqual([]);
    expect(store.cancelWait("company-a", expired.id)).toBe(false);
    expect(store.cancelWait("company-a", cancelled.id)).toBe(false);
  });
});

describe("createAgentOpenWaitStore — cancelWait", () => {
  it("cancels only the company's own waiting entry", () => {
    const store = createAgentOpenWaitStore();
    const wait = register(store, { nowMs: 1000 });
    expect(store.cancelWait("company-b", wait.id)).toBe(false);
    expect(store.cancelWait("company-a", wait.id)).toBe(true);
    expect(store.cancelWait("company-a", wait.id)).toBe(false);
    expect(store.listActiveWaits("company-a", undefined, 1001)).toEqual([]);
  });

  it("returns false for an unknown wait id", () => {
    const store = createAgentOpenWaitStore();
    expect(store.cancelWait("company-a", "nope")).toBe(false);
  });

  it("refuses to cancel an already resumed wait", () => {
    const store = createAgentOpenWaitStore();
    const wait = register(store, { nowMs: 1000 });
    store.matchEvent({ companyId: "company-a", eventKey: "approval-needed", payload: {}, nowMs: 1100 });
    expect(store.cancelWait("company-a", wait.id)).toBe(false);
  });
});

describe("createAgentOpenWaitStore — listActiveWaits", () => {
  it("filters by company and optional agentId, excluding expired waits", () => {
    const store = createAgentOpenWaitStore();
    register(store, { agentId: "agent-1", nowMs: 1000 });
    const bAgent2 = register(store, { agentId: "agent-2", nowMs: 1001 });
    register(store, { companyId: "company-b", nowMs: 1002 });
    register(store, { ttlMs: 100, nowMs: 1003 });

    const at1500 = store.listActiveWaits("company-a", undefined, 1500);
    expect(at1500.map((w: AgentOpenWait) => w.agentId).sort()).toEqual(["agent-1", "agent-2"]);

    const onlyAgent2 = store.listActiveWaits("company-a", "agent-2", 1500);
    expect(onlyAgent2.map((w) => w.id)).toEqual([bAgent2.id]);
  });
});

describe("globalAgentOpenWaitStore", () => {
  it("exposes a singleton store with the same API", () => {
    const wait = globalAgentOpenWaitStore.registerWait({
      companyId: "company-singleton",
      agentId: "agent-s",
      eventKey: "evt",
      note: "n",
      requestContext: {},
    });
    expect(globalAgentOpenWaitStore.listActiveWaits("company-singleton", undefined)).toHaveLength(1);
    expect(globalAgentOpenWaitStore.cancelWait("company-singleton", wait.id)).toBe(true);
  });
});

function waitInputLike(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-a",
    agentId: "agent-1",
    eventKey: "approval-needed",
    note: "need approval for deploy",
    requestContext: { runId: "run-1" },
    ...overrides,
  } as Parameters<ReturnType<typeof createAgentOpenWaitStore>["registerWait"]>[0];
}

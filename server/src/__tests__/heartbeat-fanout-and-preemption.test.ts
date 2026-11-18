import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  enqueueParentCallbackWithFanoutBarrier,
  FANOUT_HELD_STATUS,
  FANOUT_HOP_CAP,
  maybeEnqueueParentFailureCallback,
  prepareFanoutChildWakeup,
  releaseDeferredFanoutCallbacksIfComplete,
} from "../services/heartbeat-fanout-barrier.js";
import { selectQueuedWakeupRequestIds } from "../services/quality/native-wake.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("heartbeat fanout barrier, failure auto-callback, hop cap & user-first preemption", () => {
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: Db;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("heartbeat-fanout-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
    await temp?.cleanup();
  }, 60_000);

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    const leadId = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fanout Co", issuePrefix: `FO${companyId.slice(0, 4)}`, status: "active" });
    await db.insert(agents).values([
      { id: leadId, companyId, name: "Lead", role: "ceo", adapterType: "antigravity_local", status: "idle" },
      { id: child1Id, companyId, name: "Child1", role: "engineer", adapterType: "antigravity_local", status: "idle" },
      { id: child2Id, companyId, name: "Child2", role: "researcher", adapterType: "antigravity_local", status: "idle" },
    ]);
    return { companyId, leadId, child1Id, child2Id };
  }

  it("holds parent callback while sibling active, synthesizes failure note on terminal child error, and releases together", async () => {
    const { companyId, leadId, child1Id, child2Id } = await seedCompanyAndAgents();
    const parentWakeId = randomUUID();
    const fanoutGroupId = randomUUID();
    const w1 = prepareFanoutChildWakeup({ parentWakeupId: parentWakeId, parentAgentId: leadId, targetAgentId: child1Id, fanoutGroupId });
    const w2 = prepareFanoutChildWakeup({ parentWakeupId: parentWakeId, parentAgentId: leadId, targetAgentId: child2Id, fanoutGroupId });
    expect(w1.allowed && w2.allowed).toBe(true);
    if (!w1.allowed || !w2.allowed) return;

    const wake1Id = randomUUID();
    const wake2Id = randomUUID();
    const run1Id = randomUUID();
    const run2Id = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: wake1Id, companyId, agentId: child1Id, source: "assignment", reason: "task1", status: "completed", payload: w1.payload },
      { id: wake2Id, companyId, agentId: child2Id, source: "assignment", reason: "task2", status: "claimed", payload: w2.payload },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: run1Id, companyId, agentId: child1Id, status: "succeeded", wakeupRequestId: wake1Id },
      { id: run2Id, companyId, agentId: child2Id, status: "running", wakeupRequestId: wake2Id },
    ]);
    await db.update(agentWakeupRequests).set({ runId: run1Id }).where(eq(agentWakeupRequests.id, wake1Id));
    await db.update(agentWakeupRequests).set({ runId: run2Id }).where(eq(agentWakeupRequests.id, wake2Id));

    const wrongOwner = await enqueueParentCallbackWithFanoutBarrier(db, {
      companyId,
      childAgentId: child2Id,
      childWakeupRequestId: wake1Id,
      parentAgentId: leadId,
      fanoutGroupId,
      rootWakeupRequestId: parentWakeId,
      chainOriginAgentId: leadId,
      hopCount: 1,
      kind: "reply",
      reason: "done",
      idempotencyKey: "wrong-owner",
    });
    expect(wrongOwner).toEqual({ status: "rejected_ownership" });

    const cb1 = await enqueueParentCallbackWithFanoutBarrier(db, {
      companyId,
      childAgentId: child1Id,
      childWakeupRequestId: wake1Id,
      parentAgentId: leadId,
      fanoutGroupId,
      rootWakeupRequestId: parentWakeId,
      chainOriginAgentId: leadId,
      hopCount: 1,
      kind: "reply",
      reason: "child1_ok",
      idempotencyKey: `fanout-reply:${run1Id}`,
    });
    expect(cb1.status).toBe(FANOUT_HELD_STATUS);

    await db.update(heartbeatRuns).set({ status: "failed", error: "Bearer secret_token_123456 failed" }).where(eq(heartbeatRuns.id, run2Id));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, wake2Id));

    const failCb = await maybeEnqueueParentFailureCallback(db, {
      id: run2Id, companyId, agentId: child2Id, status: "failed", wakeupRequestId: wake2Id, error: null, errorCode: null,
    });
    expect(failCb?.status).toBe("queued");

    const releasedCount = await releaseDeferredFanoutCallbacksIfComplete(db, { id: run2Id, companyId, wakeupRequestId: wake2Id });
    expect(releasedCount).toBe(1);

    const leadWakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, leadId));
    expect(leadWakeups).toHaveLength(2);
    expect(leadWakeups.every((row) => row.status === "queued")).toBe(true);
    const failureNote = leadWakeups.find((row) => row.requestKind === "fanout_failure_callback");
    expect(failureNote?.error).not.toContain("secret_token_123456");
  });

  it("enforces FANOUT_HOP_CAP = 8, blocks chainOriginAgentId cycles, and prioritizes user wakeups", async () => {
    const { companyId, leadId, child1Id } = await seedCompanyAndAgents();
    const fanoutGroupId = randomUUID();
    let payload: Record<string, unknown> = {};
    for (let hop = 1; hop <= FANOUT_HOP_CAP; hop += 1) {
      const step = prepareFanoutChildWakeup({
        parentWakeupId: randomUUID(),
        parentAgentId: hop === 1 ? leadId : child1Id,
        targetAgentId: randomUUID(),
        fanoutGroupId,
        parentPayload: payload,
      });
      expect(step.allowed).toBe(true);
      if (step.allowed) payload = step.payload;
    }
    const overCap = prepareFanoutChildWakeup({
      parentWakeupId: randomUUID(), parentAgentId: child1Id, targetAgentId: randomUUID(), fanoutGroupId, parentPayload: payload,
    });
    expect(overCap).toEqual({ allowed: false, reason: "hop_cap_exceeded", hopCount: FANOUT_HOP_CAP + 1 });

    const hop1 = prepareFanoutChildWakeup({ parentWakeupId: "root-1", parentAgentId: leadId, targetAgentId: child1Id, fanoutGroupId });
    expect(hop1.allowed).toBe(true);
    if (hop1.allowed) {
      const cycle = prepareFanoutChildWakeup({
        parentWakeupId: "child-1", parentAgentId: child1Id, targetAgentId: leadId, fanoutGroupId, parentPayload: hop1.payload,
      });
      expect(cycle).toEqual({ allowed: false, reason: "chain_origin_cycle", hopCount: 2 });
    }

    const olderAgentId = randomUUID();
    const newerUserId = randomUUID();
    const t0 = new Date("2026-11-18T00:00:00Z");
    const t1 = new Date("2026-11-18T00:01:00Z");
    await db.insert(agentWakeupRequests).values([
      { id: olderAgentId, companyId, agentId: leadId, source: "automation", triggerDetail: "system", status: "queued", requestedByActorType: "agent", requestedAt: t0 },
      { id: newerUserId, companyId, agentId: leadId, source: "on_demand", triggerDetail: "manual", status: "queued", requestedByActorType: "user", requestedAt: t1 },
    ]);
    const ordered = await selectQueuedWakeupRequestIds(db, { companyId, id: leadId }, 10);
    expect(ordered.map((r) => r.id)).toEqual([newerUserId, olderAgentId]);
  });

  it("serializes concurrent final sibling callbacks/releases via advisory xact lock without stranding held_fanout", async () => {
    const { companyId, leadId, child1Id, child2Id } = await seedCompanyAndAgents();
    const fanoutGroupId = randomUUID();
    const rootWakeId = randomUUID();
    const w1 = prepareFanoutChildWakeup({ parentWakeupId: rootWakeId, parentAgentId: leadId, targetAgentId: child1Id, fanoutGroupId });
    const w2 = prepareFanoutChildWakeup({ parentWakeupId: rootWakeId, parentAgentId: leadId, targetAgentId: child2Id, fanoutGroupId });
    if (!w1.allowed || !w2.allowed) throw new Error("unexpected");
    const wake1Id = randomUUID();
    const wake2Id = randomUUID();
    const run1Id = randomUUID();
    const run2Id = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: wake1Id, companyId, agentId: child1Id, source: "assignment", reason: "t1", status: "completed", payload: w1.payload },
      { id: wake2Id, companyId, agentId: child2Id, source: "assignment", reason: "t2", status: "completed", payload: w2.payload },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: run1Id, companyId, agentId: child1Id, status: "failed", wakeupRequestId: wake1Id },
      { id: run2Id, companyId, agentId: child2Id, status: "failed", wakeupRequestId: wake2Id },
    ]);
    await Promise.all([
      (async () => {
        await maybeEnqueueParentFailureCallback(db, { id: run1Id, companyId, agentId: child1Id, status: "failed", wakeupRequestId: wake1Id, error: "e1", errorCode: null });
        await releaseDeferredFanoutCallbacksIfComplete(db, { id: run1Id, companyId, wakeupRequestId: wake1Id });
      })(),
      (async () => {
        await maybeEnqueueParentFailureCallback(db, { id: run2Id, companyId, agentId: child2Id, status: "failed", wakeupRequestId: wake2Id, error: "e2", errorCode: null });
        await releaseDeferredFanoutCallbacksIfComplete(db, { id: run2Id, companyId, wakeupRequestId: wake2Id });
      })(),
    ]);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, leadId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import { listExceptionHuddleAuditEntries } from "../services/missions/exception-huddle-audit-query.js";

type AuditRow = {
  id: string;
  missionId: string | null;
  payload: unknown;
  createdAt: Date;
};

type Seen = { where: unknown[]; orderBy: unknown[][]; limit: number[] };

function chainDb(rows: unknown[]): { db: Db; seen: Seen } {
  const seen: Seen = { where: [], orderBy: [], limit: [] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: (condition: unknown) => { seen.where.push(condition); return chain; },
    orderBy: (...columns: unknown[]) => { seen.orderBy.push(columns); return chain; },
    limit: (value: number) => { seen.limit.push(value); return chain; },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return { db: chain as unknown as Db, seen };
}

function auditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: randomUUID(),
    missionId: randomUUID(),
    payload: {
      threadId: randomUUID(),
      decisionKind: "retry_with_guidance",
      decidedByAgentId: randomUUID(),
    },
    createdAt: new Date("2026-11-28T01:00:00.000Z"),
    ...overrides,
  };
}

describe("listExceptionHuddleAuditEntries", () => {
  it("emits newest-first ordering and preserves the database row order", async () => {
    const oldest = auditRow({
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date("2026-11-28T01:00:00.000Z"),
    });
    const newest = auditRow({
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: new Date("2026-11-28T03:00:00.000Z"),
    });
    const tiedLowId = auditRow({
      id: "00000000-0000-4000-8000-000000000003",
      createdAt: new Date("2026-11-28T02:00:00.000Z"),
    });
    const tiedHighId = auditRow({
      id: "00000000-0000-4000-8000-000000000004",
      createdAt: new Date("2026-11-28T02:00:00.000Z"),
    });
    const { db, seen } = chainDb([newest, tiedHighId, tiedLowId, oldest]);

    const entries = await listExceptionHuddleAuditEntries(db, { companyId: randomUUID() });

    expect(entries.map((entry) => entry.id)).toEqual([newest.id, tiedHighId.id, tiedLowId.id, oldest.id]);
    expect(seen.orderBy).toHaveLength(1);
    expect(seen.orderBy[0]).toEqual([desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)]);
  });

  it("filters by structured payload.threadId and extracts decision fields without narrative parsing", async () => {
    const threadId = randomUUID();
    const agentId = randomUUID();
    const matchingPayload = {
      threadId,
      decisionKind: "retry_with_guidance",
      decidedByAgentId: agentId,
      evidence: { structured: true },
    };
    const matching = auditRow({ payload: matchingPayload });
    const otherThread = auditRow({ payload: { ...matchingPayload, threadId: randomUUID() } });
    const missingThread = auditRow({ payload: { decisionKind: "escalate", decidedByAgentId: agentId } });
    const { db } = chainDb([matching, otherThread, missingThread]);

    const entries = await listExceptionHuddleAuditEntries(db, { companyId: randomUUID(), threadId });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: matching.id,
      missionId: matching.missionId,
      threadId,
      decisionKind: "retry_with_guidance",
      decidedByAgentId: agentId,
      createdAt: matching.createdAt.toISOString(),
      payload: matchingPayload,
    });
  });

  it("uses a default limit of 20 and caps explicit limits at 100 with a floor of 1", async () => {
    const initial = chainDb([]);
    await listExceptionHuddleAuditEntries(initial.db, { companyId: randomUUID() });
    expect(initial.seen.limit).toEqual([20]);

    const floored = chainDb([]);
    await listExceptionHuddleAuditEntries(floored.db, { companyId: randomUUID(), limit: 0 });
    expect(floored.seen.limit).toEqual([1]);

    const capped = chainDb([]);
    await listExceptionHuddleAuditEntries(capped.db, { companyId: randomUUID(), limit: 500 });
    expect(capped.seen.limit).toEqual([100]);
  });

  it("handles non-object payloads safely as empty structured payloads", async () => {
    const rows = [
      auditRow({ payload: null }),
      auditRow({ payload: ["not", "an", "object"] }),
      auditRow({ payload: "thread-id-as-scalar" }),
    ];
    const { db } = chainDb(rows);

    const entries = await listExceptionHuddleAuditEntries(db, { companyId: randomUUID() });

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.payload).toEqual({});
      expect(entry.threadId).toBeNull();
      expect(entry.decisionKind).toBeNull();
      expect(entry.decidedByAgentId).toBeNull();
    }
  });

  it("returns an empty array when no audit events match", async () => {
    const { db } = chainDb([]);

    await expect(listExceptionHuddleAuditEntries(db, { companyId: randomUUID() })).resolves.toEqual([]);
  });
});

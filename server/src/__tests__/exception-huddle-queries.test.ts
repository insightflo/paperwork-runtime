import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import {
  listMissionExceptionHuddles,
  summarizeMissionHuddleCounts,
} from "../services/missions/exception-huddle-queries.js";

const companyId = "company-1";
const missionId = "mission-1";

type Row = {
  threadId: string;
  channelId: string;
  title: string;
  threadStatus: string;
  threadUpdatedAt: Date;
  messageCreatedAt: Date;
  metadata: Record<string, unknown> | null;
};

function validHuddle(overrides: Record<string, unknown> = {}): ExceptionHuddleMetadata {
  return exceptionHuddleMetadataSchema.parse({
    schemaVersion: "workflow.exception-huddle.v1",
    missionId,
    workflowRunId: "run-1",
    sourceStepId: "qa-review",
    sourceIssueId: "issue-1",
    workProductLinks: ["work-product://draft"],
    participants: {
      ownerAgentId: "owner-1",
      producerAgentId: "producer-1",
      validatorAgentId: "validator-1",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  });
}

function huddleRow(input: {
  threadId: string;
  huddle?: ExceptionHuddleMetadata;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string;
  messageCreatedAt?: string;
  title?: string;
  threadStatus?: string;
}): Row {
  const updatedAt = new Date(input.updatedAt ?? "2026-11-28T01:00:00.000Z");
  return {
    threadId: input.threadId,
    channelId: `channel-${input.threadId}`,
    title: input.title ?? `[Huddle] ${input.threadId}`,
    threadStatus: input.threadStatus ?? "open",
    threadUpdatedAt: updatedAt,
    messageCreatedAt: new Date(input.messageCreatedAt ?? updatedAt),
    metadata: input.metadata !== undefined
      ? input.metadata
      : { exceptionHuddle: input.huddle ?? validHuddle() },
  };
}

function mockDb(rows: Row[]) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as Db, select, from, innerJoin, where, orderBy };
}

function statuses(result: Awaited<ReturnType<typeof listMissionExceptionHuddles>>) {
  return result.items.map((item) => item.huddle.status);
}

describe("listMissionExceptionHuddles", () => {
  it("keeps only valid nested v1 huddle metadata for the requested mission", async () => {
    const rows = [
      huddleRow({ threadId: "valid", huddle: validHuddle() }),
      huddleRow({ threadId: "other-mission", huddle: validHuddle({ missionId: "mission-2" }) }),
      huddleRow({ threadId: "malformed", metadata: { exceptionHuddle: { schemaVersion: "wrong" } } }),
      huddleRow({ threadId: "top-level-only", metadata: validHuddle() as unknown as Record<string, unknown> }),
      huddleRow({ threadId: "wrong-shape", metadata: { exceptionHuddle: "open" } }),
      huddleRow({ threadId: "null-metadata", metadata: null }),
    ];
    const harness = mockDb(rows);

    const result = await listMissionExceptionHuddles(harness.db, { companyId, missionId });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      threadId: "valid",
      channelId: "channel-valid",
      title: "[Huddle] valid",
      threadStatus: "open",
    });
    expect(result.items[0]!.huddle.missionId).toBe(missionId);
    expect(result.counts).toEqual({ open: 1, timedOut: 0, decided: 0, cancelled: 0 });
    expect(harness.select).toHaveBeenCalledTimes(1);
    expect(harness.innerJoin).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);
  });

  it("deduplicates snapshots by thread and keeps the latest valid huddle state", async () => {
    const rows = [
      huddleRow({
        threadId: "thread-1",
        huddle: validHuddle({ status: "open", currentRound: 1 }),
        messageCreatedAt: "2026-11-28T01:01:00.000Z",
      }),
      huddleRow({
        threadId: "thread-1",
        metadata: { exceptionHuddle: { schemaVersion: "malformed-newer-snapshot" } },
        messageCreatedAt: "2026-11-28T01:03:00.000Z",
      }),
      huddleRow({
        threadId: "thread-1",
        huddle: validHuddle({ status: "timed_out", currentRound: 2 }),
        messageCreatedAt: "2026-11-28T01:02:00.000Z",
      }),
    ];
    const harness = mockDb(rows);

    const result = await listMissionExceptionHuddles(harness.db, { companyId, missionId });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.threadId).toBe("thread-1");
    expect(result.items[0]!.huddle.status).toBe("timed_out");
    expect(result.items[0]!.huddle.currentRound).toBe(2);
    expect(result.counts).toEqual({ open: 0, timedOut: 1, decided: 0, cancelled: 0 });
  });

  it("computes counts before status filtering and sorts items by thread updatedAt descending", async () => {
    const rows = [
      huddleRow({ threadId: "open-old", huddle: validHuddle({ status: "open" }), updatedAt: "2026-11-28T01:01:00.000Z" }),
      huddleRow({ threadId: "decided", huddle: validHuddle({ status: "decided" }), updatedAt: "2026-11-28T01:05:00.000Z", threadStatus: "resolved" }),
      huddleRow({ threadId: "timed-out", huddle: validHuddle({ status: "timed_out" }), updatedAt: "2026-11-28T01:04:00.000Z" }),
      huddleRow({ threadId: "cancelled", huddle: validHuddle({ status: "cancelled" }), updatedAt: "2026-11-28T01:03:00.000Z", threadStatus: "resolved" }),
      huddleRow({ threadId: "open-new", huddle: validHuddle({ status: "open" }), updatedAt: "2026-11-28T01:02:00.000Z" }),
    ];

    const all = await listMissionExceptionHuddles(mockDb(rows).db, { companyId, missionId });
    expect(all.items.map((item) => item.threadId)).toEqual([
      "decided", "timed-out", "cancelled", "open-new", "open-old",
    ]);
    expect(all.counts).toEqual({ open: 2, timedOut: 1, decided: 1, cancelled: 1 });

    const filtered = await listMissionExceptionHuddles(mockDb(rows).db, {
      companyId,
      missionId,
      status: "open",
      limit: 1,
    });
    expect(filtered.items.map((item) => item.threadId)).toEqual(["open-new"]);
    expect(statuses(filtered)).toEqual(["open"]);
    expect(filtered.counts).toEqual({ open: 2, timedOut: 1, decided: 1, cancelled: 1 });
  });

  it("applies the default limit of 20 and caps explicit limits at 100", async () => {
    const rows = Array.from({ length: 105 }, (_, index) => huddleRow({
      threadId: `thread-${index}`,
      huddle: validHuddle({ status: "open" }),
      updatedAt: new Date(Date.UTC(2026, 10, 28, 1, 0, index)).toISOString(),
    }));

    const defaultResult = await listMissionExceptionHuddles(mockDb(rows).db, { companyId, missionId });
    expect(defaultResult.items).toHaveLength(20);
    expect(defaultResult.counts.open).toBe(105);

    const cappedResult = await listMissionExceptionHuddles(mockDb(rows).db, {
      companyId,
      missionId,
      limit: 500,
    });
    expect(cappedResult.items).toHaveLength(100);
    expect(cappedResult.counts.open).toBe(105);
  });
});

describe("summarizeMissionHuddleCounts", () => {
  it("counts each exact huddle status without mutating the input", () => {
    const items = [
      { huddle: validHuddle({ status: "open" }) },
      { huddle: validHuddle({ status: "timed_out" }) },
      { huddle: validHuddle({ status: "decided" }) },
      { huddle: validHuddle({ status: "cancelled" }) },
      { huddle: validHuddle({ status: "open" }) },
    ];

    expect(summarizeMissionHuddleCounts(items)).toEqual({ open: 2, timedOut: 1, decided: 1, cancelled: 1 });
    expect(items).toHaveLength(5);
  });
});

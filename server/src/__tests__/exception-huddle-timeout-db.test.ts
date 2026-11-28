import { describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  collabMessages,
  type Db,
} from "@paperclipai/db";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import { runExceptionHuddleTimeoutSweep } from "../services/missions/exception-huddle-timeout-db.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const missionId = "55555555-5555-4555-8555-555555555555";
const workflowRunId = "66666666-6666-4666-8666-666666666666";
const sourceIssueId = "77777777-7777-4777-8777-777777777777";
const ownerAgentId = "88888888-8888-4888-8888-888888888888";
const producerAgentId = "99999999-9999-4999-8999-999999999999";
const validatorAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timeoutAt = "2026-11-28T01:05:00.000Z";
const timeout = new Date(timeoutAt);
const expectedIdempotencyKey = `huddle-timeout-chair:${workflowRunId}:qa-step:${timeoutAt}`;

function huddle(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId,
    workflowRunId,
    sourceStepId: "qa-step",
    sourceIssueId,
    workProductLinks: ["work-product://draft-report"],
    participants: {
      ownerAgentId,
      producerAgentId,
      validatorAgentId,
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt,
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function envelope(openHuddle: ExceptionHuddleMetadata): Record<string, unknown> {
  return {
    exceptionHuddle: openHuddle,
    roundTurns: { "1": [], "2": [] },
    failureSummary: "QA rejected the draft",
  };
}

function selectedRow(metadata: Record<string, unknown>) {
  return { companyId, channelId, threadId, messageId, metadata };
}

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
}

function createInsertMock(calls: InsertCall[]) {
  return vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      const onConflictDoNothing = vi.fn(async () => undefined);
      calls.push({ table, values, onConflictDoNothing });
      return { onConflictDoNothing };
    }),
  }));
}

function createMockDb(rows: unknown[], updateRows: Array<{ id: string }>) {
  const selectWhere = vi.fn(async () => rows);
  const innerJoin = vi.fn(() => ({ where: selectWhere }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));

  const updateReturning = vi.fn(async () => updateRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertCalls: InsertCall[] = [];
  const tx = { update, insert: createInsertMock(insertCalls) };
  const transaction = vi.fn(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx));
  const db = {
    select,
    insert: createInsertMock(insertCalls),
    transaction,
  } as unknown as Db;

  return {
    db,
    select,
    selectWhere,
    update,
    updateSet,
    updateWhere,
    updateReturning,
    transaction,
    insertCalls,
  };
}

describe("runExceptionHuddleTimeoutSweep", () => {
  it("transitions an expired open huddle, appends a system note, and enqueues one idempotent chair wakeup", async () => {
    const open = huddle();
    const metadata = envelope(open);
    const harness = createMockDb([selectedRow(metadata)], [{ id: messageId }]);

    const result = await runExceptionHuddleTimeoutSweep(harness.db, { companyId, now: timeout });

    expect(result).toEqual({ scanned: 1, timedOut: 1, wakeupsEnqueued: 1, skipped: 0 });
    expect(harness.updateSet).toHaveBeenCalledTimes(1);
    const updateInput = harness.updateSet.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(updateInput.metadata).toEqual({
      ...metadata,
      exceptionHuddle: { ...open, status: "timed_out" },
    });

    const noteInserts = harness.insertCalls.filter((call) => call.table === collabMessages);
    expect(noteInserts).toHaveLength(1);
    expect(noteInserts[0]?.values).toMatchObject({
      companyId,
      channelId,
      threadId,
      authorType: "system",
      authorId: null,
      actionKind: "message",
      expectsReply: false,
    });

    const wakeInserts = harness.insertCalls.filter((call) => call.table === agentWakeupRequests);
    expect(wakeInserts).toHaveLength(1);
    expect(wakeInserts[0]?.values).toMatchObject({
      companyId,
      agentId: ownerAgentId,
      source: "on_demand",
      triggerDetail: "exception_huddle_timeout",
      reason: "exception_huddle_timeout_chair_decision_required",
      requestedByActorType: "system",
      requestedByActorId: null,
      idempotencyKey: expectedIdempotencyKey,
      missionId,
      issueId: sourceIssueId,
      workflowRunId,
    });
    expect(wakeInserts[0]?.values.payload).toMatchObject({
      channelId,
      threadId,
      messageId,
      missionId,
      workflowRunId,
      sourceStepId: "qa-step",
      sourceIssueId,
      timeoutAt,
    });
    expect(wakeInserts[0]?.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("leaves an open non-expired huddle untouched", async () => {
    const open = huddle();
    const harness = createMockDb([selectedRow(envelope(open))], [{ id: messageId }]);

    const result = await runExceptionHuddleTimeoutSweep(harness.db, {
      companyId,
      now: new Date(timeout.getTime() - 1),
    });

    expect(result).toEqual({ scanned: 1, timedOut: 0, wakeupsEnqueued: 0, skipped: 1 });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.insertCalls).toEqual([]);
  });

  it("enqueues zero wakeups when the CAS update loses an already-decided race", async () => {
    const open = huddle();
    const harness = createMockDb([selectedRow(envelope(open))], []);

    const result = await runExceptionHuddleTimeoutSweep(harness.db, { companyId, now: timeout });

    expect(result).toEqual({ scanned: 1, timedOut: 0, wakeupsEnqueued: 0, skipped: 1 });
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.insertCalls).toEqual([]);
  });
});

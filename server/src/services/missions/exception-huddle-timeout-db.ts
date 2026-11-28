import { and, eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  collabMessages,
  collabThreads,
  type Db,
} from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import {
  sweepTimedOutExceptionHuddles,
  type ExceptionHuddleTimeoutChairWakeup,
} from "./exception-huddle-timeout.js";

interface HuddleMessageRecord {
  companyId: string;
  channelId: string;
  threadId: string;
  messageId: string;
  metadata: Record<string, unknown>;
  huddle: ExceptionHuddleMetadata;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function huddleFingerprint(huddle: ExceptionHuddleMetadata): string {
  const { status: _status, ...identity } = huddle;
  return stableStringify(identity);
}

function openHuddleSelection(companyId?: string) {
  return and(
    eq(collabThreads.status, "open"),
    sql`(${collabMessages.metadata}->'exceptionHuddle'->>'schemaVersion') = ${'workflow.exception-huddle.v1'}`,
    sql`(${collabMessages.metadata}->'exceptionHuddle'->>'status') = ${'open'}`,
    ...(companyId ? [eq(collabThreads.companyId, companyId)] : []),
  );
}

export async function runExceptionHuddleTimeoutSweep(
  db: Db,
  scope: { companyId?: string; now?: Date },
) {
  const now = scope.now ?? new Date();
  const records = new Map<string, HuddleMessageRecord>();
  const transitionedRecords: HuddleMessageRecord[] = [];

  async function listOpenHuddles(): Promise<ExceptionHuddleMetadata[]> {
    const rows = await db.select({
      companyId: collabThreads.companyId,
      channelId: collabThreads.channelId,
      threadId: collabThreads.id,
      messageId: collabMessages.id,
      metadata: collabMessages.metadata,
    }).from(collabThreads)
      .innerJoin(collabMessages, and(
        eq(collabMessages.threadId, collabThreads.id),
        eq(collabMessages.companyId, collabThreads.companyId),
      ))
      .where(openHuddleSelection(scope.companyId));

    const huddles: ExceptionHuddleMetadata[] = [];
    for (const row of rows) {
      const metadata = row.metadata ?? {};
      const huddle = exceptionHuddleMetadataSchema.parse(metadata.exceptionHuddle);
      const record: HuddleMessageRecord = {
        companyId: row.companyId,
        channelId: row.channelId,
        threadId: row.threadId,
        messageId: row.messageId,
        metadata,
        huddle,
      };
      records.set(huddleFingerprint(huddle), record);
      huddles.push(huddle);
    }
    return huddles;
  }

  async function markTimedOut(nextState: ExceptionHuddleMetadata): Promise<boolean> {
    const record = records.get(huddleFingerprint(nextState));
    if (!record) return false;
    const metadata = { ...record.metadata, exceptionHuddle: nextState };
    const transitioned = await db.transaction(async (tx) => {
      const updated = await tx.update(collabMessages)
        .set({ metadata })
        .where(and(
          eq(collabMessages.id, record.messageId),
          eq(collabMessages.companyId, record.companyId),
          sql`(${collabMessages.metadata}->'exceptionHuddle'->>'status') = ${'open'}`,
        ))
        .returning({ id: collabMessages.id });
      if (updated.length === 0) return false;
      await tx.insert(collabMessages).values({
        companyId: record.companyId,
        channelId: record.channelId,
        threadId: record.threadId,
        authorType: "system",
        authorId: null,
        actionKind: "message",
        body: `Exception huddle timed out for ${record.huddle.sourceStepId}. Owner chair must submit a structured decision.`,
        expectsReply: false,
      });
      return true;
    });
    if (transitioned) transitionedRecords.push(record);
    return transitioned;
  }

  async function enqueueChairWakeup(wakeup: ExceptionHuddleTimeoutChairWakeup): Promise<void> {
    const record = transitionedRecords.shift();
    if (!record) throw new Error("exception huddle timeout wakeup without a transitioned huddle");
    await db.insert(agentWakeupRequests).values({
      companyId: record.companyId,
      agentId: wakeup.agentId,
      source: "on_demand",
      triggerDetail: "exception_huddle_timeout",
      reason: wakeup.reason,
      requestedByActorType: "system",
      requestedByActorId: null,
      idempotencyKey: wakeup.idempotencyKey,
      missionId: record.huddle.missionId,
      issueId: record.huddle.sourceIssueId,
      workflowRunId: record.huddle.workflowRunId,
      payload: {
        channelId: record.channelId,
        threadId: record.threadId,
        messageId: record.messageId,
        missionId: record.huddle.missionId,
        workflowRunId: record.huddle.workflowRunId,
        sourceStepId: record.huddle.sourceStepId,
        sourceIssueId: record.huddle.sourceIssueId,
        timeoutAt: record.huddle.timeoutAt,
      },
    }).onConflictDoNothing();
  }

  return sweepTimedOutExceptionHuddles({
    listOpenHuddles,
    markTimedOut,
    enqueueChairWakeup,
  }, now);
}

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  collabMessages,
  collabThreads,
  type Db,
} from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import {
  computeExceptionHuddleTelemetry,
  type ExceptionHuddleTelemetrySummary,
} from "./exception-huddle-telemetry.js";

export interface ExceptionHuddleSummaryScope {
  companyId: string;
  missionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutSnapshotEnvelopeFields(record: Record<string, unknown>): Record<string, unknown> {
  const input = { ...record };
  delete input.roundTurns;
  delete input.failureSummary;
  return input;
}

function huddleMetadataInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const envelope = withoutSnapshotEnvelopeFields(value);
  if (!isRecord(envelope.exceptionHuddle)) return envelope;

  const nested = withoutSnapshotEnvelopeFields(envelope.exceptionHuddle);
  return {
    ...nested,
    schemaVersion: nested.schemaVersion ?? envelope.schemaVersion,
  };
}

function schemaVersionCondition(): SQL {
  return sql`coalesce(
    ${collabMessages.metadata}->>'schemaVersion',
    ${collabMessages.metadata}->'exceptionHuddle'->>'schemaVersion'
  ) = 'workflow.exception-huddle.v1'`;
}

function missionCondition(missionId: string): SQL {
  return sql`coalesce(
    ${collabMessages.metadata}->'exceptionHuddle'->>'missionId',
    ${collabMessages.metadata}->>'missionId'
  ) = ${missionId}`;
}

function createdAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  return 0;
}

export async function getExceptionHuddleTelemetrySummary(
  db: Db,
  scope: ExceptionHuddleSummaryScope,
): Promise<ExceptionHuddleTelemetrySummary> {
  const conditions: SQL[] = [
    eq(collabThreads.companyId, scope.companyId),
    eq(collabMessages.companyId, scope.companyId),
    schemaVersionCondition(),
  ];
  if (scope.missionId) conditions.push(missionCondition(scope.missionId));

  const rows = await db
    .select({
      threadId: collabThreads.id,
      createdAt: collabMessages.createdAt,
      metadata: collabMessages.metadata,
    })
    .from(collabThreads)
    .innerJoin(collabMessages, eq(collabMessages.threadId, collabThreads.id))
    .where(and(...conditions))
    .orderBy(desc(collabMessages.createdAt), desc(collabMessages.id));

  const latestByThread = new Map<string, { createdAtMs: number; huddle: ExceptionHuddleMetadata }>();
  for (const row of rows) {
    const parsed = exceptionHuddleMetadataSchema.safeParse(huddleMetadataInput(row.metadata));
    if (!parsed.success) continue;
    if (scope.missionId && parsed.data.missionId !== scope.missionId) continue;

    const rowCreatedAtMs = createdAtMs(row.createdAt);
    const existing = latestByThread.get(row.threadId);
    if (!existing || rowCreatedAtMs > existing.createdAtMs) {
      latestByThread.set(row.threadId, { createdAtMs: rowCreatedAtMs, huddle: parsed.data });
    }
  }

  return computeExceptionHuddleTelemetry(
    [...latestByThread.values()].map((snapshot) => snapshot.huddle),
  );
}

import { and, desc, eq, sql } from "drizzle-orm";
import { collabMessages, collabThreads, type Db } from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
  type ExceptionHuddleStatus,
} from "@paperclipai/shared/validators/exception-huddle";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface MissionExceptionHuddleScope {
  companyId: string;
  missionId: string;
  status?: ExceptionHuddleStatus;
  limit?: number;
}

export interface MissionExceptionHuddleItem {
  threadId: string;
  channelId: string;
  title: string;
  threadStatus: string;
  huddle: ExceptionHuddleMetadata;
  updatedAt: Date;
}

export interface MissionExceptionHuddleCounts {
  open: number;
  timedOut: number;
  decided: number;
  cancelled: number;
}

type SnapshotItem = MissionExceptionHuddleItem & { snapshotAtMs: number };

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit)));
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function nestedHuddle(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).exceptionHuddle;
}

export function summarizeMissionHuddleCounts(
  items: readonly Pick<MissionExceptionHuddleItem, "huddle">[],
): MissionExceptionHuddleCounts {
  const counts: MissionExceptionHuddleCounts = { open: 0, timedOut: 0, decided: 0, cancelled: 0 };
  for (const item of items) {
    if (item.huddle.status === "open") counts.open += 1;
    else if (item.huddle.status === "timed_out") counts.timedOut += 1;
    else if (item.huddle.status === "decided") counts.decided += 1;
    else if (item.huddle.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

export async function listMissionExceptionHuddles(
  db: Db,
  scope: MissionExceptionHuddleScope,
): Promise<{ items: MissionExceptionHuddleItem[]; counts: MissionExceptionHuddleCounts }> {
  const rows = await db.select({
    threadId: collabThreads.id,
    channelId: collabThreads.channelId,
    title: collabThreads.title,
    threadStatus: collabThreads.status,
    threadUpdatedAt: collabThreads.updatedAt,
    messageCreatedAt: collabMessages.createdAt,
    metadata: collabMessages.metadata,
  })
    .from(collabMessages)
    .innerJoin(collabThreads, and(
      eq(collabMessages.threadId, collabThreads.id),
      eq(collabMessages.companyId, collabThreads.companyId),
    ))
    .where(and(
      eq(collabMessages.companyId, scope.companyId),
      eq(collabThreads.companyId, scope.companyId),
      sql`${collabMessages.metadata} -> 'exceptionHuddle' is not null`,
      sql`(${collabMessages.metadata}->'exceptionHuddle'->>'schemaVersion') = ${"workflow.exception-huddle.v1"}`,
      sql`(${collabMessages.metadata}->'exceptionHuddle'->>'missionId') = ${scope.missionId}`,
    ))
    .orderBy(desc(collabThreads.updatedAt), desc(collabMessages.createdAt));

  const latestByThread = new Map<string, SnapshotItem>();
  for (const row of rows) {
    const parsed = exceptionHuddleMetadataSchema.safeParse(nestedHuddle(row.metadata));
    if (!parsed.success || parsed.data.missionId !== scope.missionId) continue;
    const snapshotAtMs = asDate(row.messageCreatedAt).getTime();
    const existing = latestByThread.get(row.threadId);
    if (existing && existing.snapshotAtMs >= snapshotAtMs) continue;
    latestByThread.set(row.threadId, {
      threadId: row.threadId,
      channelId: row.channelId,
      title: row.title,
      threadStatus: row.threadStatus,
      huddle: parsed.data,
      updatedAt: asDate(row.threadUpdatedAt),
      snapshotAtMs,
    });
  }

  const allItems = [...latestByThread.values()]
    .map(({ snapshotAtMs: _snapshotAtMs, ...item }) => item)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  const counts = summarizeMissionHuddleCounts(allItems);
  const filtered = scope.status
    ? allItems.filter((item) => item.huddle.status === scope.status)
    : allItems;
  return { items: filtered.slice(0, normalizeLimit(scope.limit)), counts };
}

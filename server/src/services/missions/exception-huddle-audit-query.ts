import { and, desc, eq, or, sql } from "drizzle-orm";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";

const EXCEPTION_HUDDLE_EVENT_PREFIX = "exception_huddle";
const EXCEPTION_HUDDLE_DECISION_EVENT_TYPE = "exception_huddle_decision";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ExceptionHuddleAuditEntry {
  id: string;
  missionId: string | null;
  threadId: string | null;
  decisionKind: string | null;
  decidedByAgentId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

export async function listExceptionHuddleAuditEntries(
  db: Db,
  scope: { companyId: string; missionId?: string; threadId?: string; limit?: number },
): Promise<ExceptionHuddleAuditEntry[]> {
  const conditions = [
    eq(workflowTransitionEvents.companyId, scope.companyId),
    or(
      sql`starts_with(${workflowTransitionEvents.eventType}, ${EXCEPTION_HUDDLE_EVENT_PREFIX})`,
      eq(workflowTransitionEvents.eventType, EXCEPTION_HUDDLE_DECISION_EVENT_TYPE),
    ),
  ];
  if (scope.missionId) conditions.push(eq(workflowTransitionEvents.missionId, scope.missionId));
  if (scope.threadId) {
    conditions.push(sql`(${workflowTransitionEvents.payload} ->> 'threadId') = ${scope.threadId}`);
  }

  const rows = await db
    .select({
      id: workflowTransitionEvents.id,
      missionId: workflowTransitionEvents.missionId,
      payload: workflowTransitionEvents.payload,
      createdAt: workflowTransitionEvents.createdAt,
    })
    .from(workflowTransitionEvents)
    .where(and(...conditions))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(clampLimit(scope.limit));

  return rows
    .filter((row) => !scope.threadId || (isRecord(row.payload) && row.payload.threadId === scope.threadId))
    .map((row) => {
      const payload: Record<string, unknown> = isRecord(row.payload) ? row.payload : {};
      return {
        id: row.id,
        missionId: row.missionId,
        threadId: stringOrNull(payload.threadId),
        decisionKind: stringOrNull(payload.decisionKind),
        decidedByAgentId: stringOrNull(payload.decidedByAgentId),
        createdAt: row.createdAt.toISOString(),
        payload,
      };
    });
}

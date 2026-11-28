import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { settleToolQueueMetadata } from "./tool-queue-settle.js";

const TERMINAL_STEP_STATUSES = ["failed", "completed", "cancelled"] as const;
const ORPHANED_QUEUE_STATUSES = ["claimed", "queued"] as const;
const DEFAULT_SWEEP_LIMIT = 100;
export const TERMINAL_TOOL_QUEUE_SWEEP_GRACE_MS = 5 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSweepableTerminalToolQueueClaim(input: {
  metadata: unknown;
  completedAt: Date | null;
  now: Date;
  graceMs: number;
}): boolean {
  const metadata = record(input.metadata);
  if (metadata.terminalRunSettlement !== undefined) return true;
  const cutoff = input.now.getTime() - input.graceMs;
  if (input.completedAt) return input.completedAt.getTime() <= cutoff;
  const claimedAt = parseIsoTime(record(metadata.toolQueue).claimedAt);
  return claimedAt !== null && claimedAt <= cutoff;
}

/**
 * [purpose] 이미 terminal 인 step_run 에 남은 과거 toolQueue queued/claimed 잔여를 settled 로 치유한다.
 *   live running/queued 실행은 절대 건드리지 않는다. terminalRunSettlement 가 있는 행은 실행이 이미
 *   종결 정산된 사실이 구조적으로 기록됐으므로 즉시 치유하고, 그 외에는 completedAt(없으면 claimedAt)이
 *   grace 보다 오래된 행만 치유한다.
 * [idempotency] 후보 재선택 조건이 queued/claimed 에 한정되고, 각 UPDATE 도 원래 큐 상태를 CAS 조건으로
 *   다시 확인한다. settledAt 은 completedAt 이 있으면 그 시각을 그대로 사용해 owner recovery 의
 *   completedAt equality 검사와 맞춘다.
 */
export async function settleTerminalToolQueueClaims(
  db: Db,
  options: { limit?: number; now?: Date; graceMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? TERMINAL_TOOL_QUEUE_SWEEP_GRACE_MS;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 500));
  const cutoff = new Date(now.getTime() - graceMs);
  const candidates = await db.select({
    id: workflowStepRuns.id,
    metadata: workflowStepRuns.metadata,
    completedAt: workflowStepRuns.completedAt,
  })
    .from(workflowStepRuns)
    .where(and(
      inArray(workflowStepRuns.status, [...TERMINAL_STEP_STATUSES]),
      inArray(sql`${workflowStepRuns.metadata}->'toolQueue'->>'status'`, [...ORPHANED_QUEUE_STATUSES]),
      sql`(
        (${workflowStepRuns.metadata} ? 'terminalRunSettlement')
        OR (${workflowStepRuns.completedAt} IS NOT NULL AND ${workflowStepRuns.completedAt} <= ${cutoff.toISOString()}::timestamptz)
        OR ${workflowStepRuns.completedAt} IS NULL
      )`,
    ))
    .orderBy(asc(workflowStepRuns.completedAt), asc(workflowStepRuns.id))
    .limit(limit);

  let settledCount = 0;
  for (const candidate of candidates) {
    if (!isSweepableTerminalToolQueueClaim({ ...candidate, now, graceMs })) continue;
    const updated = await db.transaction(async (tx) => {
      const [locked] = await tx.select({
        status: workflowStepRuns.status,
        metadata: workflowStepRuns.metadata,
        completedAt: workflowStepRuns.completedAt,
      })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.id, candidate.id))
        .for("update", { skipLocked: true });
      if (!locked || !TERMINAL_STEP_STATUSES.includes(locked.status as typeof TERMINAL_STEP_STATUSES[number])) return false;
      if (!isSweepableTerminalToolQueueClaim({ ...locked, now, graceMs })) return false;
      const queueStatus = record(record(locked.metadata).toolQueue).status;
      if (typeof queueStatus !== "string" || !ORPHANED_QUEUE_STATUSES.includes(queueStatus as typeof ORPHANED_QUEUE_STATUSES[number])) {
        return false;
      }
      const settledAtIso = (locked.completedAt ?? now).toISOString();
      const metadata = settleToolQueueMetadata(record(locked.metadata), settledAtIso);
      await tx.update(workflowStepRuns)
        .set({ metadata })
        .where(eq(workflowStepRuns.id, candidate.id));
      return true;
    });
    if (updated) settledCount += 1;
  }
  return settledCount;
}

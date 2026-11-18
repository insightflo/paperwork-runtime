import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { redactBeforeTruncate } from "@paperclipai/adapter-utils";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import type { HeartbeatRun } from "./heartbeat-finalization/owner-capability.js";

export const FANOUT_HOP_CAP = 8;
export const FANOUT_HELD_STATUS = "held_fanout";
const ACTIVE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

export interface FanoutEnvelope {
  version: 1;
  fanoutGroupId: string;
  parentWakeupRequestId: string | null;
  parentAgentId: string;
  rootWakeupRequestId: string;
  chainOriginAgentId: string;
  hopCount: number;
  expectsReply: boolean;
  kind: "task" | "reply" | "failure_note";
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseFanoutEnvelope(payload: unknown): FanoutEnvelope | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).__fanout;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) return null;
  const fanoutGroupId = asNonEmptyString(rec.fanoutGroupId);
  const parentAgentId = asNonEmptyString(rec.parentAgentId);
  const rootWakeupRequestId = asNonEmptyString(rec.rootWakeupRequestId);
  const chainOriginAgentId = asNonEmptyString(rec.chainOriginAgentId);
  if (!fanoutGroupId || !parentAgentId || !rootWakeupRequestId || !chainOriginAgentId) return null;
  const hopCount = typeof rec.hopCount === "number" && Number.isInteger(rec.hopCount) && rec.hopCount >= 0 ? rec.hopCount : null;
  if (hopCount === null) return null;
  const expectsReply = rec.expectsReply === true || rec.expectsReply === 1;
  const kind = rec.kind === "reply" || rec.kind === "failure_note" ? rec.kind : "task";
  return {
    version: 1,
    fanoutGroupId,
    parentWakeupRequestId: asNonEmptyString(rec.parentWakeupRequestId),
    parentAgentId,
    rootWakeupRequestId,
    chainOriginAgentId,
    hopCount,
    expectsReply,
    kind,
  };
}

export type PrepareFanoutChildResult =
  | { allowed: true; envelope: FanoutEnvelope; payload: Record<string, unknown> }
  | { allowed: false; reason: "hop_cap_exceeded" | "chain_origin_cycle"; hopCount: number };

export function prepareFanoutChildWakeup(params: {
  parentWakeupId: string;
  parentAgentId: string;
  targetAgentId: string;
  fanoutGroupId: string;
  parentPayload?: unknown;
  payload?: Record<string, unknown>;
  expectsReply?: boolean;
  isReply?: boolean;
  kind?: "task" | "reply" | "failure_note";
}): PrepareFanoutChildResult {
  const parentEnv = parseFanoutEnvelope(params.parentPayload);
  const hopCount = (parentEnv?.hopCount ?? 0) + 1;
  if (hopCount > FANOUT_HOP_CAP) {
    return { allowed: false, reason: "hop_cap_exceeded", hopCount };
  }
  const chainOriginAgentId = parentEnv?.chainOriginAgentId ?? params.parentAgentId;
  const isReply = params.isReply ?? false;
  if (!isReply && parentEnv && params.targetAgentId === chainOriginAgentId) {
    return { allowed: false, reason: "chain_origin_cycle", hopCount };
  }
  const rootWakeupRequestId = parentEnv?.rootWakeupRequestId ?? params.parentWakeupId;
  const envelope: FanoutEnvelope = {
    version: 1,
    fanoutGroupId: params.fanoutGroupId,
    parentWakeupRequestId: params.parentWakeupId,
    parentAgentId: params.parentAgentId,
    rootWakeupRequestId,
    chainOriginAgentId,
    hopCount,
    expectsReply: isReply ? false : (params.expectsReply ?? true),
    kind: params.kind ?? (isReply ? "reply" : "task"),
  };
  return {
    allowed: true,
    envelope,
    payload: { ...(params.payload ?? {}), __fanout: envelope },
  };
}

export async function isFanoutGroupActive(
  db: Pick<Db, "select">,
  companyId: string,
  fanoutGroupId: string,
  excludeWakeupRequestId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      sql`${agentWakeupRequests.payload}->'__fanout'->>'fanoutGroupId' = ${fanoutGroupId}`,
      sql`coalesce(${agentWakeupRequests.payload}->'__fanout'->>'kind', 'task') = 'task'`,
      ...(excludeWakeupRequestId ? [ne(agentWakeupRequests.id, excludeWakeupRequestId)] : []),
      or(inArray(agentWakeupRequests.status, [...ACTIVE_WAKEUP_STATUSES]), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])),
    ))
    .limit(1);
  return rows.length > 0;
}

type BarrierDb = Pick<Db, "select" | "insert"> & Partial<Pick<Db, "update" | "execute" | "transaction">>;
type ReleaseDb = Pick<Db, "select" | "update"> & Partial<Pick<Db, "execute" | "transaction">>;

async function runWithFanoutLock<TDb extends { execute?: Db["execute"]; transaction?: Db["transaction"] }, T>(
  db: TDb, companyId: string, fanoutGroupId: string, fn: (tx: TDb) => Promise<T>,
): Promise<T> {
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(async (tx) => {
    const lockKey = `fanout-barrier:${companyId}:${fanoutGroupId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    return fn(tx as unknown as TDb);
  });
}

export async function enqueueParentCallbackWithFanoutBarrier(
  db: BarrierDb,
  params: {
    companyId: string; childAgentId: string; childWakeupRequestId?: string; parentAgentId: string;
    fanoutGroupId: string; rootWakeupRequestId: string; chainOriginAgentId: string; hopCount: number;
    kind: "reply" | "failure_note"; reason: string; idempotencyKey: string; error?: string | null;
    payload?: Record<string, unknown>; now?: Date;
  },
): Promise<{ status: "queued" | "held_fanout" | "duplicate"; wakeupRequestId: string } | { status: "rejected_ownership" }> {
  return runWithFanoutLock(db, params.companyId, params.fanoutGroupId, async (tx) => {
    if (params.childWakeupRequestId) {
      const [ownerRow] = await tx
        .select({ agentId: agentWakeupRequests.agentId, companyId: agentWakeupRequests.companyId })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, params.childWakeupRequestId)).limit(1);
      if (!ownerRow || ownerRow.companyId !== params.companyId || ownerRow.agentId !== params.childAgentId) {
        return { status: "rejected_ownership" };
      }
    }
    const [existing] = await tx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, params.companyId), eq(agentWakeupRequests.idempotencyKey, params.idempotencyKey)))
      .limit(1);
    if (existing) return { status: "duplicate", wakeupRequestId: existing.id };

    const activeSiblings = await isFanoutGroupActive(tx, params.companyId, params.fanoutGroupId, params.childWakeupRequestId);
    const status = activeSiblings ? FANOUT_HELD_STATUS : "queued";
    const wakeupRequestId = randomUUID();
    const now = params.now ?? new Date();
    const envelope: FanoutEnvelope = {
      version: 1,
      fanoutGroupId: params.fanoutGroupId,
      parentWakeupRequestId: params.childWakeupRequestId ?? null,
      parentAgentId: params.parentAgentId,
      rootWakeupRequestId: params.rootWakeupRequestId,
      chainOriginAgentId: params.chainOriginAgentId,
      hopCount: params.hopCount,
      expectsReply: false,
      kind: params.kind,
    };
    await tx.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: params.companyId,
      agentId: params.parentAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: params.reason,
      requestKind: params.kind === "failure_note" ? "fanout_failure_callback" : "fanout_reply_callback",
      requestedByActorType: "agent",
      requestedByActorId: params.childAgentId,
      idempotencyKey: params.idempotencyKey,
      status,
      error: params.error ?? null,
      payload: { ...(params.payload ?? {}), __fanout: envelope },
      requestedAt: now,
    });
    return { status, wakeupRequestId };
  });
}

export async function maybeEnqueueParentFailureCallback(
  db: BarrierDb,
  run: Pick<HeartbeatRun, "id" | "companyId" | "agentId" | "status" | "wakeupRequestId" | "error" | "errorCode">,
  now: Date = new Date(),
): Promise<{ status: string; wakeupRequestId?: string } | null> {
  if (!run.wakeupRequestId) return null;
  const [[freshRun], [wake]] = await Promise.all([
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).limit(1),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId)).limit(1),
  ]);
  const effectiveRun = freshRun ?? run;
  if (!TERMINAL_FAILURE_STATUSES.has(effectiveRun.status) || !wake) return null;
  const env = parseFanoutEnvelope(wake.payload);
  if (!env || !env.expectsReply || !env.parentAgentId) return null;
  const safeError = redactBeforeTruncate(
    effectiveRun.error ?? effectiveRun.errorCode ?? `Child run terminated with ${effectiveRun.status}`,
    500,
  );
  return enqueueParentCallbackWithFanoutBarrier(db, {
    companyId: effectiveRun.companyId,
    childAgentId: effectiveRun.agentId,
    childWakeupRequestId: wake.id,
    parentAgentId: env.parentAgentId,
    fanoutGroupId: env.fanoutGroupId,
    rootWakeupRequestId: env.rootWakeupRequestId,
    chainOriginAgentId: env.chainOriginAgentId,
    hopCount: env.hopCount,
    kind: "failure_note",
    reason: "fanout_child_failed",
    idempotencyKey: `failed-run:${effectiveRun.id}`,
    error: safeError,
    payload: { failedRunId: effectiveRun.id, failedAgentId: effectiveRun.agentId, status: effectiveRun.status, error: safeError },
    now,
  });
}

export async function releaseDeferredFanoutCallbacksIfComplete(
  db: ReleaseDb,
  run: Pick<HeartbeatRun, "id" | "companyId" | "wakeupRequestId">,
  now: Date = new Date(),
): Promise<number> {
  if (!run.wakeupRequestId) return 0;
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId)).limit(1);
  if (!wake) return 0;
  const env = parseFanoutEnvelope(wake.payload);
  if (!env?.fanoutGroupId) return 0;
  return runWithFanoutLock(db, wake.companyId, env.fanoutGroupId, async (tx) => {
    const stillActive = await isFanoutGroupActive(tx, wake.companyId, env.fanoutGroupId, wake.id);
    if (stillActive) return 0;
    const released = await tx
      .update(agentWakeupRequests)
      .set({ status: "queued", updatedAt: now })
      .where(and(
        eq(agentWakeupRequests.companyId, wake.companyId),
        eq(agentWakeupRequests.status, FANOUT_HELD_STATUS),
        sql`${agentWakeupRequests.payload}->'__fanout'->>'fanoutGroupId' = ${env.fanoutGroupId}`,
      ))
      .returning({ id: agentWakeupRequests.id });
    return released.length;
  });
}

/**
 * Fast-path safe hook for settleHeartbeatAfterExecution: non-fanout mission/workflow
 * runs return immediately after checking wake payload without acquiring advisory locks.
 */
export async function settleFanoutAfterHeartbeat(
  db: BarrierDb & ReleaseDb,
  run: Pick<HeartbeatRun, "id" | "companyId" | "agentId" | "status" | "wakeupRequestId" | "error" | "errorCode">,
  now: Date = new Date(),
): Promise<void> {
  if (!run.wakeupRequestId) return;
  const [wake] = await db
    .select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, run.wakeupRequestId))
    .limit(1);
  const env = parseFanoutEnvelope(wake?.payload);
  if (!env) return;
  if (env.expectsReply && TERMINAL_FAILURE_STATUSES.has(run.status)) {
    await maybeEnqueueParentFailureCallback(db, run, now);
  }
  await releaseDeferredFanoutCallbacksIfComplete(db, run, now);
}

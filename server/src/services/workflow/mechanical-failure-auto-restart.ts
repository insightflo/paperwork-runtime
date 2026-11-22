// [파일 목적] 기계적 내부 오류(workproduct_selector_stale_producer 등)로 실패한 최상위 워크플로 런에 대해
//   사람 휴먼카드 없이 최대 1회만 자동 대체 실행을 시작하는 안전망.
//   Phase A: FOR UPDATE 행 잠금 + activity_log claim 행 삽입(5분 TTL, workflow_runs 직접 UPDATE 없음) → 커밋.
//   Phase B: 커밋 후 root db로 workflowService.trigger 호출(wake-after-commit 준수),
//            실패 시 새 트랜잭션에서 대체 런 미존재 확인 후에만 claim 행 삭제.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { activityLog, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workflowService } from "./engine.js";

export const MECHANICAL_AUTO_RESTART_ERRORS: ReadonlySet<string> = new Set([
  "workproduct_selector_stale_producer",
  "artifact_contract_snapshot_stale",
  "workproduct_selector_heartbeat_mismatch",
]);

export const MECHANICAL_CLAIM_TTL_MS = 5 * 60 * 1000;
const CLAIM_ACTION = "workflow_run.mechanical_auto_restart_claim";
const RESTART_ACTION = "workflow_run.mechanical_auto_restart";

export interface MechanicalAutoRestartClaim {
  claimId: string;
  claimedAt: string;
  reasonCode: string;
  completedRunId?: string;
}

export interface MechanicalAutoRestartResult {
  restarted: boolean;
  reason: string;
  newRunId?: string;
  reasonCode?: string;
}

export function extractMechanicalFailureCode(
  steps: Array<{ status: string; metadata?: Record<string, unknown> | null }>,
): string | null {
  for (const s of steps) {
    if (s.status !== "failed") continue;
    const inv = s.metadata?.toolInvocation;
    if (typeof inv !== "object" || inv === null || Array.isArray(inv)) continue;
    const err = (inv as Record<string, unknown>).dispatchError;
    if (typeof err === "string" && MECHANICAL_AUTO_RESTART_ERRORS.has(err)) return err;
  }
  return null;
}

export function isMechanicalClaimActive(
  claim: unknown,
  nowMs = Date.now(),
): boolean {
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) return false;
  const rec = claim as Record<string, unknown>;
  if (typeof rec.completedRunId === "string" && rec.completedRunId.length > 0) return true;
  if (typeof rec.claimedAt !== "string") return false;
  const parsed = Date.parse(rec.claimedAt);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < MECHANICAL_CLAIM_TTL_MS;
}

export function stripPerRunMetadataStamps(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const {
    operatorDecisionRestart: _1,
    mechanicalAutoRestart: _2,
    mechanicalAutoRestartClaimed: _3,
    executionDefinitionVersion: _4,
    replacementAuthorityId: _5,
    replacementStart: _6,
    resumeRequestId: _7,
    resumeAuthorityVersion: _8,
    ownerPlanExecution: _9,
    ...carriedMetadata
  } = metadata ?? {};
  return carriedMetadata;
}

export function evaluateMechanicalAutoRestartEligibility(input: {
  runStatus: string;
  parentRunId: string | null;
  missionId: string | null;
  missionStatus: string | null;
  metadata: Record<string, unknown> | null;
  activeClaim?: unknown;
  hasExistingReplacement: boolean;
  hasActiveSibling: boolean;
  failedSteps: Array<{ status: string; metadata?: Record<string, unknown> | null }>;
  nowMs?: number;
}): { eligible: true; reasonCode: string } | { eligible: false; reason: string } {
  if (input.runStatus !== "failed") return { eligible: false, reason: "run_not_failed" };
  if (input.parentRunId !== null) return { eligible: false, reason: "child_run_excluded" };
  if (input.missionId && input.missionStatus !== "active") return { eligible: false, reason: "mission_not_active" };
  if (input.metadata?.mechanicalAutoRestart) return { eligible: false, reason: "max_one_auto_restart_reached" };
  if (isMechanicalClaimActive(input.activeClaim ?? input.metadata?.mechanicalAutoRestartClaimed, input.nowMs)) {
    return { eligible: false, reason: "claim_active_or_completed" };
  }
  if (input.hasExistingReplacement) return { eligible: false, reason: "replacement_already_exists" };
  if (input.hasActiveSibling) return { eligible: false, reason: "active_sibling_exists" };
  const reasonCode = extractMechanicalFailureCode(input.failedSteps);
  if (!reasonCode) return { eligible: false, reason: "not_mechanical_error" };
  return { eligible: true, reasonCode };
}

async function findExistingReplacementRunId(db: Db, companyId: string, sourceRunId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.companyId, companyId),
        sql`${workflowRuns.metadata}->'mechanicalAutoRestart'->>'sourceWorkflowRunId' = ${sourceRunId}`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export async function maybeAutoRestartMechanicalFailure(
  db: Db,
  input: { companyId: string; workflowRunId: string },
): Promise<MechanicalAutoRestartResult> {
  const claimId = randomUUID();
  const claimedAt = new Date().toISOString();

  // Phase A: lock source row with standard SQL FOR UPDATE and atomically insert activityLog claim.
  const claimed = await db.transaction(async (tx) => {
    const tdb = tx as unknown as Db;
    const [source] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
      .for("update");
    if (!source) return { ok: false as const, reason: "run_not_found" };

    const [missionRow] = source.missionId
      ? await tx.select({ status: missions.status }).from(missions).where(eq(missions.id, source.missionId)).limit(1)
      : [null];
    const [existingReplacementId, activeSiblingRows, stepRows, latestClaimRows] = await Promise.all([
      findExistingReplacementRunId(tdb, input.companyId, source.id),
      source.missionId
        ? tx
            .select({ id: workflowRuns.id })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.companyId, input.companyId),
                eq(workflowRuns.workflowId, source.workflowId),
                eq(workflowRuns.missionId, source.missionId),
                inArray(workflowRuns.status, ["pending", "running"]),
                ne(workflowRuns.id, source.id),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      tx
        .select({ status: workflowStepRuns.status, metadata: workflowStepRuns.metadata })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, source.id)),
      tx
        .select({ details: activityLog.details, createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.entityType, "workflow_run"),
            eq(activityLog.entityId, source.id),
            eq(activityLog.action, CLAIM_ACTION),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(1),
    ]);

    const latestClaim = latestClaimRows[0]
      ? { ...(latestClaimRows[0].details ?? {}), claimedAt: latestClaimRows[0].createdAt.toISOString() }
      : null;

    const verdict = evaluateMechanicalAutoRestartEligibility({
      runStatus: source.status,
      parentRunId: source.parentRunId,
      missionId: source.missionId,
      missionStatus: missionRow?.status ?? null,
      metadata: source.metadata as Record<string, unknown> | null,
      activeClaim: latestClaim,
      hasExistingReplacement: existingReplacementId !== null,
      hasActiveSibling: activeSiblingRows.length > 0,
      failedSteps: stepRows,
    });
    if (!verdict.eligible) return { ok: false as const, reason: verdict.reason };

    const [claimRow] = await tx
      .insert(activityLog)
      .values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "mechanical-failure-auto-restart",
        action: CLAIM_ACTION,
        entityType: "workflow_run",
        entityId: source.id,
        details: { claimId, claimedAt, reasonCode: verdict.reasonCode },
      })
      .returning({ id: activityLog.id });

    return { ok: true as const, source, reasonCode: verdict.reasonCode, claimLogId: claimRow.id };
  });

  if (!claimed.ok) return { restarted: false, reason: claimed.reason };

  // Phase B: strictly post-commit trigger on root db (wake-after-commit safe).
  const { source, reasonCode, claimLogId } = claimed;
  const carriedMetadata = stripPerRunMetadataStamps(source.metadata as Record<string, unknown> | null);
  try {
    const result = await workflowService.trigger(
      db,
      {
        companyId: input.companyId,
        workflowId: source.workflowId,
        missionId: source.missionId ?? undefined,
        runDate: source.runDate ?? undefined,
        triggeredBy: "mechanical_failure_auto_restart",
        triggerSource: "mechanical_auto_restart",
        metadata: {
          ...carriedMetadata,
          mechanicalAutoRestart: {
            schemaVersion: 1,
            sourceWorkflowRunId: source.id,
            reasonCode,
          },
        },
      },
      { actor: { type: "none" } },
    );

    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "mechanical-failure-auto-restart",
      action: RESTART_ACTION,
      entityType: "workflow_run",
      entityId: result.runId,
      details: { workflowId: source.workflowId, missionId: source.missionId, sourceWorkflowRunId: source.id, reasonCode },
    });

    return { restarted: true, reason: "auto_restarted", newRunId: result.runId, reasonCode };
  } catch (err) {
    // Conditional release in a fresh transaction: only remove claim row if no replacement run committed.
    await db.transaction(async (tx) => {
      const tdb = tx as unknown as Db;
      await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, source.id)).for("update");
      const existingId = await findExistingReplacementRunId(tdb, input.companyId, source.id);
      if (!existingId) {
        await tx.delete(activityLog).where(eq(activityLog.id, claimLogId));
      }
    }).catch(() => {});
    throw err;
  }
}

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, missions, workflowRuns, type Db } from "@paperclipai/db";
import type { Express } from "express";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { withOperatorRestartTransaction } from "../operator-decision-restart-transaction.js";
import { workflowService } from "./engine.js";
import { replacementOperatorEligible } from "./replacement-snapshot-guards.js";

export const OPERATOR_FALSE_COMPLETED_CORRECTION_METADATA_KEY = "operatorFalseCompletedCorrection";

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
const CARRIAGE_EXCLUDED_METADATA_KEYS = [
  OPERATOR_FALSE_COMPLETED_CORRECTION_METADATA_KEY,
  "operatorDecisionRestart",
  "executionDefinitionVersion",
  "replacementAuthorityId",
  "replacementStart",
  "resumeRequestId",
  "resumeAuthorityVersion",
  "ownerPlanExecution",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operatorUserId(actor: Express.Request["actor"]): string {
  return actor.type === "board" ? actor.userId ?? "local-board" : "unknown-operator";
}

function assertCorrectionSourceStatus(status: string): void {
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(status)) {
    throw conflict("workflow_operator_correction_run_active");
  }
  if (status !== "completed") {
    throw conflict("workflow_operator_correction_source_not_completed");
  }
}

/**
 * 운영자가 잘못 완료된 최상위 workflow run 을 명시적 사유와 함께 교정하고 같은 미션의
 * 새 run 을 시작한다. 소스 run 의 상태는 completed 로 보존하고, 교정 사실은 metadata 와
 * activity log 에만 기록한다. 모든 검사와 새 run materialization 은 root restart transaction
 * 안에서 수행해 사유 기록 없는 실행 또는 실행 없는 사유 기록이 커밋되지 않게 한다.
 */
export async function supersedeFalseCompletedWorkflowRun(db: Db, input: {
  companyId: string;
  runId: string;
  reason: unknown;
  actor: Express.Request["actor"];
}) {
  if (!replacementOperatorEligible(input.actor, input.companyId)) {
    throw forbidden("Operator access required");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw badRequest("operator correction reason is required");

  const [initial] = await db.select({ id: workflowRuns.id, missionId: workflowRuns.missionId })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)))
    .limit(1);
  if (!initial) throw notFound("Workflow run not found");
  if (!initial.missionId) throw conflict("workflow_operator_correction_mission_missing");
  const missionId = initial.missionId;

  return withOperatorRestartTransaction(db, {
    companyId: input.companyId,
    missionId,
    sourceRunId: input.runId,
  }, async (tx) => {
    const txDb = tx as unknown as Db;
    const [source] = await txDb.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, input.runId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, missionId),
      isNull(workflowRuns.parentRunId),
    )).limit(1).for("update");
    if (!source) throw notFound("Workflow run not found");
    if (source.parentStepRunId || source.triggeredBy === "workflow-step") {
      throw conflict("workflow_operator_correction_scope_invalid");
    }
    assertCorrectionSourceStatus(source.status);

    // 미션 행은 withOperatorRestartTransaction 이 같은 tx 에서 FOR UPDATE 로 잠갔다. 취소된 미션은
    // 실패로 닫고, 오완료가 mission completed 까지 전파된 경우만 아래에서 active 로 되돌린다.
    const [mission] = await txDb.select({ status: missions.status }).from(missions).where(and(
      eq(missions.id, missionId),
      eq(missions.companyId, input.companyId),
    )).limit(1);
    if (!mission) throw conflict("workflow_operator_correction_mission_missing");
    if (mission.status === "cancelled") throw conflict("workflow_operator_correction_mission_cancelled");
    const missionReopenedFromCompleted = mission.status === "completed";

    const sourceMetadata = isRecord(source.metadata) ? source.metadata : {};
    if (sourceMetadata[OPERATOR_FALSE_COMPLETED_CORRECTION_METADATA_KEY]) {
      throw conflict("workflow_operator_correction_already_applied");
    }

    const [activeReplacement] = await txDb.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, missionId),
      eq(workflowRuns.workflowId, source.workflowId),
      isNull(workflowRuns.parentRunId),
      ne(workflowRuns.id, source.id),
      or(
        inArray(workflowRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`${workflowRuns.metadata}->'operatorFalseCompletedCorrection'->>'sourceWorkflowRunId' = ${source.id}`,
      ),
    )).limit(1);
    if (activeReplacement) {
      throw conflict("workflow_operator_correction_active_replacement_exists", { workflowRunId: activeReplacement.id });
    }

    // trigger 는 같은 tx 안에서 이슈 생성 게이트와 claimPlainWorkflowStart 에게 mission status 를
    // 읽힌다 — 완료 미션이면 replacement run 을 만들기 전에 같은 tx 에서 active 로 되돌린다.
    if (missionReopenedFromCompleted) {
      const reopened = await txDb.update(missions).set({
        status: "active",
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(missions.id, missionId),
        eq(missions.companyId, input.companyId),
        eq(missions.status, "completed"),
      )).returning({ id: missions.id });
      if (!reopened.length) throw conflict("workflow_operator_correction_source_changed");
    }

    const carriedMetadata = { ...sourceMetadata };
    for (const key of CARRIAGE_EXCLUDED_METADATA_KEYS) delete carriedMetadata[key];
    const correctedAt = new Date().toISOString();
    const correctedByUserId = operatorUserId(input.actor);
    const correction = {
      schemaVersion: 1,
      reason,
      correctedByUserId,
      correctedAt,
      sourceWorkflowRunId: source.id,
      missionReopenedFromCompleted,
    };

    const fresh = await workflowService.trigger(txDb, {
      companyId: input.companyId,
      workflowId: source.workflowId,
      missionId,
      runDate: source.runDate,
      triggeredBy: "operator_correction",
      triggerSource: "operator_correction",
      metadata: {
        ...carriedMetadata,
        [OPERATOR_FALSE_COMPLETED_CORRECTION_METADATA_KEY]: correction,
      },
    }, { actor: { type: "none" } });

    const completedCorrection = {
      ...correction,
      replacementWorkflowRunId: fresh.runId,
    };
    const updated = await txDb.update(workflowRuns).set({
      metadata: {
        ...sourceMetadata,
        [OPERATOR_FALSE_COMPLETED_CORRECTION_METADATA_KEY]: completedCorrection,
      },
    }).where(and(
      eq(workflowRuns.id, source.id),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.status, "completed"),
    )).returning({ id: workflowRuns.id });
    if (!updated.length) throw conflict("workflow_operator_correction_source_changed");

    await txDb.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "user",
      actorId: correctedByUserId,
      action: "workflow_run.operator_corrected_false_completed",
      entityType: "workflow_run",
      entityId: source.id,
      details: {
        ...completedCorrection,
        workflowId: source.workflowId,
        missionId,
        replacementRunStatus: fresh.status,
      },
    });

    return {
      sourceRunId: source.id,
      replacementRunId: fresh.runId,
      runId: fresh.runId,
      missionId,
      missionReopenedFromCompleted,
      correction: completedCorrection,
      run: fresh,
    };
  });
}

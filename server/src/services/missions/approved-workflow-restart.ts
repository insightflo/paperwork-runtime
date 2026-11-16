import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, issues, operatorDecisions, workflowRuns, type Db } from "@paperclipai/db";
import type { OperatorDecisionResult } from "@paperclipai/shared/types/operator-decision";
import { conflict } from "../../errors.js";
import {
  evaluateRecoveryAdviceIdentity,
  loadRecoveryAdviceIdentityFacts,
  recoveryAdviceStoredInput,
  type RecoveryAdviceDecision,
  type RecoveryAdviceFacts,
} from "../operator-decision-recovery-advice.js";
import { sameOperatorDecisionResult, validateOperatorDecisionResult } from "../operator-decision-result.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID, WORKFLOW_RESTART_FROM_START_SCOPE } from "./workflow-restart-option.js";
import { workflowService } from "../workflow/engine.js";

const heldMessage = "이미 수행한 작업을 보존하기 위해 재시작하지 않았습니다. 현재 결정은 전체 수집 또는 처음부터 재시작할 권한과 근거를 확인해 주지 못합니다.";
export const holdUnprovenRestart = (operatorDecisionId: string): never => {
  throw conflict(heldMessage, { code: "recovery_restart_scope_unproven", operatorDecisionId });
};

/** [B4 2026-11-15] 사람이 명시적으로 '처음부터 재시작' 옵션을 선택한 해시 검증 moi 카드는
 *  재시작 권한 원본으로 인정한다. #457(2026-10-30) 이후 유일한 인정 경로였던
 *  workflow_restart_request_v1 카드의 생산자가 코드에 존재하지 않아, 실운영에서 모든 UI
 *  재시작 선택이 구조적으로 409(recovery_restart_scope_unproven)로 막혔다(2026-11-14 godsvg).
 *  보존 조건 — 실패한 최상위 소스 런만, 대체 실행 중복 금지, 결정 바인딩 일치 — 은
 *  startWorkflowRestartFromOperatorDecision 의 런타임 검증이 그대로 지킨다.
 *  변조행(저장 입력·해시 불일치)과 미허가 범위행은 여전히 홀드된다. */
function isProvenOwnerHumanRestartSelection(
  decision: RecoveryAdviceDecision,
  result: OperatorDecisionResult,
  input: { companyId: string; missionId: string; sourceWorkflowRunId: string },
): boolean {
  if (decision.sourceType !== "mission_owner_human_input"
    || decision.companyId !== input.companyId
    || decision.qualityActionId !== null || decision.qualityBinding !== null) return false;
  const original = recoveryAdviceStoredInput(decision);
  return original !== null
    && original.sourceContext.missionId === input.missionId
    && original.sourceContext.workflowRunId === input.sourceWorkflowRunId
    && original.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)
    && ["approve", "submit"].includes(result.outcome)
    && result.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID);
}

/** 재시작 선택 입장 게이트 — 회복 조언 identity 평가가 홀드 판정을 내려도, 해시로 잠긴
 *  범위(approvedScope)와 사람의 명시적 옵션 선택이 입증된 moi 카드는 통과시킨다. */
export function assertWorkflowRestartSelectionAdmission(
  decision: RecoveryAdviceDecision,
  result: OperatorDecisionResult,
  input: { companyId: string; missionId: string; sourceWorkflowRunId: string },
  facts: RecoveryAdviceFacts | null = null,
): void {
  const advice = facts !== null
    ? evaluateRecoveryAdviceIdentity({ card: decision, ...facts })
    : evaluateRecoveryAdviceIdentity({ kind: "outside_default_scope", card: decision });
  if (advice.disposition === "outside_default_scope") return;
  if (isProvenOwnerHumanRestartSelection(decision, result, input)) return;
  holdUnprovenRestart(decision.id);
}

export function assertExactBoardWorkflowRestartPolicy(
  decision: RecoveryAdviceDecision,
  result: OperatorDecisionResult,
  input: { companyId: string; missionId: string; sourceWorkflowRunId: string },
): void {
  // [B4 2026-11-15] proven moi 선택은 아래 보드 전용 형식 검사 없이 통과 — 근거는
  //   isProvenOwnerHumanRestartSelection 주석. workflow_restart_request_v1 경로는 불변.
  if (isProvenOwnerHumanRestartSelection(decision, result, input)) return;
  const original = recoveryAdviceStoredInput(decision);
  if (!original || decision.companyId !== input.companyId || decision.sourceType !== "workflow_restart_request_v1"
    || decision.requestedByAgentId !== null || decision.requestedByUserId === null
    || decision.qualityActionId !== null || decision.qualityBinding !== null
    || decision.sourceId !== input.sourceWorkflowRunId
    || original.sourceContext.missionId !== input.missionId
    || original.sourceContext.workflowRunId !== input.sourceWorkflowRunId
    || !original.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)
    || !["approve", "submit"].includes(result.outcome)
    || !result.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID)) {
    holdUnprovenRestart(decision.id);
  }
}

function assertRecoveryRestartAdvice(
  decision: RecoveryAdviceDecision,
  facts: Awaited<ReturnType<typeof loadRecoveryAdviceIdentityFacts>>,
  result: OperatorDecisionResult,
  input: { companyId: string; missionId: string; sourceWorkflowRunId: string },
): void {
  assertWorkflowRestartSelectionAdmission(decision, result, input, facts);
}

/** 보드가 구조화된 재시작 선택지를 승인한 경우에만 새 최상위 실행을 시작한다.
 *  sourceContext의 실행 ID가 권위 원본이며 카드 설명·댓글·nextAction은 읽지 않는다. */
export async function startWorkflowRestartFromOperatorDecision(db: Db, input: {
  companyId: string;
  missionId: string;
  sourceWorkflowRunId: string;
  operatorDecisionId: string;
  resolvedByUserId: string;
  issueId: string | null;
  decisionRequestHash?: string;
  decisionResult?: OperatorDecisionResult;
}) {
  const [decision] = await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.id, input.operatorDecisionId), eq(operatorDecisions.companyId, input.companyId),
  ));
  if (!decision) throw conflict("재시작 요청과 저장된 운영자 결정을 확인할 수 없습니다. 재시작은 수행되지 않았습니다.", {
    code: "workflow_restart_decision_binding_invalid", operatorDecisionId: input.operatorDecisionId,
  });
  let persistedResult: OperatorDecisionResult;
  try {
    if (!input.decisionResult || !input.decisionRequestHash
      || decision.status !== "resolved" || decision.resolvedByUserId !== input.resolvedByUserId
      || decision.issueId !== input.issueId || decision.requestHash !== input.decisionRequestHash
      || decision.result === null || !sameOperatorDecisionResult(decision.result, input.decisionResult)
      || decision.sourceContext.missionId !== input.missionId
      || decision.sourceContext.workflowRunId !== input.sourceWorkflowRunId) {
      throw new Error("restart decision binding mismatch");
    }
    const savedResultInput = {
      actionId: decision.result.actionId,
      selectedOptionIds: decision.result.selectedOptionIds,
      comment: decision.result.comment,
    };
    persistedResult = validateOperatorDecisionResult(decision.definition, savedResultInput);
    if (!sameOperatorDecisionResult(persistedResult, decision.result)
      || !sameOperatorDecisionResult(persistedResult, input.decisionResult)
      || !persistedResult.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID)) {
      throw new Error("restart result mismatch");
    }
  } catch {
    throw conflict("재시작 요청과 저장된 운영자 결정이 일치하지 않습니다. 재시작을 수행하지 않았으며 기존 작업은 보존됩니다.", {
      code: "workflow_restart_decision_binding_invalid", operatorDecisionId: input.operatorDecisionId,
    });
  }

  const facts = await loadRecoveryAdviceIdentityFacts(db, decision);
  assertRecoveryRestartAdvice(decision, facts, persistedResult, input);
  assertExactBoardWorkflowRestartPolicy(decision, persistedResult, input);

  const [source] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, input.sourceWorkflowRunId),
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    isNull(workflowRuns.parentRunId),
  )).limit(1).for("update");
  if (!source || source.status !== "failed") {
    throw conflict("workflow_restart_source_not_failed");
  }
  const [activeReplacement] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    eq(workflowRuns.workflowId, source.workflowId),
    isNull(workflowRuns.parentRunId),
    ne(workflowRuns.id, source.id),
    or(
      inArray(workflowRuns.status, ["pending", "running"]),
      sql`${workflowRuns.metadata}->'operatorDecisionRestart'->>'sourceWorkflowRunId' = ${source.id}`,
    ),
  )).limit(1);
  if (activeReplacement) {
    throw conflict("workflow_restart_active_replacement_exists", { workflowRunId: activeReplacement.id });
  }

  if (input.issueId) {
    await db.update(issues).set({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.status, "blocked"),
    ));
  }

  // [B4 2026-11-16] 새 런은 원본 런의 caller metadata(url·slug 등 실행 입력)를 계승한다.
  //   마커만으로 교체하면 {$runMetadata.*} 템플릿이 미해결 문자열로 도구에 전달된다 —
  //   실운영 algumon.com 수집 재시작(미션 421de28a)에서 첫 스텝이 원격 400으로 실패했다.
  //   제외 키는 런마다 런타임이 새로 찍는 권한·영수증 스탬프다 — 계승 시 stale 권한이거나
  //   admission/수락 검증이 거부한다: executionDefinitionVersion·replacementAuthorityId·
  //   replacementStart(createAdmittedWorkflowRun 계열 거부), resumeRequestId·
  //   resumeAuthorityVersion(resume 수락 검증 발동), ownerPlanExecution(owner intent 펜스),
  //   operatorDecisionRestart(구 마커 — activeReplacement 중복 검사를 새 바인딩으로 유지).
  const {
    operatorDecisionRestart: _priorRestartMarker,
    executionDefinitionVersion: _definitionStamp,
    replacementAuthorityId: _replacementAuthority,
    replacementStart: _replacementReceipt,
    resumeRequestId: _resumeRequestId,
    resumeAuthorityVersion: _resumeAuthorityVersion,
    ownerPlanExecution: _ownerPlanStamp,
    ...carriedMetadata
  } = source.metadata ?? {};
  const result = await workflowService.trigger(db, {
    companyId: input.companyId,
    workflowId: source.workflowId,
    missionId: input.missionId,
    runDate: source.runDate,
    triggeredBy: "operator_decision_approval",
    triggerSource: "operator_decision",
    metadata: {
      ...carriedMetadata,
      operatorDecisionRestart: {
        schemaVersion: 1,
        operatorDecisionId: input.operatorDecisionId,
        sourceWorkflowRunId: source.id,
      },
    },
  }, { actor: { type: "none" } });

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "user",
    actorId: input.resolvedByUserId,
    action: "workflow_run.created",
    entityType: "workflow_run",
    entityId: result.runId,
    details: {
      workflowId: source.workflowId,
      missionId: input.missionId,
      sourceWorkflowRunId: source.id,
      operatorDecisionId: input.operatorDecisionId,
      trigger: "operator_decision_restart_from_start",
    },
  });
  return result;
}

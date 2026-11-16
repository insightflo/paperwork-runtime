import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, issueComments, issues, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { normalizeSystemLanguage, type SystemLanguage } from "./missions/system-language.js";
import { guardQualityWrite } from "./quality/write-guard.js";
import { sameOperatorDecisionResult, validateOperatorDecisionResult } from "./operator-decision-result.js";
import {
  assertOwnerHumanDecisionCurrent,
  assertTargetSnapshotCurrent,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  readTargetSnapshot,
} from "./operator-decision-currentness.js";
import type { operatorDecisionReadService } from "./operator-decisions-read.js";
import { startApprovedRevisionRun } from "./workflow/approved-revision-start.js";
import { resumeRunFromOperatorDecisionInsideSerialization, TERMINAL_RESUME_OPTION_ID } from "./missions/terminal-resume-from-decision.js";
import {
  withResumeSerialization,
  type ResumeMutationTransaction,
  type ResumeSerializationContext,
} from "./workflow/resume/serialization.js";
import { assertExactBoardWorkflowRestartPolicy, assertWorkflowRestartSelectionAdmission,
  startWorkflowRestartFromOperatorDecision } from "./missions/approved-workflow-restart.js";
import { isOwnerHumanRestartCandidate, loadRecoveryAdviceIdentityFacts,
  relaxedRestartCommentDefinition, type RecoveryAdviceDecision } from "./operator-decision-recovery-advice.js";
import { lockQaRecoveryCollectionAdmission } from "./operator-decision-qa-recovery-admission.js";
import { withOperatorRestartTransaction } from "./operator-decision-restart-transaction.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./missions/workflow-restart-option.js";

 type OperatorDecisionResolutionDependencies = {
  read: Pick<ReturnType<typeof operatorDecisionReadService>, "getRequired">;
  conflictFor: (id: string, status: string, message?: string) => ReturnType<typeof conflict>;
};

// [delivery bridge] definition.options × result.selectedOptionIds 를 한국어 라벨+영어 식별자로 해석한다.
//   규칙 8: 이 표시용 해석은 권위가 아니며, 권위는 operator_decisions.result + activity log 에 있다.
function resolveSelectedOptions(
  definition: CreateOperatorDecisionInput["definition"],
  selectedOptionIds: readonly string[],
): { id: string; label: string; description: string | null }[] {
  const byId = new Map(definition.options.map((option) => [option.id, option]));
  return selectedOptionIds
    .map((optionId) => {
      const option = byId.get(optionId);
      return option
        ? { id: option.id, label: option.label, description: option.description }
        : { id: optionId, label: optionId, description: null };
    });
}

// [delivery bridge] resolve 직후 이슈에 남는 시스템 코멘트(저자 null). 이미 running인 런도 다음 실행에서
//   brief 의 recentIssueComments 로 이 결정을 본다. 삽입 실패는 resolve 를 깨지 않는다(display 계층).
async function insertOperatorDecisionResolvedComment(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    operatorDecisionId: string; language: SystemLanguage;
    selectedOptions: { id: string; label: string; description: string | null }[];
    anchorIssueStatus: string | null;
  },
): Promise<void> {
  const selectionLines = input.selectedOptions.map((option) =>
    `- 선택: ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  // [B5 2026-11-15] 종결(done/cancelled) 이슈 컨텍스트에서는 "다음 실행자가 따른다"는 안내가
  //   거짓이 된다 — 후속이 없음과 복구 방법(이슈 재오픈·새 카드)을 명시해 200 승인이
  //   무동작으로 끝나지 않게 한다(2026-11-14 RES-11444 사례).
  const terminalAnchor = input.anchorIssueStatus !== null
    && ["done", "cancelled"].includes(input.anchorIssueStatus);
  const nextActionLine = terminalAnchor
    ? input.language === "ko"
      ? `- 다음 행동: 연결 이슈가 종결(${input.anchorIssueStatus})되어 자동 후속 실행이 없습니다. 결정 기록은 보존되며, 진행이 필요하면 이슈를 재오픈하거나 새 카드로 지시해 주세요.`
      : `- Next action: the linked issue is terminal (${input.anchorIssueStatus}) so no automated follow-up will run (연결 이슈가 종결되어 자동 후속 실행이 없습니다). The record is preserved; reopen the issue or issue a new card to proceed.`
    : input.language === "ko"
      ? "- 다음 행동: 다음 실행자는 이 결정을 우선 지시로 따른다. 선택 기록은 실행 완료를 뜻하지 않습니다."
      : "- Next action: the next executor follows this decision as the priority instruction (다음 실행자는 이 결정을 우선 지시로 따른다.). A recorded selection does not mean execution is complete.";
  const body = [
    "## 운영자 결정 반영 (operator decision resolved)",
    ...selectionLines,
    `- operatorDecisionId: ${input.operatorDecisionId}`,
    nextActionLine,
  ].join("\n");
  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      body,
    });
  } catch (error) {
    logger.warn({
      msg: "Failed to insert operator-decision resolved system comment",
      operatorDecisionId: input.operatorDecisionId,
      issueId: input.issueId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}

export function operatorDecisionResolutionWriteService(
  db: Db,
  { read, conflictFor }: OperatorDecisionResolutionDependencies,
) {
  async function resolve(id: string, rawInput: unknown, resolvedByUserId: string) {
    const before = await db.select({ ...getTableColumns(operatorDecisions), defaultLanguage: sql<string | null>`(select ${companies.defaultLanguage} from ${companies} where ${companies.id} = ${operatorDecisions.companyId})` }).from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    // [T5] Quality 연결 결정은 전용 경로로만: 실제 컬럼 연결(qualityActionId) 기준.
    await guardQualityWrite(db, { companyId: before.companyId, subject: "decision", subjectId: id, operation: "resolve" });
    // [카드 표시 결함 ③] 검증메모 대상(pending 재시작 후보) 카드의 '결정 사유 필수' 저장 계약이
    //   "." 자리채움을 강요했다 — 표시 오버레이와 같은 규칙으로 사유를 선택 입력으로 완화하고,
    //   제출된 "." 자리채움은 무사유(null)로 정규화한다. 저장 행·requestHash·비대상 카드는 불변.
    const validateRelaxed = (card: RecoveryAdviceDecision) => {
      const validated = validateOperatorDecisionResult(relaxedRestartCommentDefinition(card), rawInput);
      return isOwnerHumanRestartCandidate(card) && validated.comment === "."
        ? { ...validated, comment: null } : validated;
    };
    const result = validateRelaxed(before);
    const directResumeSelected = result.outcome === "submit"
      && result.selectedOptionIds.includes(TERMINAL_RESUME_OPTION_ID);
    const directRestartSelected = (result.outcome === "approve" || result.outcome === "submit")
      && result.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID);
    const directCommandSelected = directResumeSelected || directRestartSelected;
    if (directResumeSelected && (!before.sourceContext.missionId || !before.sourceContext.workflowRunId)) {
      throw conflict("resume_scope_missing");
    }
    if (directRestartSelected && (!before.sourceContext.missionId || !before.sourceContext.workflowRunId)) {
      throw conflict("workflow_restart_scope_missing");
    }
    if (before.status === "pending" && !before.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계가 없어 결정할 수 없습니다. 요청자에게 정보 보완을 요구해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

    const resolveInsideTransaction = async (
      tx: ResumeMutationTransaction,
      resumeContext?: ResumeSerializationContext,
    ) => {
      const now = new Date();
      if (before.status === "pending" && directRestartSelected) {
        const [observed] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id));
        if (observed?.status === "resolved" && sameOperatorDecisionResult(observed.result, result)) return false;
      }
      const collectionAdmission = await lockQaRecoveryCollectionAdmission({ tx, before, result, rawInput, conflictFor });
      if (collectionAdmission?.kind === "replayed") return false;
      if (before.status === "pending") await assertOwnerHumanDecisionCurrent(tx, before, { allowTerminalAnchor: true });
      if (before.status === "pending" && directRestartSelected) {
        const [current] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id)).for("update");
        if (current?.status === "resolved" && sameOperatorDecisionResult(current.result, result)) return false;
        if (!current || current.status !== "pending") throw conflictFor(id, current?.status ?? "missing");
        if (current.requestHash !== before.requestHash) throw conflict("Operator decision changed while it was being resolved", {
          code: "operator_decision_binding_changed", operatorDecisionId: id,
        });
        const currentResult = validateRelaxed(current);
        if (!sameOperatorDecisionResult(currentResult, result)) throw conflict("Operator decision result no longer matches the submitted selection", {
          code: "operator_decision_binding_changed", operatorDecisionId: id,
        });
        if (!current.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)) {
          throw conflict("workflow_restart_scope_missing");
        }
        if (!current.sourceContext.missionId || !current.sourceContext.workflowRunId) {
          throw conflict("workflow_restart_scope_missing");
        }
        const targetSnapshot = readTargetSnapshot(current.sourceContext);
        if (targetSnapshot) await assertTargetSnapshotCurrent(tx, id, current.companyId, targetSnapshot,
          current.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE ? "mission_alive" : "exact");
        const facts = await loadRecoveryAdviceIdentityFacts(tx as unknown as Db, current);
        assertWorkflowRestartSelectionAdmission(current, currentResult, {
          companyId: current.companyId, missionId: current.sourceContext.missionId,
          sourceWorkflowRunId: current.sourceContext.workflowRunId,
        }, facts);
        assertExactBoardWorkflowRestartPolicy(current, currentResult, {
          companyId: current.companyId, missionId: current.sourceContext.missionId,
          sourceWorkflowRunId: current.sourceContext.workflowRunId,
        });
      }
      const updated = await tx.update(operatorDecisions).set({
        status: "resolved",
        result,
        resolvedByUserId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        const current = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
          .then((rows) => rows[0] ?? null);
        if (current?.status === "resolved" && sameOperatorDecisionResult(current.result, result)) return false;
        throw conflictFor(id, current?.status ?? "missing");
      }
      // [currentness gate] CAS 성공(첫 적용) 경로에서만 재검증한다 — 이미 확정된 결정의 멱등 replay
      //   (applied=false)는 스냅샷과 무관하게 그대로 둔다. throw 시 트랜잭션이 롤백되어 카드는 pending 유지.
      const targetSnapshot = readTargetSnapshot(updated.sourceContext);
      if (targetSnapshot) {
        // [moi currentness 2026-11-08] moi 카드는 mission_alive 정책 — 식별자 소멸만 409.
        //   앵커 종결은 정상 churn 이므로 사람 resolve 를 막지 않는다(2026-11-07 남발: 앵커 종결 →
        //   resolve 409 + sweep 취소 → 사람이 답할 새 없이 5분마다 재발행).
        await assertTargetSnapshotCurrent(tx, id, updated.companyId, targetSnapshot,
          updated.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE ? "mission_alive" : "exact");
      }
      let continuationId: string | null = null;
      if (updated.continuationMode === "issue_current_assignee" && !directCommandSelected) {
        // [B5 2026-11-15] 종결(done/cancelled) 이슈에 묶인 카드 승인은 200만 남기고 후속이 없는
        //   무동작이었다(continuation pending 생성 → worker가 issue_terminal로 block,
        //   2026-11-14 RES-11444·RES-11442 사례). resolve 트랜잭션에서 종결을 즉시 반영해
        //   같은 응답의 continuation 상태·재시도 안내가 처음부터 정직하게 나오게 한다.
        //   pending 경로·워커 계약(lease/block)과 이슈 소멸(issue_missing)은 불변.
        const anchorStatus = updated.issueId
          ? await tx.select({ status: issues.status }).from(issues)
            .where(and(eq(issues.id, updated.issueId), eq(issues.companyId, updated.companyId)))
            .then((rows) => rows[0]?.status ?? null)
          : null;
        const terminalAnchor = anchorStatus !== null && ["done", "cancelled"].includes(anchorStatus);
        continuationId = await tx.insert(operatorDecisionContinuations).values({
          companyId: updated.companyId,
          operatorDecisionId: id,
          issueId: updated.issueId,
          state: terminalAnchor ? "blocked" : "pending",
          errorCode: terminalAnchor ? "issue_terminal" : null,
          nextAttemptAt: now,
        }).returning({ id: operatorDecisionContinuations.id }).then((rows) => rows[0]!.id);
        if (terminalAnchor) {
          await tx.insert(activityLog).values({
            companyId: updated.companyId,
            actorType: "system",
            actorId: "operator-decision-continuation-worker",
            action: "operator_decision.continuation_blocked",
            entityType: "operator_decision",
            entityId: id,
            details: {
              schemaVersion: 1,
              operatorDecisionId: id,
              continuationId,
              generation: 1,
              attempt: 0,
              targetAgentId: null,
              wakeupRequestId: null,
              effectiveStatus: "blocked",
              errorCode: "issue_terminal",
              blockedAtResolve: true,
            },
          });
        }
      }
      await tx.insert(activityLog).values({
        companyId: updated.companyId,
        actorType: "user",
        actorId: resolvedByUserId,
        action: "operator_decision.resolved",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          actionId: result.actionId,
          outcome: result.outcome,
          selectedOptionIds: result.selectedOptionIds,
          commentPresent: result.comment !== null,
          resolvedByUserId,
          resolvedAt: now.toISOString(),
          issueId: updated.issueId,
          continuationId,
        },
      });
      if (directRestartSelected) {
        if (!updated.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)) {
          throw conflict("workflow_restart_scope_missing");
        }
        if (!updated.sourceContext.missionId || !updated.sourceContext.workflowRunId) {
          throw conflict("workflow_restart_scope_missing");
        }
        await startWorkflowRestartFromOperatorDecision(tx as unknown as Db, {
          companyId: updated.companyId,
          missionId: updated.sourceContext.missionId,
          sourceWorkflowRunId: updated.sourceContext.workflowRunId,
          operatorDecisionId: updated.id,
          resolvedByUserId,
          issueId: updated.issueId,
          decisionRequestHash: updated.requestHash,
          decisionResult: updated.result ?? undefined,
        });
      }
      if (directResumeSelected) {
        if (!resumeContext || !updated.sourceContext.missionId || !updated.sourceContext.workflowRunId) {
          throw conflict("resume_scope_missing");
        }
        await resumeRunFromOperatorDecisionInsideSerialization(resumeContext, {
          operatorDecisionId: id,
          resolvedByUserId,
          companyId: updated.companyId,
          missionId: updated.sourceContext.missionId,
          workflowRunId: updated.sourceContext.workflowRunId,
        });
      }
      return true;
    };
    const applied = directResumeSelected
      ? await withResumeSerialization(db, {
        companyId: before.companyId,
        missionId: before.sourceContext.missionId!,
        runId: before.sourceContext.workflowRunId!,
      }, (context) => resolveInsideTransaction(context.tx, context))
      : directRestartSelected
        ? await withOperatorRestartTransaction(db, { companyId: before.companyId,
          missionId: before.sourceContext.missionId!, sourceRunId: before.sourceContext.workflowRunId! }, resolveInsideTransaction)
        : await db.transaction((tx) => resolveInsideTransaction(tx));
    const decision = await read.getRequired(id);
    // [B5] 코멘트 안내·승인 파생 가드 모두 이슈 종결 여부로 갈린다 — 커밋 후 한 번만 읽어 공유한다.
    //   이슈가 삭제된 경우 decision.issueId 는 FK(set null) 로 비어 자연 스킵되고, 읽기 실패는
    //   null(종결 미확인)로 둬 승인 후속을 억제하지 않는다.
    let anchorIssueStatus: string | null = null;
    if (applied && decision.issueId) {
      anchorIssueStatus = await db.select({ status: issues.status }).from(issues)
        .where(and(eq(issues.id, decision.issueId), eq(issues.companyId, decision.companyId)))
        .then((rows) => rows[0]?.status ?? null)
        .catch(() => null);
      // [delivery bridge] applied(첫 적용)에만 코멘트를 남긴다 — replay 는 이미 코멘트가 존재한다.
      await insertOperatorDecisionResolvedComment(db, {
        companyId: decision.companyId,
        issueId: decision.issueId,
        operatorDecisionId: id, language: normalizeSystemLanguage(before.defaultLanguage),
        selectedOptions: resolveSelectedOptions(decision.definition, result.selectedOptionIds),
        anchorIssueStatus,
      });
    }
    const anchorTerminal = anchorIssueStatus !== null && ["done", "cancelled"].includes(anchorIssueStatus);
    // 직접 복구 명령은 같은 resolve에서 이미 정확한 대상 실행을 만들거나 재개했다.
    // 일반 승인 후처리까지 실행하면 별도 revision run이 중복 시작될 수 있다.
    // [B5 dead-anchor guard] 종결 앵커에 묶인 카드의 승인 파생(revision run)은 실행하지 않는다 —
    //   경합 창에서 사람이 닫힌 문맥의 카드에 답한 경우다. resolve·결정 기록은 유지하고
    //   (continuation 은 트랜잭션 안에서 이미 issue_terminal 로 blocked) 스킵 사유만 activity 에 남긴다.
    if (applied && !directCommandSelected && result.outcome === "approve" && decision.sourceContext.missionId) {
      const missionId = decision.sourceContext.missionId;
      if (anchorTerminal) {
        try {
          await db.insert(activityLog).values({
            companyId: decision.companyId,
            actorType: "system",
            actorId: "operator-decision-resolution",
            action: "operator_decision.approved_revision_skipped",
            entityType: "operator_decision",
            entityId: id,
            details: {
              schemaVersion: 1,
              operatorDecisionId: id,
              reason: "anchor-issue-terminal",
              issueId: decision.issueId,
              issueStatus: anchorIssueStatus,
              missionId,
            },
          });
        } catch (error) {
          logger.warn({ err: error, operatorDecisionId: id, missionId },
            "failed to record approved-revision skip on terminal anchor");
        }
      } else {
        void startApprovedRevisionRun(db, { companyId: decision.companyId, missionId })
          .catch((err) => logger.warn({ err, operatorDecisionId: id, missionId },
            "approved revision start after decision resolve failed"));
      }
    }
    return { decision, applied, continuation: decision.continuation };
  }

  return { resolve };
}

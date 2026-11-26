// server/src/services/workflow/tool-failure-owner-action-closeout.ts
//
// [tool-failure Owner Action 상황 해소 자동 종결] 툴 스텝 실패로 만들어진 오너 액션 카드
// (`[Owner Action] Tool step failed`, link event `owner_tool_recovery_target_v1`)가 더 이상
// 열린 복구 요청이 아닐 때 자동으로 닫는다. 삭제·숨김 없음 — 상태 전환 + 표시 댓글 + 감사 로그.
//   (1) 링크된 stepRun 이 completed — 같은 스텝이 재시도/재실행으로 성공했다(superseded) → done.
//   (2) 런 completed — 카드가 묻는 회복 대상 런이 끝났다 → done.
//   (3) 런 cancelled — 취소 결정이 우선한다 → cancelled.
//   failed/aborted/timed-out 종결과 아직 failed 인 스텝은 카드가 여전히 유효한 에스컬레이션이므로
//   유지한다. 판정은 구조화된 상태(stepRun.status, run.status)만 쓴다(자연어 불가).
//   툴 실패 카드가 아닌 오너 액션(source issue 복구 unblock 등)은 link event 가 없어 건드리지 않는다.
//   [결정 카드 정리] 닫힌 카드에 앵커된(operatorDecisions.issueId = 카드 이슈) pending 사람 입력 카드는 같은
//   패스에서 cancelled 처리한다 — 종결 앵커에 매달린 카드는 응답해도 후속이 없고 미션당 pending 1장
//   유니크 인덱스를 계속 점유한다. 판정은 구조화된 컬럼만 쓰고 품질 연결 카드(qualityActionId)는
//   전용 경로(T5) 계약대로 제외한다. 취소는 continuation/wakeup 을 만들지 않는다.
// 호출부: (a) workflow sync 꼬리(running→completed 전환·스텝 성공을 본 패스에서 반영)와
//   (b) run 취소 정리(cleanupCancelledWorkflowRun — 취소된 run 은 sync 본문을 소유하지 않으므로).
// [규칙 7-8] 새 실행 경로 없음 — 기존 issueService.update/addComment + activity log 만 호출.
//   호출부는 try/catch 로 감싼다. 실패한 카드는 다음 호출에 재시도된다.

import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { activityLog, issues, operatorDecisions, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { RECOVERY_UNBLOCK_ORIGIN_KIND } from "../missions/recovery-ownership-guard.js";
import { loadCompanySystemLanguage, type SystemLanguage } from "../missions/system-language.js";

export const TOOL_RECOVERY_TARGET_EVENT_TYPE = "owner_tool_recovery_target_v1";
export const TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION = "mission.owner_action_settled_from_tool_recovery";
export const TOOL_FAILURE_DECISION_CANCEL_ACTION = "operator_decision.cancelled";
const CLOSEOUT_ACTOR_ID = "tool-failure-owner-action-closeout";
// 기존 스윕(stale sweep·dead-card sweep)과 같은 `system:` 주체 식별자 계약 — 카드 뷰가 그대로 표시한다.
const DECISION_CANCEL_ACTOR_ID = "system:tool-failure-owner-action-closeout";
const DECISION_CANCEL_REASON = "owner_action_settled_from_tool_recovery";
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

export type ToolFailureOwnerActionCloseoutReason =
  | "step_completed"
  | "run_completed"
  | "run_cancelled";

export type ToolFailureOwnerActionCloseoutVerdict =
  | { readonly close: true; readonly status: "done" | "cancelled"; readonly reason: ToolFailureOwnerActionCloseoutReason }
  | { readonly close: false };

/** Pure verdict. Structured step/run status only; card text is never read. */
export function classifyToolFailureOwnerActionCloseout(input: {
  readonly runStatus: string;
  readonly stepRunStatus: string | null;
}): ToolFailureOwnerActionCloseoutVerdict {
  if (input.stepRunStatus === "completed") return { close: true, status: "done", reason: "step_completed" };
  if (input.runStatus === "completed") return { close: true, status: "done", reason: "run_completed" };
  if (input.runStatus === "cancelled") return { close: true, status: "cancelled", reason: "run_cancelled" };
  return { close: false };
}

const REASON_TEXT: Record<ToolFailureOwnerActionCloseoutReason, { readonly ko: string; readonly en: string }> = {
  step_completed: { ko: "같은 스텝이 완료됨", en: "same step completed" },
  run_completed: { ko: "작업 흐름 실행 완료", en: "workflow run completed" },
  run_cancelled: { ko: "작업 흐름 실행 취소", en: "workflow run cancelled" },
};

/** Display-only closeout comment (system comment). Not an execution authority. */
export function buildToolFailureOwnerActionCloseoutComment(input: {
  readonly language: SystemLanguage;
  readonly reason: ToolFailureOwnerActionCloseoutReason;
}): string {
  const ko = input.language === "ko";
  const reason = REASON_TEXT[input.reason][ko ? "ko" : "en"];
  return ko
    ? `툴 스텝 실패로 만들어진 복구 업무를 자동으로 정리했습니다. 사유: ${reason}. 이 업무는 더 이상 열린 미션 업무가 아닙니다. 다음 행동: 해당 스텝과 실행의 최종 기록을 확인해 주세요. 이 정리는 새 실행을 요청하지 않습니다.`
    : `Resolved automatically: this tool-failure owner action was superseded (${reason}) and no longer represents open mission work. Next action: review the step and run final record; this closeout does not start another run.`;
}

export interface ToolFailureOwnerActionCloseoutInput {
  readonly db: Db;
  readonly run: { readonly id: string; readonly status: string; readonly companyId: string; readonly missionId: string | null };
  /** Post-sync step runs of this run. Omitted → loaded from the durable rows. */
  readonly stepRuns?: ReadonlyArray<{ readonly id: string; readonly workflowRunId: string; readonly status: string }>;
}

export interface ToolFailureOwnerActionCloseoutResult {
  readonly closed: ReadonlyArray<{
    readonly issueId: string;
    readonly previousStatus: string;
    readonly status: "done" | "cancelled";
    readonly reason: ToolFailureOwnerActionCloseoutReason;
  }>;
  /** Pending operator decisions anchored to a card closed in this pass, cancelled with it. */
  readonly cancelledDecisions: ReadonlyArray<{
    readonly issueId: string;
    readonly operatorDecisionId: string;
    readonly reason: ToolFailureOwnerActionCloseoutReason;
  }>;
}

/** Pending→cancelled CAS in one transaction, with the shared `operator_decision.cancelled` audit row. */
async function cancelDecisionsAnchoredToCard(
  db: Db,
  input: { readonly companyId: string; readonly missionId: string; readonly issueId: string; readonly reason: ToolFailureOwnerActionCloseoutReason },
): Promise<string[]> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const cancelled = await tx.update(operatorDecisions)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(
        eq(operatorDecisions.companyId, input.companyId),
        eq(operatorDecisions.issueId, input.issueId),
        eq(operatorDecisions.status, "pending"),
        isNull(operatorDecisions.qualityActionId),
      ))
      .returning({ id: operatorDecisions.id, requestKey: operatorDecisions.requestKey });
    if (cancelled.length === 0) return [];
    await tx.insert(activityLog).values(cancelled.map((row) => ({
      companyId: input.companyId,
      actorType: "user",
      actorId: DECISION_CANCEL_ACTOR_ID,
      agentId: null,
      action: TOOL_FAILURE_DECISION_CANCEL_ACTION,
      entityType: "operator_decision",
      entityId: row.id,
      details: {
        schemaVersion: 1,
        operatorDecisionId: row.id,
        requestKey: row.requestKey,
        cancelledByActorType: "user",
        cancelledByActorId: DECISION_CANCEL_ACTOR_ID,
        cancelledAt: now.toISOString(),
        reason: DECISION_CANCEL_REASON,
        issueId: input.issueId,
        missionId: input.missionId,
      },
    })));
    return cancelled.map((row) => row.id);
  });
}

/**
 * Closes open tool-failure owner action cards linked (by `owner_tool_recovery_target_v1`) to this run
 * once their step completed or the run completed/cancelled. Idempotent; never throws per card.
 */
export async function closeStaleToolFailureOwnerActions(
  input: ToolFailureOwnerActionCloseoutInput,
): Promise<ToolFailureOwnerActionCloseoutResult> {
  const { db, run } = input;
  const empty: ToolFailureOwnerActionCloseoutResult = { closed: [], cancelledDecisions: [] };
  if (!run.missionId) return empty;

  const links = await db
    .select({ issueId: workflowTransitionEvents.issueId, stepRunId: workflowTransitionEvents.workflowStepRunId })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, run.companyId),
      eq(workflowTransitionEvents.workflowRunId, run.id),
      or(
        eq(workflowTransitionEvents.eventType, TOOL_RECOVERY_TARGET_EVENT_TYPE),
        sql`${workflowTransitionEvents.payload}->>'kind' = 'tool_step'`,
      ),
    ));
  const linkedIssueIds = Array.from(new Set(links.map((link) => link.issueId).filter((id): id is string => id !== null)));
  if (linkedIssueIds.length === 0) return empty;

  const openCards = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, run.companyId),
      eq(issues.missionId, run.missionId),
      eq(issues.originKind, RECOVERY_UNBLOCK_ORIGIN_KIND),
      inArray(issues.id, linkedIssueIds),
      isNull(issues.hiddenAt),
      notInArray(issues.status, CLOSED_ISSUE_STATUSES),
    ));
  if (openCards.length === 0) return empty;

  const stepRunRows = input.stepRuns
    ?? await db.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId, status: workflowStepRuns.status })
      .from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const stepRunById = new Map(stepRunRows
    .filter((stepRun) => stepRun.workflowRunId === run.id)
    .map((stepRun) => [stepRun.id, stepRun]));
  const service = issueService(db);
  const closed: Array<ToolFailureOwnerActionCloseoutResult["closed"][number]> = [];
  const cancelledDecisions: Array<ToolFailureOwnerActionCloseoutResult["cancelledDecisions"][number]> = [];
  for (const card of openCards) {
    // One card ↔ one step run (owner-tool identity contract); a link without a step run id
    // (damaged header) can still be closed by the run-level verdict only.
    const stepRunIds = [...new Set(links.filter((link) => link.issueId === card.id && link.stepRunId).map((link) => link.stepRunId!))];
    const stepRunStatus = stepRunIds.length === 1 ? stepRunById.get(stepRunIds[0]!)?.status ?? null : null;
    const verdict = classifyToolFailureOwnerActionCloseout({ runStatus: run.status, stepRunStatus });
    if (!verdict.close) continue;

    try {
      const updated = await service.update(card.id, { status: verdict.status });
      if (updated?.status !== verdict.status) continue;
      const language = await loadCompanySystemLanguage(db, run.companyId);
      await service.addComment(card.id, buildToolFailureOwnerActionCloseoutComment({ language, reason: verdict.reason }), {});
      // The card is closed: its anchored pending human-input cards can no longer produce a follow-up.
      // Independent try — a failed cancel is logged (the card itself stays closed; the periodic dead-card
      // sweep is the backstop for terminal anchors) and never breaks the closeout.
      let decisionIds: string[] = [];
      try {
        decisionIds = await cancelDecisionsAnchoredToCard(db, {
          companyId: run.companyId, missionId: run.missionId, issueId: card.id, reason: verdict.reason,
        });
      } catch (err) {
        logger.warn({ err, issueId: card.id, workflowRunId: run.id }, "tool-failure owner action decision cancel skipped");
      }
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: CLOSEOUT_ACTOR_ID,
        action: TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION,
        entityType: "issue",
        entityId: card.id,
        details: {
          reason: verdict.reason,
          previousStatus: card.status,
          nextStatus: verdict.status,
          workflowRunId: run.id,
          runStatus: run.status,
          stepRunIds,
          operatorDecisionsCancelled: decisionIds,
        },
      });
      closed.push({ issueId: card.id, previousStatus: card.status, status: verdict.status, reason: verdict.reason });
      cancelledDecisions.push(...decisionIds.map((operatorDecisionId) => ({ issueId: card.id, operatorDecisionId, reason: verdict.reason })));
    } catch (err) {
      // Concurrent closeout/handback conflict: retried on the next sync. Never breaks the caller.
      logger.warn({ err, issueId: card.id, workflowRunId: run.id }, "tool-failure owner action closeout skipped");
    }
  }
  return { closed, cancelledDecisions };
}

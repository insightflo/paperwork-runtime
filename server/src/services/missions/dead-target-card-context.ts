// server/src/services/missions/dead-target-card-context.ts
//
// [목적] dead-target 에스컬레이션 카드 생성 시 실패 실행·스텝 원인을 구조적으로 조회하여
//   1) 도구 단계 실패(tool_recovery_target_missing, issueId=null 포함)에서도 실패 workflowRun 과
//      단계 오류 원문(lastDispatchErrorSummary)을 연결하고,
//   2) 영문 감시 로그 대신 한국어 완결 증상·권장 선택지(404 등 재시도 불가 시 취소 권장)를 구성하며,
//   3) anchor 이슈와 source 이슈가 같을 때 중복 링크를 제거한다.
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import {
  interpretFailureCause,
  interpretTargetFailureStatusSentence,
} from "../failure-interpretation.js";
import { isForeignDominantLine } from "./mission-owner-human-input-card.js";
import { DEAD_TARGET_RECOVERY_ACTION_OPTIONS } from "./terminal-recovery-card-options.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION,
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
} from "./workflow-restart-option.js";

type FailedStepContext = {
  id: string;
  workflowId: string;
  stepId: string;
  stepError: string | null;
};

export type DeadTargetCardContext = {
  workflowRunId: string | null;
  structuredOptions: { id: string; label: string; description?: string }[];
  recommendedOptionId: string | null;
  recommendationReason: string | null;
  prerequisiteNotice: string | null;
  cardReason: string;
  cardEvidence: string;
  effectiveSourceIssueId: string | null;
};

const TARGET_URL_JSON_RE = /"url"\s*:\s*"(https?:\/\/[^"\\]+)"/;
const TARGET_URL_KO_RE = /\(대상:\s*(https?:\/\/[^\s)]+)\)/;
const GENERIC_URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+/i;

function extractTargetUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const fromJson = TARGET_URL_JSON_RE.exec(text)?.[1];
  if (fromJson) return fromJson;
  const fromKo = TARGET_URL_KO_RE.exec(text)?.[1];
  if (fromKo) return fromKo;
  return GENERIC_URL_RE.exec(text)?.[0] ?? null;
}

function summarizeTargetUrl(url: string | null): string | null {
  if (!url) return null;
  const compact = url.replace(/^https?:\/\/(?:github\.com\/)?/i, "").replace(/\/+$/, "");
  if (!compact || compact.length > 28) return null;
  return compact;
}

function buildKoreanCardReason(input: {
  loopKey: string;
  rawReason: string;
  causeSentence: string | null;
  isPermanentNotFound: boolean;
  targetUrl: string | null;
}): string {
  if (input.causeSentence) {
    const firstSentence = input.causeSentence.split(/(?<=[.!?])\s+/)[0]?.trim() || input.causeSentence;
    const slug = summarizeTargetUrl(input.targetUrl);
    const withTarget = slug ? `실패 원인: ${firstSentence} (대상: ${slug})` : `실패 원인: ${firstSentence}`;
    const line1 = !isForeignDominantLine(withTarget) && withTarget.length <= 130
      ? withTarget
      : `실패 원인: ${firstSentence}`;
    const line2 = input.isPermanentNotFound
      ? "입력 주소 오류라 재시작해도 다시 실패하므로 아래 선택지에서 취소(권장) 또는 재계획을 선택해 주세요."
      : "자동 복구가 중단되었으므로 아래 선택지에서 처음부터 새 실행 시작 등 복구 방향을 선택해 주세요.";
    return `${line1}\n${line2}`;
  }
  const nonEmptyLines = input.rawReason.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length === 0 || nonEmptyLines.every(isForeignDominantLine)) {
    return input.loopKey === "tool_recovery_target_missing"
      ? "도구 단계 복구 대상이 지정되지 않아 무한 대기 루프를 중단하고 사람 결정을 요청했습니다.\n자동 복구가 진행되지 않으므로 아래 선택지에서 재계획·새 실행·취소 중 방향을 선택해 주세요."
      : "종결되거나 재실행할 수 없는 원천을 향한 자동 재시도가 반복 거부되어 중단되었습니다.\n자동 재시도로는 진행되지 않으므로 아래 선택지에서 복구 방향을 선택해 주세요.";
  }
  return input.rawReason.slice(0, 2_000);
}

async function findFailedRunContext(db: Db, input: {
  companyId: string;
  missionId: string;
  loopKey: string;
  ownerActionIssueId: string;
  sourceIssueId: string | null;
}): Promise<FailedStepContext | null> {
  if (input.sourceIssueId) {
    const [bySourceIssue] = await db
      .select({
        id: workflowRuns.id,
        workflowId: workflowRuns.workflowId,
        stepId: workflowStepRuns.stepId,
        stepError: workflowStepRuns.lastDispatchErrorSummary,
      })
      .from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(
        eq(workflowStepRuns.issueId, input.sourceIssueId),
        eq(workflowRuns.companyId, input.companyId),
        eq(workflowRuns.missionId, input.missionId),
        eq(workflowRuns.status, "failed"),
        isNull(workflowRuns.parentRunId),
      ))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(1);
    if (bySourceIssue) return bySourceIssue;
  }
  if (input.loopKey !== "tool_recovery_target_missing") return null;

  // 도구 단계 실패는 workflowStepRuns.issueId=null 인 경우가 많아 owner_tool_recovery_target_v1
  // 링크나 미션의 최근 실패 최상위 실행의 issue-less 실패 스텝으로 원인 오류와 런을 역추적한다.
  const [toolTarget] = await db
    .select({
      workflowRunId: workflowTransitionEvents.workflowRunId,
      stepRunId: workflowTransitionEvents.workflowStepRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.missionId, input.missionId),
      eq(workflowTransitionEvents.issueId, input.ownerActionIssueId),
      eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt))
    .limit(1);

  if (toolTarget?.stepRunId) {
    const [byToolTarget] = await db
      .select({
        id: workflowRuns.id,
        workflowId: workflowRuns.workflowId,
        stepId: workflowStepRuns.stepId,
        stepError: workflowStepRuns.lastDispatchErrorSummary,
      })
      .from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(
        eq(workflowStepRuns.id, toolTarget.stepRunId),
        eq(workflowRuns.companyId, input.companyId),
        eq(workflowRuns.missionId, input.missionId),
        eq(workflowRuns.status, "failed"),
        isNull(workflowRuns.parentRunId),
      ))
      .limit(1);
    if (byToolTarget) return byToolTarget;
  }

  const [byFailedToolStep] = await db
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      stepId: workflowStepRuns.stepId,
      stepError: workflowStepRuns.lastDispatchErrorSummary,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      isNull(workflowStepRuns.issueId),
      eq(workflowStepRuns.status, "failed"),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
      eq(workflowRuns.status, "failed"),
      isNull(workflowRuns.parentRunId),
    ))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(1);
  return byFailedToolStep ?? null;
}

export async function resolveDeadTargetCardContext(db: Db, input: {
  companyId: string;
  missionId: string;
  loopKey: string;
  ownerActionIssueId: string;
  anchorId: string;
  sourceIssueId: string | null;
  reason: string;
  evidence: string;
}): Promise<DeadTargetCardContext> {
  const source = await findFailedRunContext(db, input);
  const combinedError = [source?.stepError, input.reason, input.evidence].filter(Boolean).join("\n");
  const causeSentence = interpretFailureCause(combinedError);
  const notFoundSentence = interpretTargetFailureStatusSentence(404);
  const isPermanentNotFound = causeSentence !== null && notFoundSentence !== null && causeSentence === notFoundSentence;
  const targetUrl = extractTargetUrl(source?.stepError) ?? extractTargetUrl(input.evidence) ?? extractTargetUrl(input.reason);
  const cardReason = buildKoreanCardReason({
    loopKey: input.loopKey,
    rawReason: input.reason,
    causeSentence,
    isPermanentNotFound,
    targetUrl,
  });
  const cardEvidence = [targetUrl, source?.stepError, input.evidence]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join("\n")
    .slice(0, 2_000);
  const effectiveSourceIssueId = input.sourceIssueId && input.sourceIssueId !== input.anchorId
    ? input.sourceIssueId
    : null;

  const noRunBinding: DeadTargetCardContext = {
    workflowRunId: null,
    structuredOptions: DEAD_TARGET_RECOVERY_ACTION_OPTIONS.map((option) => ({ ...option })),
    recommendedOptionId: isPermanentNotFound ? "cancel-mission" : null,
    recommendationReason: isPermanentNotFound
      ? "수집 대상이 404(없는 페이지)로 확인되어 취소를 권장합니다."
      : null,
    prerequisiteNotice: isPermanentNotFound
      ? "입력 주소가 없는 페이지(404)여서 재시작으로 해결되지 않습니다 — 취소를 권장합니다."
      : "종결된 원천은 재실행할 수 없어 아래 복구 방법 중 하나를 선택해야 합니다.",
    cardReason,
    cardEvidence,
    effectiveSourceIssueId,
  };
  if (!source) return noRunBinding;

  const [activeReplacement] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
      eq(workflowRuns.workflowId, source.workflowId),
      isNull(workflowRuns.parentRunId),
      ne(workflowRuns.id, source.id),
      or(
        inArray(workflowRuns.status, ["pending", "running"]),
        sql`${workflowRuns.metadata}->'operatorDecisionRestart'->>'sourceWorkflowRunId' = ${source.id}`,
      ),
    ))
    .limit(1);
  if (activeReplacement) {
    return {
      workflowRunId: null,
      structuredOptions: [],
      recommendedOptionId: null,
      recommendationReason: null,
      prerequisiteNotice: null,
      cardReason,
      cardEvidence,
      effectiveSourceIssueId,
    };
  }

  return {
    workflowRunId: source.id,
    structuredOptions: [
      {
        id: WORKFLOW_RESTART_FROM_START_OPTION_ID,
        label: WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
        description: WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION,
      },
      ...DEAD_TARGET_RECOVERY_ACTION_OPTIONS.map((option) => ({ ...option })),
    ],
    recommendedOptionId: isPermanentNotFound ? "cancel-mission" : WORKFLOW_RESTART_FROM_START_OPTION_ID,
    recommendationReason: isPermanentNotFound
      ? "수집 대상이 404(없는 페이지)로 확인되어 동일 조건 재시작으로는 해결되지 않으므로 취소를 권장합니다."
      : "종결된 원천을 다시 열지 않고 같은 미션의 새 최상위 실행을 시작합니다.",
    prerequisiteNotice: isPermanentNotFound
      ? "입력 주소가 없는 페이지(404)여서 처음부터 새 실행을 시작해도 동일하게 실패합니다 — 취소를 권장합니다."
      : null,
    cardReason,
    cardEvidence,
    effectiveSourceIssueId,
  };
}

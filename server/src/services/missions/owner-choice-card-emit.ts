// server/src/services/missions/owner-choice-card-emit.ts
//
// [owner-choice-card Stage 3] 정상 흐름(normal-flow) 선택 카드의 서버 생산자.
//   payload 계약(owner-choice-card-contract)을 fail-closed 로 검증한 뒤 기존
//   operator_decisions 생성 경로(operator-decision-create)와 같은 트랜잭션 형태로
//   pending 카드를 발행하고 mission.owner.choice_card_requested 구조 활동을 남긴다.
// [sourceContext] 선택 힌트 7키(decisionKind/decisionPoint/choiceOptions/ttlMs/suggestedDecision/
//   safeAutoAdvance/irreversible)는 서버 소유다 — 공개 strict 스키마를 통과하는 base 키
//   (missionId/workflowId/workflowRunId/artifactRefs/targetSnapshot)만 요청 입력·requestHash 에
//   포함하고 저장 시에만 병합한다(planDecisionHash 패턴; strip 은 operator-decision-server-context).
// [해결 계약] definition.options 는 payload.options 와 1:1 이고 단일 submit 액션(requiresSelection)이
//   선택을 요구한다 — 사람 resolve·TTL auto_advance 모두 {actionId, outcome:"submit",
//   selectedOptionIds:[옵션]} 와이어를 공유하므로 기존 resolve·UI 제출이 새 API 없이 동작한다.
// [수정시 주의] safe 제안의 re한정(비가역 선택지 금지)은 계약이 이미 강제한다 —
//   여기서 완화하면 TTL 엔진이 사람 대신 비가역 선택을 자동 제출할 수 있다.
import { and, eq } from "drizzle-orm";
import { activityLog, agents, issues, operatorDecisions, type Db, type OperatorDecisionSourceContextJson } from "@paperclipai/db";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionSourceContext,
  OperatorDecisionTargetSnapshot,
} from "@paperclipai/shared/types/operator-decision";
import { conflict, forbidden, unprocessable } from "../../errors.js";
import { publishLiveEvent } from "../live-events.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { stripOperatorDecisionServerContext } from "../operator-decision-server-context.js";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "../operator-decision-currentness.js";
import { operatorDecisionReadService } from "../operator-decisions-read.js";
import type { OperatorDecisionActor } from "../operator-decision-create.js";
import {
  buildOwnerChoiceCardSourceContext,
  parseOwnerChoiceCardPayload,
  type OwnerChoiceCardPayload,
} from "./owner-choice-card-contract.js";
import { isPendingMissionHumanCardUniqueViolation } from "./mission-owner-human-input-card.js";

export const OWNER_CHOICE_CARD_REQUESTED_ACTION = "mission.owner.choice_card_requested";

/** 사람 제출 액션 id — TTL auto_advance 의 "auto_advance" 와 구분되는 resolve 경로 식별자. */
const CHOICE_SUBMIT_ACTION_ID = "choose";
/** operatorDecisionDefinitionSchema 의 옵션/액션 id 패턴(strict) — 계약보다 좁으므로 emit 이 거른다. */
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;

export interface EmitMissionOwnerChoiceCardInput {
  companyId: string;
  /** 발행 주체 — resolve 웨이크 수신자(에이전트) 또는 보드 사용자. */
  actor: OperatorDecisionActor;
  /** 카드가 속한 미션 — TTL 스윕·pending 1장 인덱스의 스코프 키. */
  missionId: string;
  workflowId?: string | null;
  workflowRunId?: string | null;
  /** 카드 앵커 이슈 — 있으면 issue_current_assignee continuation + targetSnapshot. */
  issueId?: string | null;
  /** 멱등 요청 키 — 같은 키+같은 hash 는 replay, 같은 키 다른 hash 는 409. */
  requestKey: string;
  /** 생산자의 결정 이벤트 id — 없으면 requestKey. */
  sourceId?: string;
  priority?: "critical" | "high" | "medium" | "low";
  /** 정상 흐름 선택 카드 payload — ownerChoiceCardPayloadSchema 로 fail-closed 검증. */
  payload: unknown;
}

/** 계약상 유효해도 strict operator-decision 정의로 내릴 수 없는 형태를 emit 단계에서 거른다(fail-closed). */
function assertDefinitionCompatible(payload: OwnerChoiceCardPayload) {
  const badId = payload.options.some((option) => option.id.length > 80 || !STABLE_ID_PATTERN.test(option.id));
  if (badId) throw unprocessable("choice option ids must match the operator decision stable-id pattern",
    { code: "owner_choice_option_id_invalid" });
  const recommended = payload.options.filter((option) => option.recommended === true).length;
  if (recommended > 1) throw unprocessable("at most one choice option may be recommended",
    { code: "owner_choice_recommended_conflict" });
}

function buildChoiceDefinition(payload: OwnerChoiceCardPayload, missionId: string, issueId: string | null) {
  const proposal = payload.autoAdvanceProposal;
  const evidence = (payload.contextLinks ?? [])
    .filter((link) => link.startsWith("/") || link.startsWith("http://") || link.startsWith("https://"))
    .map((link, index) => ({
      label: clip(`참고 링크 ${index + 1}`, 160), href: clip(link, 2_000),
      location: "선택 카드 contextLinks", description: null }));
  if (evidence.length === 0) evidence.push({ label: "선택 카드 발행 컨텍스트",
    href: issueId ? `/issues/${issueId}` : `/missions/${missionId}`,
    location: "선택 카드 발행 앵커", description: null });
  return {
    options: payload.options.map((option) => ({
      id: option.id, label: clip(option.label, 160), description: clip(option.summary, 1_000),
      facts: [], evidenceRefs: [], ...(option.recommended === true ? { recommended: true } : {}) })),
    actions: [{ id: CHOICE_SUBMIT_ACTION_ID, label: "선택 제출", outcome: "submit" as const,
      tone: "primary" as const, requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional" as const, label: "메모", placeholder: null, maxLength: 2_000 },
    approvedScope: [] as string[], forbiddenScope: [] as string[],
    humanReview: {
      schemaVersion: "human-review-v1" as const,
      decisionSubject: clip(payload.prompt, 300),
      evidence,
      interpretation: `미션 정상 진행 중 '${payload.decisionPoint}' 지점에서 사람 판단이 필요합니다. 카드에서 선택지를 고르면 결과가 미션 오너 에이전트에 전달됩니다.`,
      impact: {
        ifApproved: "선택한 방향이 미션 오너 에이전트에 전달되고, 오너가 자기 권한 경로로 다음 단계를 진행합니다.",
        ifRejected: "카드가 회수되거나 제안 없이 만료되면 미션은 감독 경로로 회구됩니다.",
        ifWrong: "잘못된 방향이 전달되면 오너가 잘못된 다음 단계를 진행할 수 있습니다." },
      unresolvedFacts: proposal?.safe === true
        ? [`무응답 ${Math.round(proposal.afterMs / 3_600_000)}시간 후 제안 선택지(${proposal.defaultOptionId})가 자동 적용됩니다.`]
        : [],
      questions: [clip(payload.prompt, 1_000)],
      recommendedNextStep: proposal
        ? `무응답 시 제안 선택지(${proposal.defaultOptionId})가 적용됩니다 — ${clip(proposal.rationale, 1_500)}`
        : "선택지를 검토해 하나를 골라 주세요.",
      requiredReviewer: "human-operator",
    },
  };
}

/**
 * 정상 흐름 선택 카드 1장 발행 — 동일 requestKey+같은 hash 는 replay(기존 카드 반환), 다른 hash 는 409.
 * 미션에 이미 pending 사람 카드가 있으면 부분 고유 인덱스가 막는다 — 409 로 변환한다.
 */
export async function emitMissionOwnerChoiceCard(db: Db, input: EmitMissionOwnerChoiceCardInput) {
  const parsed = parseOwnerChoiceCardPayload(input.payload);
  if (!parsed.ok) {
    throw unprocessable(`owner choice card payload rejected: ${parsed.error}`, {
      code: "owner_choice_card_invalid" });
  }
  const payload = parsed.data;
  assertDefinitionCompatible(payload);
  if (input.actor.type === "agent") {
    const requester = await db.select({ companyId: agents.companyId }).from(agents)
      .where(eq(agents.id, input.actor.id)).then((rows) => rows[0] ?? null);
    if (!requester || requester.companyId !== input.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }
  const issueId = input.issueId ?? null;
  let targetSnapshot: OperatorDecisionTargetSnapshot | null = null;
  if (issueId) {
    const issue = await db.select({ companyId: issues.companyId, status: issues.status })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.companyId) {
      throw unprocessable("Linked issue must belong to the company");
    }
    targetSnapshot = { issueId, issueStatus: issue.status,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}) };
  }
  const fullContext = buildOwnerChoiceCardSourceContext(payload, {
    missionId: input.missionId, workflowId: input.workflowId ?? null,
    workflowRunId: input.workflowRunId ?? null });
  const proposal = payload.autoAdvanceProposal;
  const cardInput: CreateOperatorDecisionInput = {
    schemaVersion: 1,
    requestKey: input.requestKey,
    priority: input.priority ?? "medium",
    interactionType: "single_select",
    title: clip(payload.prompt, 200),
    description: clip([
      `## 정상 흐름 선택 요청(${payload.decisionPoint})`, "", payload.prompt,
      ...(proposal ? ["", `자동 진행 제안: ${proposal.defaultOptionId} (${proposal.safe ? "안전" : "검토 필요"}) — ${proposal.rationale}`] : []),
      ...((payload.contextLinks ?? []).length > 0
        ? ["", "참고:", ...(payload.contextLinks ?? []).map((link) => `- ${link}`)] : []),
    ].join("\n"), 4_000),
    sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
    sourceId: input.sourceId ?? input.requestKey,
    sourceContext: {
      ...stripOperatorDecisionServerContext(fullContext),
      ...(targetSnapshot ? { targetSnapshot } : {}) } as OperatorDecisionSourceContext,
    definition: buildChoiceDefinition(payload, input.missionId, issueId),
    issueId,
    continuationMode: issueId ? "issue_current_assignee" : "none",
  };
  const validated = validateAndHashOperatorDecisionCreate(cardInput);
  const read = operatorDecisionReadService(db);
  let committedId: string;
  try {
    const committed = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: operatorDecisions.id, requestHash: operatorDecisions.requestHash })
        .from(operatorDecisions).where(and(
          eq(operatorDecisions.companyId, input.companyId),
          eq(operatorDecisions.requestKey, input.requestKey),
        )).then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.requestHash !== validated.requestHash) {
          throw conflict("Operator decision request key conflict", { operatorDecisionId: existing.id });
        }
        return { id: existing.id, replayed: true as const };
      }
      const [created] = await tx.insert(operatorDecisions).values({
        companyId: input.companyId,
        requestKey: validated.input.requestKey,
        requestHash: validated.requestHash,
        schemaVersion: 1,
        priority: validated.input.priority,
        interactionType: validated.input.interactionType,
        title: validated.input.title,
        description: validated.input.description,
        sourceType: validated.input.sourceType,
        sourceId: validated.input.sourceId,
        sourceContext: { ...fullContext, ...(targetSnapshot ? { targetSnapshot } : {}) } as OperatorDecisionSourceContextJson,
        issueId,
        requestedByAgentId: input.actor.type === "agent" ? input.actor.id : null,
        requestedByUserId: input.actor.type === "user" ? input.actor.id : null,
        definition: validated.input.definition,
        continuationMode: validated.input.continuationMode,
      }).returning({ id: operatorDecisions.id });
      const baseDetails = {
        schemaVersion: 1, operatorDecisionId: created!.id, requestKey: validated.input.requestKey,
        priority: validated.input.priority, interactionType: validated.input.interactionType,
        sourceType: validated.input.sourceType, sourceId: validated.input.sourceId,
        issueId, continuationMode: validated.input.continuationMode };
      await tx.insert(activityLog).values([{
        companyId: input.companyId, actorType: input.actor.type, actorId: input.actor.id,
        agentId: input.actor.type === "agent" ? input.actor.id : null,
        action: "operator_decision.created", entityType: "operator_decision",
        entityId: created!.id, details: baseDetails }, {
        companyId: input.companyId, actorType: input.actor.type, actorId: input.actor.id,
        agentId: input.actor.type === "agent" ? input.actor.id : null,
        action: OWNER_CHOICE_CARD_REQUESTED_ACTION, entityType: "operator_decision",
        entityId: created!.id,
        details: { ...baseDetails, missionId: input.missionId, decisionPoint: payload.decisionPoint,
          optionIds: payload.options.map((option) => option.id),
          suggestedDecision: proposal?.defaultOptionId ?? null,
          safeAutoAdvance: proposal?.safe === true,
          irreversible: payload.options.some((option) => option.irreversible === true),
          ttlMs: fullContext.ttlMs, requestedAt: new Date().toISOString() } }]);
      return { id: created!.id, replayed: false as const };
    });
    committedId = committed.id;
    if (committed.replayed) return { decision: await read.getRequired(committed.id), replayed: true };
  } catch (error) {
    if (isPendingMissionHumanCardUniqueViolation(error)) {
      throw conflict("Mission already has a pending human decision card", {
        code: "mission_pending_human_card_exists" });
    }
    throw error;
  }
  publishLiveEvent({
    companyId: input.companyId, type: "operator_decision.created",
    payload: { operatorDecisionId: committedId, issueId, missionId: input.missionId,
      title: validated.input.title, priority: validated.input.priority },
  });
  return { decision: await read.getRequired(committedId), replayed: false };
}

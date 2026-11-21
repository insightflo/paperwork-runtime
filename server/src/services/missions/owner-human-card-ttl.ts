// server/src/services/missions/owner-human-card-ttl.ts
//
// [human-card TTL 2026-11-21] pending mission_owner_human_input 카드의 만료 정책과 스윕.
//   배경: 미션당 pending 사람 카드는 '기다림의 단일 표면'이라(supervision 단일-경로 규칙),
//   TTL 이 없으면 카드 1장이 오너 자동 회구를 무기한 보류시켰다. 이 모듈은
//   (a) TTL 정책 — 기본 24h, 선택(choice) 카드 2h, sourceContext.ttlMs/expiresAt 재정의,
//   (b) 순수 평가자 evaluatePendingHumanCardExpiry — 안전 제안이 있고 가역적인 카드만
//       auto_advance, 나머지는 withdraw_and_resume 로 감독 회구를 다시 연다,
//   (c) 스윕 sweepExpiredPendingHumanCards — 만료 pending 카드를 CAS 전이하고 구조화
//       activity 를 남긴다. 회수는 취소(continuation 없음), 자동 진행은 resolve +
//       issue_current_assignee 계약의 오너 웨이크 continuation 이다.
// [수정시 주의] 자동 진행은 '안전 제안 + 가역' 카드에만 허용된다 — 비가역 표시
//   (sourceContext.irreversible) 또는 비가역 행동 어휘(deploy/payment/delete/publish)가
//   있으면 절대 자동 진행하지 않고 회수한다. 평가는 카드 본문 자연어를 읽지 않고
//   sourceContext 의 구조화 힌트만 본다(규칙 9).
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "../operator-decision-currentness.js";

/** 사람 카드 기본 TTL — 24시간. */
export const DEFAULT_HUMAN_CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** 선택지 카드(choice)는 더 짧은 TTL — 2시간. */
export const CHOICE_CARD_TTL_MS = 2 * 60 * 60 * 1000;
/** 스윕 주체 식별자 — 카드 resolvedByUserId 와 activity 감사에 같은 값을 쓴다. */
export const HUMAN_CARD_TTL_SWEEP_ACTOR_ID = "system:owner-human-card-ttl";
/** 한 스윕이 검사하는 pending 카드 상한 — orphan/stale 스윕과 같은 배치 제한 원리. */
const SWEEP_BATCH_LIMIT = 50;

export const HUMAN_CARD_AUTO_RESOLVED_ACTION = "mission.owner.human_input_auto_resolved";
export const HUMAN_CARD_WITHDRAWN_ACTION = "mission.owner.human_input_withdrawn";
export const HUMAN_CARD_TTL_EXPIRED_REASON = "ttl_expired";

/** auto_advance 가 허용되는 안전 제안 어휘 — 이 밖의 제안은 회수 경로로만 보낸다. */
export const SAFE_AUTO_ADVANCE_DECISIONS = ["no_action_waiting", "retry", "resume", "continue"] as const;
/** 제안된 행동 자체가 비가역 계열이면 safeAutoAdvance 명시가 있어도 자동 진행하지 않는다. */
const IRREVERSIBLE_AUTO_ACTIONS = new Set(["deploy", "payment", "delete", "publish"]);

/**
 * 카드 sourceContext(jsonb)에 생산자가 선택적으로 심는 TTL·자동 진행 힌트.
 * 모든 키는 선택이다 — 없으면 기본 정책이 적용된다.
 */
export interface HumanCardTtlSourceContext {
  missionId?: string | null;
  /** 이 카드만의 TTL(ms). expiresAt 보다 낮은 우선순위. */
  ttlMs?: number;
  /** 절대 만료 시각(ISO). 파싱 가능하면 모든 TTL 계산을 대체한다. */
  expiresAt?: string;
  /** "choice" 이면 2시간 TTL 을 쓴다(그 외는 기본 24시간). */
  decisionKind?: string;
  /** 생산자가 제안하는 다음 행동 어휘(no_action_waiting/retry/resume/continue 등). */
  suggestedDecision?: string;
  /** 제안 행동의 별칭 필드 — 비가역 행동 판정에 같이 읽는다. */
  suggestedAction?: string;
  action?: string;
  /** true 이면 안전 목록에 없는 제안도 자동 진행 허용으로 본다(비가역 조건은 별도 적용). */
  safeAutoAdvance?: boolean;
  /** true 이면 절대 자동 진행하지 않는다 — 만료 시 회수한다. */
  irreversible?: boolean;
}

export interface PendingHumanCardExpiryInput {
  createdAt: Date;
  now?: Date;
  sourceContext?: HumanCardTtlSourceContext | null;
  suggestedDecision?: string | null;
  decisionKind?: string | null;
}

export type PendingHumanCardExpiry =
  | { expired: false }
  | { expired: true; action: "auto_advance"; decision: string }
  | { expired: true; action: "withdraw_and_resume"; reason: typeof HUMAN_CARD_TTL_EXPIRED_REASON };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** expiresAt 명시가 최우선 — 없거나 파싱 불가면 ttlMs → choice(2h) → 기본(24h) 순으로 계산한다. */
export function humanCardExpiryAtMs(input: {
  createdAt: Date;
  sourceContext?: HumanCardTtlSourceContext | null;
  decisionKind?: string | null;
}): number {
  const ctx = input.sourceContext ?? {};
  const explicit = readString(ctx.expiresAt);
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ttlOverride = typeof ctx.ttlMs === "number" && Number.isFinite(ctx.ttlMs) && ctx.ttlMs > 0
    ? ctx.ttlMs
    : null;
  const kind = (readString(input.decisionKind) ?? readString(ctx.decisionKind))?.toLowerCase();
  const ttlMs = ttlOverride ?? (kind === "choice" ? CHOICE_CARD_TTL_MS : DEFAULT_HUMAN_CARD_TTL_MS);
  return input.createdAt.getTime() + ttlMs;
}

/**
 * 만료 평가(순수). 만료되면 안전+가역 카드만 auto_advance, 나머지는 withdraw_and_resume.
 * - 안전: 제안이 SAFE_AUTO_ADVANCE_DECISIONS 에 있거나 sourceContext.safeAutoAdvance === true.
 * - 가역: sourceContext.irreversible !== true 이고 제안/행동 어휘가 비가역 계열이 아닐 것.
 */
export function evaluatePendingHumanCardExpiry(input: PendingHumanCardExpiryInput): PendingHumanCardExpiry {
  const now = input.now ?? new Date();
  if (now.getTime() < humanCardExpiryAtMs(input)) return { expired: false };
  const ctx = input.sourceContext ?? {};
  const suggestion = (readString(input.suggestedDecision) ?? readString(ctx.suggestedDecision))?.toLowerCase() ?? null;
  const safeSuggested = (suggestion !== null && (SAFE_AUTO_ADVANCE_DECISIONS as readonly string[]).includes(suggestion))
    || ctx.safeAutoAdvance === true;
  const actionNames = [suggestion, readString(ctx.suggestedAction), readString(ctx.action)]
    .filter((name): name is string => name !== null)
    .map((name) => name.toLowerCase());
  const irreversible = ctx.irreversible === true
    || actionNames.some((name) => IRREVERSIBLE_AUTO_ACTIONS.has(name));
  if (safeSuggested && !irreversible) {
    return { expired: true, action: "auto_advance", decision: suggestion ?? "no_action_waiting" };
  }
  return { expired: true, action: "withdraw_and_resume", reason: HUMAN_CARD_TTL_EXPIRED_REASON };
}

export interface SweepExpiredPendingHumanCardsResult {
  sweptCount: number;
  autoAdvancedIds: string[];
  withdrawnIds: string[];
}

/**
 * 미션(또는 회사)의 pending mission_owner_human_input 카드 중 TTL 만료분을 전이한다.
 * auto_advance 는 resolved + 오너 웨이크 continuation, 그 외는 cancelled + 감사로 정리해
 * 'pending 카드 대기' 단일-경로 보류를 해제한다. 카드 CAS 에 진 동시 resolve/cancel 은
 * 조용히 건너뛴다(다음 틱이 다시 판정한다).
 */
export async function sweepExpiredPendingHumanCards(
  db: Db,
  input: { companyId: string; missionId?: string; now?: Date; batchLimit?: number },
): Promise<SweepExpiredPendingHumanCardsResult> {
  const now = input.now ?? new Date();
  const candidates = await db.select({
    id: operatorDecisions.id,
    requestKey: operatorDecisions.requestKey,
    issueId: operatorDecisions.issueId,
    createdAt: operatorDecisions.createdAt,
    sourceContext: operatorDecisions.sourceContext,
    continuationMode: operatorDecisions.continuationMode,
  }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    eq(operatorDecisions.status, "pending"),
    eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
    ...(input.missionId ? [sql`${operatorDecisions.sourceContext}->>'missionId' = ${input.missionId}`] : []),
  )).orderBy(desc(operatorDecisions.createdAt)).limit(input.batchLimit ?? SWEEP_BATCH_LIMIT);

  const autoAdvancedIds: string[] = [];
  const withdrawnIds: string[] = [];
  for (const card of candidates) {
    const ctx = (card.sourceContext ?? {}) as HumanCardTtlSourceContext;
    const missionId = typeof card.sourceContext?.missionId === "string" ? card.sourceContext.missionId : null;
    const outcome = evaluatePendingHumanCardExpiry({
      createdAt: card.createdAt,
      now,
      sourceContext: ctx,
      suggestedDecision: ctx.suggestedDecision,
      decisionKind: ctx.decisionKind,
    });
    if (!outcome.expired) continue;
    const applied = await db.transaction(async (tx) => {
      if (outcome.action === "auto_advance") {
        const updated = await tx.update(operatorDecisions).set({
          status: "resolved",
          result: {
            actionId: "auto_advance",
            outcome: "submit",
            selectedOptionIds: [outcome.decision],
            comment: `TTL 만료로 안전 제안(${outcome.decision})을 자동 적용했습니다.`,
          },
          resolvedByUserId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
          resolvedAt: now,
          updatedAt: now,
        }).where(and(eq(operatorDecisions.id, card.id), eq(operatorDecisions.status, "pending")))
          .returning({ id: operatorDecisions.id });
        if (updated.length !== 1) return false;
        // resolve 와 같은 계약 — 오너 에이전트가 결정 결과를 웨이크로 받는다(anchor 없으면 생략).
        let continuationId: string | null = null;
        if (card.continuationMode === "issue_current_assignee" && card.issueId) {
          continuationId = await tx.insert(operatorDecisionContinuations).values({
            companyId: input.companyId,
            operatorDecisionId: card.id,
            issueId: card.issueId,
            state: "pending",
            nextAttemptAt: now,
          }).returning({ id: operatorDecisionContinuations.id }).then((rows) => rows[0]?.id ?? null);
        }
        await tx.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "system",
          actorId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
          action: HUMAN_CARD_AUTO_RESOLVED_ACTION,
          entityType: "operator_decision",
          entityId: card.id,
          details: {
            schemaVersion: 1,
            operatorDecisionId: card.id,
            requestKey: card.requestKey,
            missionId,
            decision: outcome.decision,
            reason: HUMAN_CARD_TTL_EXPIRED_REASON,
            continuationId,
            resolvedAt: now.toISOString(),
          },
        });
        return true;
      }
      const updated = await tx.update(operatorDecisions).set({
        status: "cancelled", cancelledAt: now, updatedAt: now,
      }).where(and(eq(operatorDecisions.id, card.id), eq(operatorDecisions.status, "pending")))
        .returning({ id: operatorDecisions.id });
      if (updated.length !== 1) return false;
      // 카드 뷰가 취소 사유를 읽는 기존 cancelled 계약 + 스윕 구조 이벤트 둘 다 남긴다.
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: card.id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: card.id,
          requestKey: card.requestKey,
          cancelledByActorType: "user",
          cancelledByActorId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
          cancelledAt: now.toISOString(),
          reason: outcome.reason,
          missionId,
        },
      });
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
        action: HUMAN_CARD_WITHDRAWN_ACTION,
        entityType: "operator_decision",
        entityId: card.id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: card.id,
          requestKey: card.requestKey,
          missionId,
          reason: outcome.reason,
          withdrawnAt: now.toISOString(),
        },
      });
      return true;
    });
    if (!applied) continue;
    if (outcome.action === "auto_advance") autoAdvancedIds.push(card.id);
    else withdrawnIds.push(card.id);
  }
  return { sweptCount: autoAdvancedIds.length + withdrawnIds.length, autoAdvancedIds, withdrawnIds };
}

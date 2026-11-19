import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { activityLog, issues, operatorDecisions, type Db } from "@paperclipai/db";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "./operator-decision-currentness.js";

/**
 * [purpose] B5(2026-11-16 실운영 확증): mission_owner_human_input pending 카드는 앵커(카드 issueId)
 *   이슈가 다른 경로로 종결(done/cancelled)돼도 미션이 active 이면 정리 경로가 없어 영구 잔존했다 —
 *   mission_alive 정책상 stale sweep 은 앵커 상태로 취소하지 않고, orphan sweep 은 종단 미션만 본다
 *   (카드 a2b7e1f2, 앵커 6aad9f42 는 15:01:56 done, 미션 9fe5e53a 는 active). 미션당 pending 1장
 *   유니크(pendingMissionHumanInputUq) 때문에 이후 에스컬레이션은 모두 이 죽은 카드에 병합되고,
 *   승인해도 continuation 이 issue_terminal 로 막혀 아무 후속이 없다. 이 스윕은 종결 앵커에 묶인
 *   pending 사람 카드를 시스템 취소해 에스컬레이션 통로를 다시 연다. 취소는 상태 변경이며
 *   continuation/wakeup 을 만들지 않는다(죽은 카드엔 후속이 없음).
 * [safety] 생성 가드(ensureTerminalHumanInputDecisionCard 의 anchor-issue-terminal 스킵)와 같은
 *   판정을 정리 쪽에 둔다. 이슈 종결 직후 진행 중인 resolve/hold 와의 경합은 safety window
 *   (기본 60초, issue.updated_at 기준)로 피하고, 트랜잭션 안에서 앵커 행을 FOR UPDATE SKIP LOCKED
 *   로 잠가 재검사한다 — 진행 중인 앵커 변경(reopen 등)이 있으면 이번 틱은 건너뛰고, 카드 CAS 에
 *   진 동시 resolve/cancel 승리 시 조용히 건너뛴다. 재발행 폭풍은 구조적으로 막힌다: 새 발행은
 *   항상 비종결 앵커만 고르고(dead-target loop·terminal alert 경로) 미션당 pending 은 1장뿐이다.
 * [audit] 카드 취소 감사는 기존 cancel 계약을 따른다 — action operator_decision.cancelled 와
 *   cancelledByActor* 필드를 그대로 써 카드 뷰(operator-decision-view 의 cancelled 사유 표시)와
 *   기존 소비자가 같은 형식으로 읽게 한다. 사유는 생성 가드와 같은 어휘 anchor-issue-terminal,
 *   actor 는 stale sweep 과 같은 system: 프리픽스 스윕 식별자다.
 */
export interface OperatorDecisionDeadCardSweepResult {
  checked: number;
  cancelled: number;
}

/** 스윕 주체 식별자 — activity 감사(actorId)와 취소 세부(cancelledByActorId)에 같은 값을 쓴다. */
export const DEAD_CARD_SWEEP_ACTOR_ID = "system:operator-decision-dead-card-sweep";
// 한 tick 이 검사·취소하는 카드 상한 — orphan sweep 과 같은 배치 상한.
const SWEEP_BATCH_LIMIT = 25;
// 이슈 종결 직후 진행 중인 resolve/hold 와의 경합 회피 창 — 이 값보다 오래 전에 종결된 앵커만 스윕.
const DEFAULT_SAFETY_WINDOW_MS = 60_000;
const TERMINAL_ANCHOR_STATUSES = ["done", "cancelled"] as const;

export async function sweepTerminalAnchorDeadCards(
  db: Db,
  now = new Date(),
  safetyWindowMs = DEFAULT_SAFETY_WINDOW_MS,
): Promise<OperatorDecisionDeadCardSweepResult> {
  const cutoff = new Date(now.getTime() - safetyWindowMs);
  const scanned = await db.select({
    id: operatorDecisions.id,
    companyId: operatorDecisions.companyId,
    requestKey: operatorDecisions.requestKey,
    issueId: operatorDecisions.issueId,
    issueStatus: issues.status,
    sourceContext: operatorDecisions.sourceContext,
  }).from(operatorDecisions)
    .innerJoin(issues, and(
      eq(issues.id, operatorDecisions.issueId),
      eq(issues.companyId, operatorDecisions.companyId),
    ))
    .where(and(
      eq(operatorDecisions.status, "pending"),
      eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
      isNotNull(operatorDecisions.issueId),
      inArray(issues.status, [...TERMINAL_ANCHOR_STATUSES]),
      lt(issues.updatedAt, cutoff),
    ))
    .limit(SWEEP_BATCH_LIMIT);
  const candidates = scanned.filter((row): row is typeof row & { issueId: string } => row.issueId !== null);

  let cancelled = 0;
  for (const candidate of candidates) {
    const applied = await db.transaction(async (tx) => {
      // 스캔→취소 사이 앵커 재오픈·진행 중 변경을 배제한다 — 앵커 행을 잠그고 종결 상태를 재검사.
      // 다른 tx 가 앵커를 붙들고 있으면(reopen 진행 등) skipLocked 로 이번 틱은 건너뛴다.
      const anchor = await tx.select({ status: issues.status }).from(issues)
        .where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId)))
        .for("update", { skipLocked: true })
        .then((rows) => rows[0] ?? null);
      if (!anchor || !(TERMINAL_ANCHOR_STATUSES as readonly string[]).includes(anchor.status)) return false;
      const updated = await tx.update(operatorDecisions).set({
        status: "cancelled", cancelledAt: now, updatedAt: now,
      }).where(and(
        eq(operatorDecisions.id, candidate.id),
        eq(operatorDecisions.status, "pending"),
      )).returning({ id: operatorDecisions.id });
      if (updated.length !== 1) return false; // 동시 resolve/cancel 승리 — 조용히 skip
      const missionId = typeof candidate.sourceContext?.missionId === "string" ? candidate.sourceContext.missionId : null;
      await tx.insert(activityLog).values({
        companyId: candidate.companyId,
        actorType: "user",
        actorId: DEAD_CARD_SWEEP_ACTOR_ID,
        agentId: null,
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: candidate.id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: candidate.id,
          requestKey: candidate.requestKey,
          cancelledByActorType: "user",
          cancelledByActorId: DEAD_CARD_SWEEP_ACTOR_ID,
          cancelledAt: now.toISOString(),
          reason: "anchor-issue-terminal",
          issueId: candidate.issueId,
          issueStatus: anchor.status,
          missionId,
        },
      });
      return true;
    });
    if (applied) cancelled += 1;
  }
  return { checked: candidates.length, cancelled };
}

// server/src/services/heartbeat-wp-registration-retry.ts
//
// [wp registration auto-recovery] heartbeat.ts 에서 기계적 분리된 보조 모듈(#676 패턴).
// [계약] 구조적 권위만 사용한다: 재시도 예산은 issue.artifact_work_product_missing_auto_blocked
//   구조화 activity_log 행 개수로만 계산하고, 코멘트·stdout·자연어는 절대 권위로 읽지 않는다.
//   첫 게이트 적중 시 이슈를 blocked 로 바꾸지 않고 등록 전용(registration-only) 프로듀서 재시도를
//   1회 큐잉하며, 두 번째 적중부터는 heartbeat.ts 의 기존 blocked + 오너 에스컬레이션 경로를 그대로
//   따른다. 산출물 등록 게이트 자체(work-product DB 레코드 권위)는 변경하지 않는다.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat-wake-context.js";

/** 재시도 예산 — 첫 적중 1회만 등록 전용 재시도를 허용한다(bounded). */
export const WORK_PRODUCT_REGISTRATION_RETRY_BUDGET = 1;

/** 재시도 웨이크에 실리는 등록 전용 지시문(120자 이하 — terminal release 검증 한도와 호환). */
export const WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION =
  "register the required work product via the official Workflow API and call workflow/complete";

export type WorkProductRegistrationRetryEntry = {
  readonly companyId: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly missionId: string | null;
  readonly attempt: number;
  readonly requiredAction: string;
};

type RetryEnqueueWakeup = (agentId: string, opts: WakeupOptions) => Promise<unknown>;

/**
 * 해당 이슈의 구조화 게이트 activity 행 수를 센다(재시도 예산 판정의 유일한 권위).
 * entity_type/entity_id 를 함께 묶어 다른 엔티티의 동일 action 행을 포함하지 않는다.
 */
export async function countPriorWorkProductRegistrationAutoBlocks(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
): Promise<number> {
  const rows = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.artifact_work_product_missing_auto_blocked"),
    ));
  return rows.length;
}

/**
 * post-transaction 등록 전용 재시도 플러시. 예산 안(attempt <= budget)의 각 항목에 대해
 * live wake coverage 가 없을 때 정확히 한 번(멱등 키) 프로듀서 웨이크를 큐잉한다.
 * 개별 항목 실패는 closeout 을 깨지 않는다(missing-evidence 후속과 동일한 계약).
 */
export async function flushWorkProductRegistrationRetries(
  db: Db,
  enqueueWakeup: RetryEnqueueWakeup,
  entries: ReadonlyArray<WorkProductRegistrationRetryEntry>,
): Promise<void> {
  if (entries.length === 0) return;
  const { hasLiveWakeCoverage } = await import("./missions/qa-rework-cap-oversight-wake.js");
  for (const entry of entries) {
    try {
      const covered = await hasLiveWakeCoverage(db, entry.companyId, entry.issueId);
      if (!covered) {
        await enqueueWakeup(entry.agentId, {
          reason: "work_product_registration_retry",
          triggerDetail: "work product registration missing after successful run",
          contextSnapshot: {
            issueId: entry.issueId,
            ...(entry.missionId ? { missionId: entry.missionId } : {}),
            requiredAction: entry.requiredAction,
            attempt: entry.attempt,
          },
          source: "on_demand",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat",
          idempotencyKey: `wp-registration-retry:${entry.issueId}:${entry.attempt}`,
        });
      }
    } catch (err) {
      logger.warn({ err, issueId: entry.issueId, attempt: entry.attempt }, "work-product registration retry wakeup failed");
    }
  }
}

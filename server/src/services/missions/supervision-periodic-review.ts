// server/src/services/missions/supervision-periodic-review.ts
//
// [수정시 주의] 오너 주기 리뷰 깨움 게이트. 회귀 시 missions-service.test.ts 의 주기 리뷰 케이스 필수.
// supervision-main.ts 의 runMainExecutorSupervision 에 있던 주기 리뷰 블록을 분리했다.
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { MissionServiceDeps } from "../missions.js";
import type { MissionExecutionSourceSnapshot } from "./mission-execution-sources.js";
import type { MissionSupervisionIssue, MissionSupervisionMission } from "./mission-supervision-context.js";
import { executionUnitKey } from "./supervision-helpers.js";
import {
  ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW,
  claimSupervisionMarkerOnce,
} from "./supervision-support.js";

export const MISSION_OWNER_PERIODIC_REVIEW_INTERVAL_MS = 30 * 60 * 1000;
// 실행 단위 status 는 normalizeMissionExecutionStatus 가 blocked 를 unknown 으로 접지만,
//   플러그인 단위가 blocked 문자열을 그대로 싣는 경로를 대비해 failed 와 함께 문제 단위로 둔다.
const PROBLEM_UNIT_STATUSES_FOR_REVIEW = new Set<string>(["failed", "blocked"]);

/**
 * [owner on-duty monitoring] 활성 미션에 점검할 상황이 있으면 일정 주기마다 오너를 깨워 미션
 *   상황을 스스로 점검하게 한다. 사건별 깨움만으로는 오너가 "지시 후 대기"에 머문다(2026-08-17
 *   GAZ: 21시간 중 오너 자발 점검 0회).
 * [2026-11-22 over-waking/55P03 수정] 두 가지 과잉을 제거한다:
 *   1) 월클록(:00/:30) 버킷은 신생 미션을 생성 직후 즉시 깨우고 동시 기동 미션들을 같은 벽시계
 *      경계에 몰아 lock timeout 을 유발했다 → 미션 생성 시각 기준 상대 버킷으로 바꿔 깨움 시각이
 *      미션마다 자연스럽게 엇갈리게 한다. 생성 후 30분 미만은 절대 깨우지 않는다(초기 유예).
 *   2) 살아 있는 하트비트 + 열린 오너 액션 0 + 실패/블록 단위 0 인 건강한 진행 중 미션은 자식
 *      실행이 정상 진행 중이므로 건너뛴다. 정체(!heartbeat)·열린 액션·문제 단위가 있으면 기존처럼
 *      30분 버킷 멱등으로 깨운다.
 */
export async function maybeDispatchMissionOwnerPeriodicReview(input: {
  db: Db;
  deps: MissionServiceDeps;
  mission: MissionSupervisionMission;
  oversightIssueId: string;
  missionIssues: MissionSupervisionIssue[];
  executionSnapshot: MissionExecutionSourceSnapshot;
  missionHasActiveHeartbeat: boolean;
  now: Date;
  findings: string[];
}): Promise<void> {
  const { db, deps, mission, oversightIssueId, missionIssues, executionSnapshot, now, findings } = input;
  if (mission.status !== "active" || !deps.onMissionOwnerPeriodicReviewWakeRequested) return;

  const missionCreatedMs = mission.createdAt instanceof Date ? mission.createdAt.getTime() : new Date(mission.createdAt).getTime();
  const missionAgeMs = Math.max(0, now.getTime() - (Number.isFinite(missionCreatedMs) ? missionCreatedMs : 0));
  if (missionAgeMs < MISSION_OWNER_PERIODIC_REVIEW_INTERVAL_MS) return;

  const openOwnerActionIds = missionIssues
    .filter((row) => row.hiddenAt == null
      && row.originKind === "mission_main_executor_unblock"
      && (row.status === "todo" || row.status === "in_progress" || row.status === "blocked"))
    .map((row) => row.id);
  const hasProblemUnit = executionSnapshot.units.some((unit) => PROBLEM_UNIT_STATUSES_FOR_REVIEW.has(unit.status));
  if (openOwnerActionIds.length === 0 && !hasProblemUnit && input.missionHasActiveHeartbeat) return;

  const reviewBucket = Math.floor(missionAgeMs / MISSION_OWNER_PERIODIC_REVIEW_INTERVAL_MS);
  const reviewKey = `mission-owner-periodic-review:${mission.id}:${reviewBucket}`;
  const claimed = await claimSupervisionMarkerOnce({
    db, companyId: mission.companyId, missionId: mission.id,
    issueId: oversightIssueId,
    idempotencyKey: reviewKey, eventType: "mission_owner_periodic_review_wake",
    payload: { bucket: reviewBucket },
  });
  if (!claimed) return;

  const inFlightUnitLabels = executionSnapshot.units
    .filter((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW.has(unit.status))
    .map((unit) => `${executionUnitKey(unit)}:${unit.status}`);
  try {
    await deps.onMissionOwnerPeriodicReviewWakeRequested({
      mission,
      openOwnerActionIds,
      inFlightUnitLabels,
      idempotencyKey: reviewKey,
    });
    findings.push(`mission_owner_periodic_review_wake_requested: open_owner_actions=${openOwnerActionIds.length} in_flight_units=${inFlightUnitLabels.length} bucket=${reviewBucket} — owner asked to review mission state and act (direct/coordinate/close) as needed`);
  } catch (err) {
    logger.warn({ err, missionId: mission.id }, "mission owner periodic review wake callback failed");
  }
}

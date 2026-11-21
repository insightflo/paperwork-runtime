// [R4 2026-11-21] 스케줄 지평(horizon) 신호 조회 — 미션이 속한 스케줄 구동 워크플로
//   시리즈를 기계적으로 식별한다. 스케줄러(native-scheduler → claimScheduledRun →
//   ensureMissionForWorkflowRun)는 workflow_definitions.schedule 에 따라 주기적
//   workflow_runs(triggerSource='schedule', scheduledSlotId, runDate)를 만들고 런마다
//   새 미션을 붙인다. 따라서 '미션이 스케줄 구동인가'는 미션에 연결된 스케줄 런의 존재와
//   그 워크플로 정의의 활성 스케줄로 판정하고, '연속 실패 사이클 수'는 같은 워크플로의
//   스케줄 런 시리즈(사이클마다 새 미션)를 최신순으로 세는 것으로 산출한다.
//   모든 판정은 내구 테이블 사실만 본다 — 추론·자연어 파싱 없음.
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { companies, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { computeNextRun } from "../scheduler/cron-next-run.js";

export type MissionScheduleHorizon = {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly schedule: string;
  readonly timezone: string;
  /** 이 미션을 해당 시리즈에 묶는 가장 최근 스케줄 런. */
  readonly latestScheduledRunId: string;
  readonly latestScheduledRunStatus: string;
  /** 같은 워크플로의 스케줄 런 시리즈에서 최신부터 연속된 'failed' 수. */
  readonly consecutiveFailures: number;
  /** 활성 스케줄의 다음 발생 시각 — 없으면 지평이 닫힌 것(게이트 미적용). */
  readonly nextScheduledRunAt: Date | null;
};

/** 연속 실패 집계에 사용하는 시리즈 런 조회 상한. */
const SCHEDULE_SERIES_LOOKBACK = 10;

/**
 * 미션의 스케줄 지평을 읽는다.
 * - 미션에 스케줄러 생성 런이 없거나, 그 워크플로가 더 이상 활성 스케줄을 갖지
 *   않으면(정의 비활성/스케줄 제거) null — 게이트 미적용.
 * - cron 다음 발생 계산은 스케줄러와 같은 computeNextRun 을 쓴다
 *   (workflow.timezone → company.timezone → 'UTC' 순, 후보 산출과 동일한 우선순위).
 */
export async function readMissionScheduleHorizon(
  db: Pick<Db, "select">,
  companyId: string,
  missionId: string,
  now = new Date(),
): Promise<MissionScheduleHorizon | null> {
  const isScheduledRun = or(
    eq(workflowRuns.triggerSource, "schedule"),
    isNotNull(workflowRuns.scheduledSlotId),
  );

  // 이 미션을 스케줄 시리즈에 묶는 가장 최근 스케줄 런 — 시리즈(워크플로) 식별 앵커.
  const [anchor] = await db
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, companyId),
      eq(workflowRuns.missionId, missionId),
      isScheduledRun,
    ))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(1);
  if (!anchor) return null;

  const [definition] = await db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      status: workflowDefinitions.status,
      schedule: workflowDefinitions.schedule,
      timezone: workflowDefinitions.timezone,
    })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, anchor.workflowId))
    .limit(1);
  const schedule = definition?.schedule?.trim();
  if (!definition || definition.status !== "active" || !schedule) return null;

  // 같은 워크플로의 스케줄 런 시리즈를 최신순으로 훑어 연속 'failed' 만 센다.
  // running/pending(진행 중), completed(회복), cancelled(개입)은 연쇄를 끊는다.
  const recent = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, companyId),
      eq(workflowRuns.workflowId, anchor.workflowId),
      isScheduledRun,
    ))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(SCHEDULE_SERIES_LOOKBACK);
  let consecutiveFailures = 0;
  for (const run of recent) {
    if (run.status !== "failed") break;
    consecutiveFailures += 1;
  }

  const [company] = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const timezone = definition.timezone ?? company?.timezone ?? "UTC";
  const nextScheduledRunAt = computeNextRun(schedule, timezone, now);

  return {
    workflowId: anchor.workflowId,
    workflowName: definition.name,
    schedule,
    timezone,
    latestScheduledRunId: anchor.id,
    latestScheduledRunStatus: anchor.status,
    consecutiveFailures,
    nextScheduledRunAt,
  };
}

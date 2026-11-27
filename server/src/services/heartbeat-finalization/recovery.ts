import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, missionAgentRuntimes } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { lifecycleActiveClause } from "./lifecycle-active.js";
import { attemptFullSettlement } from "./settlement.js";
import { syncWorkflowAfterHeartbeatSettlement } from "./post-execution.js";
import { publishLiveEvent } from "../live-events.js";
import { logger } from "../../middleware/logger.js";
import { completeMissionAgentRuntimeRun } from "../missions/mission-runtime-manager.js";
import { runRustSettlerRecoverOnce } from "./settler-client.js";

/**
 * [C2 2026-11-08] 정산 후 표시/슬롯 기준 일치: 이 run 의 정산으로 해당 에이전트의
 * lifecycle-active run 이 0 이 되고 표시가 아직 'running' 이면 idle 로 회복한다.
 * finalizeAgentStatus 와 같은 카운트 기준(lifecycleActiveClause)을 쓰되, 이 경로는
 * 회복 교정만 담당하므로 'running' 외 상태는 변경하지 않는다.
 */
async function releaseAgentDisplayStatusAfterSettlement(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  now: Date,
): Promise<void> {
  const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents).where(eq(agents.id, run.agentId));
  if (!agent || agent.status !== "running") return;
  const clause = await lifecycleActiveClause(db);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, run.agentId), clause));
  if (Number(count ?? 0) > 0) return;
  const [updated] = await db.update(agents).set({ status: "idle", updatedAt: now })
    .where(and(eq(agents.id, run.agentId), eq(agents.status, "running"))).returning();
  if (updated) {
    publishLiveEvent({
      companyId: agent.companyId,
      type: "agent.status",
      payload: { agentId: agent.id, status: "idle", outcome: run.status },
    });
  }
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];

/**
 * mission_runtime_idle Q 증명이 보는 활성 상태(quiescence-probe.ts)와 동일한 집합.
 * busy-전용 reap 회수기(mission-runtime-manager.reapStaleBusyMissionRuntimes)는 'busy'만
 * 회수하므로 starting/ready/stopping 잔류는 여기서 해소한다.
 */
const HELD_MISSION_RUNTIME_STATUSES = ["starting", "ready", "busy", "stopping"];

/**
 * 사전호출(어댑터 시작 전) 검증 단계에서만 발생하는 실패 코드 — 이 errorCode 는 어댑터가
 * 시작된 적 없다는 것의 구조적 증명의 일부다(resolveWorkflowStepToolContext /
 * resolveWorkflowStepKnowledgeContext 는 heartbeat.ts executeRun 의 어댑터 시작 전 setup
 * 단계에서만 throw 한다). 일반 실행 실패(adapter_failed 등)와 errorCode 미기록 run 은
 * 이 안전망이 개입하지 않는다 — Q 증명 fail-closed 를 유지한다(rust settler parity 계약).
 */
const PRE_INVOCATION_FAILURE_ERROR_CODES = new Set([
  "workflow_step_kb_contract_invalid",
  "workflow_step_tool_contract_invalid",
]);

/**
 * [사전호출 실패 held mission runtime 안전망]
 *
 * 사전호출 실패 run — 예: workflow_step_kb_contract_invalid — 은 어댑터를 시작하지 않았으므로
 * heartbeat_runs.processPid 가 세팅된 적 없다. 그런 run 이 terminal 으로 종결된 뒤 mission
 * runtime 이 starting/ready/busy/stopping 으로 잔류하면(완결 호출 누락, 크래시 타이밍 등)
 * mission_runtime_idle Q 증명이 영구 실패해 attemptFullSettlement 가 fail-closed(not_ready)로
 * 영구 재시도되고, lifecycleInFlightClause 가 같은 미션의 후속 wakeup 을 영구 defer 한다
 * (생산 run 4d288a1a 데드락).
 *
 * 개입 조건(모두 구조적 증명):
 * 1. errorCode 가 사전호출 검증 단계 전용 실패 코드(PRE_INVOCATION_FAILURE_ERROR_CODES).
 * 2. processPid IS NULL — 어댑터가 시작된 적 없음(persistRunProcessMetadata 는 어댑터 시작 시에만 기록).
 * 3. executorOwnerReleasedAt IS NOT NULL — owner capability 해제 완료. 미해제면 실제 실행자가
 *    살아있을 가능성을 배제 못 하므로 fail-closed 를 유지하고 이 안전망은 개입하지 않는다.
 * 4. held runtime = lastRunId 가 정확히 이 run 인 활성 행만 완결한다(c5 미호출 정산 경로와 동일
 *    completeMissionAgentRuntimeRun(status:'failed') 사용 → status 'crashed' 저장).
 */
async function completePreInvocationHeldMissionRuntimes(db: Db, run: typeof heartbeatRuns.$inferSelect, now: Date): Promise<void> {
  if (run.errorCode === null || !PRE_INVOCATION_FAILURE_ERROR_CODES.has(run.errorCode)) return;
  if (run.processPid !== null) return;
  if (run.executorOwnerReleasedAt === null) return;
  const heldRuntimes = await db
    .select({ id: missionAgentRuntimes.id })
    .from(missionAgentRuntimes)
    .where(and(
      eq(missionAgentRuntimes.lastRunId, run.id),
      inArray(missionAgentRuntimes.status, HELD_MISSION_RUNTIME_STATUSES),
      isNull(missionAgentRuntimes.stoppedAt),
    ));
  for (const held of heldRuntimes) {
    await completeMissionAgentRuntimeRun(db, {
      runtimeId: held.id,
      status: "failed",
      sessionId: null,
      error: run.errorCode ?? run.error ?? "pre_invocation_failure",
    });
    logger.info(
      { runId: run.id, runtimeId: held.id, errorCode: run.errorCode ?? null },
      "recovered pre-invocation held mission runtime for terminal-unsettled settlement",
    );
  }
}

/**
 * Phase 3 recovery (plan section 5, M1/N3): replays settlement for v1 runs that
 * reached terminal status but were not settled (crash window between setRunStatus
 * and settlement). After a fixed grace, re-attempts the full settlement pipeline:
 * ensureFinalization -> observe quiescence -> record Q stages if proven -> settle.
 *
 * FLAG-GATED: with the flag OFF, this is a no-op. With the flag ON, a recovered
 * settlement makes the run lifecycle-inactive and its linked workflow step dispatch-ready.
 *
 * Returns the number of runs processed.
 */
export async function recoverTerminalUnsettledRuns(
  db: Db,
  now: Date = new Date(),
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<number> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return 0;

  const cutoff = new Date(now.getTime() - graceMs);
  const cutoffIso = cutoff.toISOString();
  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      finalizationVersion: heartbeatRuns.finalizationVersion,
      settledAt: heartbeatRuns.settledAt,
    })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.status, TERMINAL_STATUSES),
      eq(heartbeatRuns.finalizationVersion, 1),
      isNull(heartbeatRuns.settledAt),
      sql`COALESCE(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) < ${cutoffIso}`,
    ))
    .limit(50);
  if (candidates.length === 0) return 0;

  // 사전호출 실패 held mission runtime 안전망은 정산 엔진 선택(TS 파이프라인 vs rust
  // settler)과 무관하게 후보 확정 직후 1회 돌린다. rust settler(crates/settler)는 Q 증명을
  // fail-closed 로만 재시도하므로 잔류 held runtime 을 완결하지 않는다 — 이 안전망을
  // settler 위임 앞에 두지 않으면 PAPERCLIP_SETTLER_BIN 구성 배포에서 같은 데드락이
  // 재발한다. TS 루프의 재판정(재읽기)은 안전망이 이미 완결한 runtime 을 다시 찾지
  // 못하므로 멱등하다.
  for (const candidate of candidates) {
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
      if (!run || run.finalizationVersion !== 1 || run.settledAt) continue;
      await completePreInvocationHeldMissionRuntimes(db, run, now);
    } catch {
      // Recovery is best-effort; individual failures are retried on the next tick.
    }
  }

  const rustResult = await runRustSettlerRecoverOnce(db, now, graceMs);
  if (rustResult) {
    for (const item of rustResult.settled) {
      if (item.agentStatusReleased) {
        publishLiveEvent({
          companyId: item.agentStatusReleased.companyId,
          type: "agent.status",
          payload: {
            agentId: item.agentStatusReleased.agentId,
            status: "idle",
            outcome: item.agentStatusReleased.outcome,
          },
        });
      }
      if (item.workflowStepRunId) {
        try {
          await syncWorkflowAfterHeartbeatSettlement(db, {
            id: item.runId,
            companyId: item.companyId,
            issueId: item.issueId,
            workflowStepRunId: item.workflowStepRunId,
          } as typeof heartbeatRuns.$inferSelect);
        } catch {
          // Recovery is best-effort; individual failures are retried on the next tick.
        }
      }
    }
    return rustResult.processed;
  }

  let processed = 0;
  for (const candidate of candidates) {
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
      if (!run || run.finalizationVersion !== 1 || run.settledAt) continue;

      // Every terminal-unsettled v1 run replays the same full settlement pipeline
      // the normal execution path uses. settleRunIfReady alone never materializes
      // the compensable C stages (issue promotion / workflow evidence sync), so
      // runs that terminalized with any other error code (adapter_failed,
      // issue_status_blocked, cancelled, timed_out, ...) stayed pending forever,
      // kept their sources classified as stale, and fed the unblock-anchor loop.
      const settlement = await attemptFullSettlement(db, run, now);
      if (settlement === "settled") {
        // [C2 2026-11-08] 정산이 슬롯 점유를 회수하면 표시 상태도 같은 기준으로 회복한다.
        // 종료 정리/시작 스윕이 미정산 점유 동안 유지한 'running' 표시만 교정한다(best-effort,
        // 워크플로 동기화를 막지 않는다). paused/terminated·idle 에이전트는 건드리지 않는다.
        await releaseAgentDisplayStatusAfterSettlement(db, run, now).catch(() => undefined);
        await syncWorkflowAfterHeartbeatSettlement(db, run);
      }
      processed += 1;
    } catch {
      // Recovery is best-effort; individual failures are retried on the next tick.
    }
  }
  return processed;
}

// [queued-stale fairness] 900s stale_queued 실패 직전의 bounded promote-first 검사기.
// capacity 가 비어 있으면(`startNextQueuedRunForAgent` 슬롯 계산상) 오래 대기한 queued run 을
// 실패로 전환하기 전에 먼저 승격을 시도하고, 승격이 시작에 실패한 이유를 구조화 메타데이터로
// 반환한다. 임계값 자체의 실패 계약(olderThan ∧ isPreStart ∧ capacity 비어있음)은 그대로 유지된다.
// bounded: 에이전트당 스윕 1회 승격 시도(attempted 집합 공유), promoter 가 자기 lock 을 소유하므로
// agent-start-lock 내부에서 호출하면 안 된다(recovery 스윕 루프 상단에서 lock 밖에서 호출).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { operatorApprovalWaitService } from "./operator-approval-wait.js";

export type QueuedStalePromotionOutcome =
  | "promoted_started"
  | "promoted_not_started"
  | "bounded_already_attempted"
  | "skipped_agent_unavailable"
  | "skipped_approval_waiting"
  | "skipped_no_capacity"
  | "promotion_error";

export type QueuedStalePromotionResult = {
  outcome: QueuedStalePromotionOutcome;
  promoterError?: string;
};

type QueuedStaleRunSnapshot = {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
};

export type QueuedStalePromotionDeps = {
  db: Db;
  startNextQueuedRunForAgent(agentId: string): Promise<unknown>;
  countActiveRunsForAgent(agentId: string): Promise<number>;
  maxConcurrentRuns(agent: typeof agents.$inferSelect): number;
  getRun(runId: string): Promise<{ id: string; status: string } | null>;
};

export function createQueuedStalePromotionFirst(deps: QueuedStalePromotionDeps) {
  /**
   * stale queued run 을 실패로 바꾸기 전에 bounded promote-first 를 시도한다.
   * - `promoted_started`: promoter 가 이 run(또는 더 오래된 run)을 시작했다 → 실패 처리 생략.
   * - 그 외: 승격이 시작으로 이어지지 않았으며, outcome 이 "왜 시작되지 못했는지"의
   *   구조화 기록이 된다(호출부가 queue transition/run event payload 로 남긴다).
   * 실행 권한은 반환값의 outcome 문자열이 아니라 promoter 의 실제 DB 전이가 가진다.
   */
  return async function promoteStaleQueuedRunBeforeFailure(
    snapshot: QueuedStaleRunSnapshot,
    attemptedAgents: Set<string>,
  ): Promise<QueuedStalePromotionResult> {
    if (attemptedAgents.has(snapshot.agentId)) return { outcome: "bounded_already_attempted" };
    const [agent] = await deps.db.select().from(agents).where(and(
      eq(agents.id, snapshot.agentId), eq(agents.companyId, snapshot.companyId),
    )).limit(1);
    if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
      return { outcome: "skipped_agent_unavailable" };
    }
    const slots = deps.maxConcurrentRuns(agent) - await deps.countActiveRunsForAgent(snapshot.agentId);
    if (slots <= 0) return { outcome: "skipped_no_capacity" };
    if (snapshot.issueId && (await operatorApprovalWaitService(deps.db).markerForIssue(snapshot.issueId)).waiting) {
      return { outcome: "skipped_approval_waiting" };
    }
    // The ordinary promoter owns the agent-start lock itself; this must stay outside any lock.
    attemptedAgents.add(snapshot.agentId);
    try {
      await deps.startNextQueuedRunForAgent(snapshot.agentId);
    } catch (error) {
      logger.warn({ error, runId: snapshot.id, agentId: snapshot.agentId }, "stale-queued promote-first attempt failed");
      return { outcome: "promotion_error", promoterError: error instanceof Error ? error.message : String(error) };
    }
    const current = await deps.getRun(snapshot.id);
    if (current && current.status !== "queued") return { outcome: "promoted_started" };
    return { outcome: "promoted_not_started" };
  };
}

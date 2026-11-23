// [파일 목적] process_lost 재시도 판정 + 고아 체크아웃·유령 running 에이전트 자동 정합 스위퍼.
// [외부 연결] server/src/services/heartbeat-orphan-reaper.ts.
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const DEFAULT_GRACE_MS = 120_000;
const DEFAULT_SWEEP_LIMIT = 20;
const TERMINAL_RUN_STATUSES = ["failed", "cancelled", "timed_out", "succeeded"] as const;
const RELEASABLE_ISSUE_STATUSES = ["in_progress", "todo"] as const;

export interface ReleasedOrphanIssue {
  issueId: string;
  companyId: string;
  assigneeAgentId: string | null;
  releasedCheckoutRunId: string;
}

export interface OrphanLockSweepResult {
  demotedAgentIds: string[];
  releasedIssues: ReleasedOrphanIssue[];
}

/**
 * 로컬 자식 프로세스를 추적하는 어댑터의 process_lost 런은 PID 기록 여부와 무관하게
 * (예: 서버 재시작 직후 processPid === null) 최대 1회 자동 재시도 대상이 된다.
 */
export function shouldRetryProcessLostRun(
  tracksLocalChild: boolean,
  processLossRetryCount: number | null | undefined,
): boolean {
  return tracksLocalChild && (processLossRetryCount ?? 0) < 1;
}

/**
 * 실행 중 런이 0건인데 running으로 고착된 에이전트와, 이미 종료된 런을 checkout_run_id로
 * 붙잡고 있는 고아 이슈를 grace window 경과 후 원자적으로 정합한다.
 */
export async function sweepOrphanedLocks(
  db: Db,
  opts?: {
    now?: Date;
    graceMs?: number;
    limit?: number;
    onIssueReleased?: (released: ReleasedOrphanIssue) => Promise<void>;
  },
): Promise<OrphanLockSweepResult> {
  const now = opts?.now ?? new Date();
  const graceMs = Math.max(0, opts?.graceMs ?? DEFAULT_GRACE_MS);
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_SWEEP_LIMIT, 100));
  const cutoff = new Date(now.getTime() - graceMs);

  const demotedAgentIds: string[] = [];
  const releasedIssues: ReleasedOrphanIssue[] = [];

  // 1. 유령 running 에이전트 정합 (queued/running heartbeat_runs가 0건인 경우에만 idle로 복귀)
  const phantomCandidates = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.status, "running"),
      lt(agents.updatedAt, cutoff),
      sql`NOT EXISTS (
        SELECT 1 FROM heartbeat_runs hr
        WHERE hr.agent_id = ${agents.id}
          AND hr.status IN ('queued', 'running')
      )`,
    ))
    .limit(limit);

  for (const candidate of phantomCandidates) {
    const [demoted] = await db
      .update(agents)
      .set({ status: "idle", updatedAt: now })
      .where(and(
        eq(agents.id, candidate.id),
        eq(agents.status, "running"),
        lt(agents.updatedAt, cutoff),
        sql`NOT EXISTS (
          SELECT 1 FROM heartbeat_runs hr
          WHERE hr.agent_id = ${agents.id}
            AND hr.status IN ('queued', 'running')
        )`,
      ))
      .returning({ id: agents.id });
    if (demoted) demotedAgentIds.push(demoted.id);
  }

  // 2. 종료된 런을 가리키는 고아 이슈 체크아웃 해제 (4중 원자 가드: id + checkoutRunId + status + executionRunId 소유권)
  const orphanCheckoutCandidates = await db
    .select({
      issueId: issues.id,
      checkoutRunId: issues.checkoutRunId,
    })
    .from(issues)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.checkoutRunId))
    .where(and(
      isNotNull(issues.checkoutRunId),
      inArray(issues.status, [...RELEASABLE_ISSUE_STATUSES]),
      inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
      isNotNull(heartbeatRuns.finishedAt),
      lt(heartbeatRuns.finishedAt, cutoff),
    ))
    .limit(limit);

  for (const candidate of orphanCheckoutCandidates) {
    if (!candidate.checkoutRunId) continue;
    const [updated] = await db
      .update(issues)
      .set({
        status: "todo",
        checkoutRunId: null,
        executionRunId: null,
        updatedAt: now,
      })
      .where(and(
        eq(issues.id, candidate.issueId),
        eq(issues.checkoutRunId, candidate.checkoutRunId),
        inArray(issues.status, [...RELEASABLE_ISSUE_STATUSES]),
        or(isNull(issues.executionRunId), eq(issues.executionRunId, candidate.checkoutRunId)),
      ))
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
      });

    if (!updated) continue;
    const released: ReleasedOrphanIssue = {
      issueId: updated.id,
      companyId: updated.companyId,
      assigneeAgentId: updated.assigneeAgentId,
      releasedCheckoutRunId: candidate.checkoutRunId,
    };
    releasedIssues.push(released);

    if (opts?.onIssueReleased) {
      try {
        await opts.onIssueReleased(released);
      } catch (err) {
        logger.warn({ err, issueId: released.issueId, releasedCheckoutRunId: released.releasedCheckoutRunId },
          "orphan lock sweeper onIssueReleased callback failed; continuing sweep");
      }
    }
  }

  if (demotedAgentIds.length > 0 || releasedIssues.length > 0) {
    logger.warn({
      demotedAgentCount: demotedAgentIds.length,
      releasedIssueCount: releasedIssues.length,
      demotedAgentIds,
      releasedIssueIds: releasedIssues.map((r) => r.issueId),
    }, "orphan lock sweeper reconciled stuck agents/issues");
  }

  return { demotedAgentIds, releasedIssues };
}

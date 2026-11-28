import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueWorkProducts, issues, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";

export const WORKFLOW_SYNC_SOURCES = [
  "workflow_sync",
  "issues_service",
  "plugin_host",
  "workflow_agent_api",
  "srb_pair_sync",
  "workflow_delegation",
  "heartbeat_promotion",
  "heartbeat_codex_autoblock",
  "issues_route",
  "plugins_route",
  "workflows_route",
  "workflow_execution",
  "workflow_tool_queue",
  "workflow_tool_result",
  "workflow_resume_dispatch",
  "workflow_retry",
  "workflow_cancellation",
  "workflow_reconciler",
  "workflow_deadlock_reconciler",
  "mission_supervision",
  "workflow_issue_closeout",
  "mission_owner_recovery",
  "workflow_qa_cap_acceptance",
  "workflow_source_issue_resume",
  "workflow_resume_qa_rearm",
] as const;

export type WorkflowSyncSource = (typeof WORKFLOW_SYNC_SOURCES)[number];

const workflowSyncSourceSet = new Set<string>(WORKFLOW_SYNC_SOURCES);

export function normalizeWorkflowSyncSource(source?: string | null): WorkflowSyncSource {
  return source && workflowSyncSourceSet.has(source)
    ? source as WorkflowSyncSource
    : "workflow_sync";
}

const terminalStepStatuses = new Set(["completed", "failed", "skipped"]);

export async function recordWorkflowStepStatusTransition(
  db: Pick<Db, "insert" | "transaction">,
  input: {
    companyId: string;
    missionId?: string | null;
    workflowRunId: string;
    workflowStepRunId: string;
    issueId?: string | null;
    heartbeatRunId?: string | null;
    fromStatus: string;
    toStatus: string;
    source?: WorkflowSyncSource | null;
    transitionVersion?: number | null;
  },
): Promise<void> {
  if (input.fromStatus === input.toStatus || !terminalStepStatuses.has(input.toStatus)) return;

  const transitionVersion = input.transitionVersion;
  if (typeof transitionVersion !== "number" || !Number.isInteger(transitionVersion) || transitionVersion < 1) return;

  const source = normalizeWorkflowSyncSource(input.source);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(workflowTransitionEvents).values({
        companyId: input.companyId,
        missionId: input.missionId ?? null,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        issueId: input.issueId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        eventType: "workflow_step_status_transition",
        layer: "workflow_sync",
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reasonCode: source,
        idempotencyKey: `wf-step-status:${input.workflowStepRunId}:${input.toStatus}:${transitionVersion}`,
        payload: {
          source,
          priorStatus: input.fromStatus,
          transitionVersion,
        },
      }).onConflictDoNothing();
    });
  } catch (err) {
    logger.warn(
      { err, workflowStepRunId: input.workflowStepRunId, transitionVersion },
      "failed to record workflow step status provenance",
    );
  }
}
export async function recordWorkflowStepStatusTransitions(
  db: Pick<Db, "insert" | "transaction">,
  input: {
    companyId: string;
    missionId?: string | null;
    workflowRunId: string;
    source: WorkflowSyncSource;
    priorStatusByStepRunId: ReadonlyMap<string, string>;
    stepRuns: ReadonlyArray<{
      id: string;
      issueId: string | null;
      status: string;
      statusTransitionVersion: number;
    }>;
  },
): Promise<void> {
  for (const stepRun of input.stepRuns) {
    await recordWorkflowStepStatusTransition(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: stepRun.id,
      issueId: stepRun.issueId,
      fromStatus: input.priorStatusByStepRunId.get(stepRun.id) ?? "pending",
      toStatus: stepRun.status,
      source: input.source,
      transitionVersion: stepRun.statusTransitionVersion,
    });
  }
}

/** [bug#2 step-settlement] 정산 대상 활성 스텝 상태. pending(미발화)은 cascade/recovery 계약의 소관이다. */
const TERMINAL_RUN_SETTLEMENT_STEP_STATUSES = ["running", "queued"] as const;

export interface TerminalRunSettlementInput {
  companyId: string;
  runId: string;
  missionId: string | null;
  decision: "failed" | "cancelled" | "completed";
  now: Date;
  /** TerminalDiscoveryPath 값 — 전이 감사 source 로 사상된다(completed 무시). */
  discovery: string;
}

/**
 * [정산 진단] 정산(running/queued → failed)로 step_run 이 실패 처리될 때 lastDispatchErrorSummary 가
 * 비어 있으면 채워 넣는 진단 요약. 접두사는 실제 정산 source 를 따른다(관측 혼동 방지 —
 * deadlock 정산을 workflow_reconciler 로 표기하지 않는다).
 * [수정시 영향] 진단 문구를 바꾸면 workflow-reconciler-error-summary 테스트를 함께 고친다.
 * 문구는 표시·진단 용도이며 실행 권한으로 읽히지 않는다.
 */
export function buildWorkflowSettlementErrorSummary(input: {
  source: WorkflowSyncSource;
  issueStatus: string | null;
  stepMetadata: Record<string, unknown> | null;
  activeWorkProductCount: number;
}): string {
  const issueDoneWithoutRequiredWorkProduct =
    input.issueStatus === "done"
    && input.stepMetadata?.graphWorkProductRequired === true
    && input.activeWorkProductCount === 0;
  return issueDoneWithoutRequiredWorkProduct
    ? `${input.source}: issue_done_without_required_work_product`
    : `${input.source}: step_settled_failed`;
}

/**
 * [정산 진단 조회] 빈 요약을 채우기 위한 판단 근거를 같은 트랜잭션에서 읽는다.
 * 이슈가 done 일 때만 활성 워크프로덕트를 세어 불필요한 조회를 줄인다.
 * companyId 조건으로 회사 범위를 유지한다.
 */
async function resolveWorkflowSettlementErrorSummary(
  db: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: TerminalRunSettlementInput,
  stepRun: { issueId: string | null; metadata: unknown },
  source: WorkflowSyncSource,
): Promise<string> {
  let issueStatus: string | null = null;
  let activeWorkProductCount = 0;
  if (stepRun.issueId) {
    const [issue] = await db.select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, stepRun.issueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    issueStatus = issue?.status ?? null;
    if (issueStatus === "done") {
      const [productRow] = await db.select({ n: count() })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.issueId, stepRun.issueId),
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.status, "active"),
        ));
      activeWorkProductCount = Number(productRow?.n ?? 0);
    }
  }
  return buildWorkflowSettlementErrorSummary({
    source,
    issueStatus,
    stepMetadata: (stepRun.metadata as Record<string, unknown> | null) ?? {},
    activeWorkProductCount,
  });
}

/**
 * [bug#2 step-settlement] run 이 failed/cancelled 로 종결되는 것과 같은 트랜잭션에서, 그 run 의
 * 남은 running/queued step_run 을 failed 로 정산한다(completedAt + 사유 metadata + 전이 감사).
 * run_status=failed + step_status=running 불일치가 영속하지 못하게 하는 종결 불변식이다.
 * 반드시 run 종결 쓰기와 동일 트랜잭션 안에서 호출해야 원자성이 성립한다.
 * [정산 진단] 기존 lastDispatchErrorSummary 가 비어 있을 때만 진단 요약을 채운다 —
 * 실제 dispatch 실패 요약을 절대 덮어쓰지 않는다.
 */
export async function settleRunningStepRunsForTerminalRun(
  db: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: TerminalRunSettlementInput,
): Promise<number> {
  if (input.decision === "completed") return 0;
  const source = input.discovery === "deadlock_detection"
    ? "workflow_deadlock_reconciler" as const
    : input.discovery === "stuck_diagnostic"
      ? "workflow_reconciler" as const
      : "workflow_sync" as const;
  const open = await db
    .select({
      id: workflowStepRuns.id,
      issueId: workflowStepRuns.issueId,
      status: workflowStepRuns.status,
      metadata: workflowStepRuns.metadata,
      lastDispatchErrorSummary: workflowStepRuns.lastDispatchErrorSummary,
      statusTransitionVersion: workflowStepRuns.statusTransitionVersion,
    })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.runId),
      inArray(workflowStepRuns.status, [...TERMINAL_RUN_SETTLEMENT_STEP_STATUSES]),
    ))
    .for("update");
  for (const stepRun of open) {
    const priorMetadata = (stepRun.metadata as Record<string, unknown> | null) ?? {};
    // [이유] 요약이 이미 있으면 실제 dispatch 실패 기록이므로 정산 진단으로 덮어쓰지 않는다.
    const settlementErrorSummary = (stepRun.lastDispatchErrorSummary ?? "").trim().length > 0
      ? undefined
      : await resolveWorkflowSettlementErrorSummary(db, input, stepRun, source);
    const [updated] = await db.update(workflowStepRuns)
      .set({
        status: "failed",
        completedAt: input.now,
        ...(settlementErrorSummary !== undefined
          ? { lastDispatchErrorSummary: settlementErrorSummary }
          : {}),
        metadata: {
          ...priorMetadata,
          terminalRunSettlement: {
            decision: input.decision,
            source,
            settledAt: input.now.toISOString(),
          },
        },
      })
      .where(eq(workflowStepRuns.id, stepRun.id))
      .returning({ id: workflowStepRuns.id, transitionVersion: workflowStepRuns.statusTransitionVersion });
    if (!updated) continue;
    await recordWorkflowStepStatusTransition(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      workflowRunId: input.runId,
      workflowStepRunId: stepRun.id,
      issueId: stepRun.issueId,
      fromStatus: stepRun.status,
      toStatus: "failed",
      source,
      transitionVersion: updated.transitionVersion > stepRun.statusTransitionVersion
        ? updated.transitionVersion
        : null,
    });
  }
  return open.length;
}

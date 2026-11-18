// server/src/services/heartbeat-enqueue-wakeup.ts
//
// [파일 목적] heartbeat.ts 에서 기계적 분리된 enqueueWakeup — 동작 무변경 (#676 패턴).
// [추출 계약] 본문은 heartbeat.ts L7067-L7827(추출 시점) 그대로이며, 줄·순서·리터럴을 바꾸지 않는다.
//   heartbeatService 인스턴스 클로저 함수/값(db/budgets/getAgent/...)은 deps 로 주입받는다.
//   heartbeat.ts 로부터는 아무것도 import 하지 않는다(순환 import 방지).
//   DEFERRED_WAKE_CONTEXT_KEY 는 deps.deferredWakeContextKey 로 전달된다.
import { and, asc, desc, eq, inArray, is, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues, missions, withTxTimeout } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import type { budgetService } from "./budgets.js";
import { parseHeartbeatPolicy } from "./heartbeat-concurrency-limit.js";
import { isCorrectionRun } from "./heartbeat-correction-run.js";
import { insertInitialWakeupRun, insertQueuedHeartbeat, type HeartbeatFollowupPromotionDeps } from "./heartbeat-followup-promotion.js";
import { createSkippedWakeWriter } from "./heartbeat-followup-queue.js";
import { assertHeartbeatRecoveryAdmission } from "./heartbeat-recovery-guard.js";
import { deriveTaskKey, isSameTaskScope, normalizeAgentNameKey, readNonEmptyString, runTaskKey } from "./heartbeat-run-context.js";
import { enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, type WakeupOptions } from "./heartbeat-wake-context.js";
import { isWorkflowStepResumeWake } from "./heartbeat-workflow-resume-wake.js";
import { insertWorkflowWakeRequest } from "./heartbeat-workflow-wake.js";
import { lifecycleInFlightClause } from "./heartbeat-finalization/lifecycle-active.js";
import { preserveWorkflowAttemptProof, withoutWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { resolveWorkflowExecutionLink } from "./heartbeat-finalization/workflow-link.js";
import { missionDedupExemptOversightReviewClause } from "./heartbeat-mission-dedup.js";
import { publishQueuedRun, recordHeartbeatQueueTransitionEvent } from "./heartbeat-queue-lifecycle.js";
import { findExistingQualityWakeRow, mergeableWakeupKeyCondition, queuePausedAgentWakeupRequest } from "./quality/heartbeat-admission.js";
import { isBoundedExecutionWakeKey } from "./quality/native-wake.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";
import { requireDelivery, type CorrectionDeliveryInput, type CorrectionDeliveryResult } from "./workflow/control-flow/qa-correction-delivery-receipt.js";
import { assertMissionRuntimeAcceptsWork } from "./missions/mission-runtime-manager.js";
import { refreshStepInputManifest } from "./wake-context-hygiene.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/**
 * HeartbeatEnqueueWakeupDeps — heartbeatService 클로저가 보유한 상태/함수의 주입 계약.
 * 값이 아니라 "지금 이 순간의 heartbeatService 인스턴스"를 가리켜야 하는 항목만 담는다.
 * heartbeat.ts 의 enqueueWakeup 래퍼가 호출 시점에 조립한다(클로저 const TDZ 안전).
 */
export type HeartbeatEnqueueWakeupDeps = {
  readonly db: Db;
  readonly deferredWakeContextKey: string;
  readonly budgets: ReturnType<typeof budgetService>;
  readonly followupPromotionDeps: HeartbeatFollowupPromotionDeps;
  readonly getAgent: (agentId: string) => Promise<AgentRow | null>;
  readonly startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
  readonly recordQueueTransitionEvent: (input: {
    companyId: string;
    missionId?: string | null;
    issueId?: string | null;
    wakeupRequestId?: string | null;
    heartbeatRunId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    eventType: string;
    layer: string;
    decision?: string | null;
    reason?: string | null;
    reasonCode?: string | null;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  readonly resolveSessionBeforeForWakeup: (
    agent: AgentRow,
    taskKey: string | null,
    opts?: { missionId?: string | null },
  ) => Promise<string | null>;
  readonly deferOperationsMissionIssueToMainExecutor: (input: {
    agent: AgentRow;
    issueId: string;
    missionId: string;
  }) => Promise<{
    mission: typeof missions.$inferSelect;
    issue: typeof issues.$inferSelect;
    ownerAction: typeof issues.$inferSelect;
  } | null>;
  readonly connectCorrectionDelivery: (
    candidate: CorrectionDeliveryInput | { wakeupRequestId: string },
    transactionProfile: "public_callback" | "recovery_skip_locked",
  ) => Promise<{ kind: CorrectionDeliveryResult["kind"] | "nested_pending"; run: HeartbeatRunRow | null }>;
};

export async function enqueueHeartbeatWakeup(deps: HeartbeatEnqueueWakeupDeps, agentId: string, opts: WakeupOptions = {}) {
  const {
    db, deferredWakeContextKey, budgets, followupPromotionDeps, getAgent,
    startNextQueuedRunForAgent, recordQueueTransitionEvent, resolveSessionBeforeForWakeup,
    deferOperationsMissionIssueToMainExecutor, connectCorrectionDelivery,
  } = deps;
  const source = opts.source ?? "on_demand";
  const triggerDetail = opts.triggerDetail ?? null;
  const contextSnapshot: Record<string, unknown> = withoutWorkflowAttemptProof(opts.contextSnapshot ?? {})!;
  const reason = opts.reason ?? null;
  const payload = withoutWorkflowAttemptProof(opts.payload ?? null);
  const {
    contextSnapshot: enrichedContextSnapshot,
    issueIdFromPayload,
    taskKey,
    wakeCommentId,
  } = enrichWakeContextSnapshot({
    contextSnapshot,
    reason,
    source,
    triggerDetail,
    payload,
  });
  const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

  let agent = await getAgent(agentId);
  if (!agent) throw notFound("Agent not found");

  if (reason === "retry_failed_run" && issueId) {
    const currentIssueAssignee = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
      .then((rows) => rows[0]?.assigneeAgentId ?? null);

    if (currentIssueAssignee && currentIssueAssignee !== agentId) {
      const assigneeAgent = await getAgent(currentIssueAssignee);
      if (assigneeAgent && assigneeAgent.companyId === agent.companyId) {
        agentId = currentIssueAssignee;
        agent = assigneeAgent;
      }
    }
  }

  const writeSkippedRequest = createSkippedWakeWriter(db, {
    companyId: agent.companyId,
    agentId,
    source,
    triggerDetail,
    payload,
    requestedByActorType: opts.requestedByActorType ?? null,
    requestedByActorId: opts.requestedByActorId ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    issueId: issueId ?? null,
    contextSnapshot: enrichedContextSnapshot,
    recordEvent: (recordDb, event) => recordHeartbeatQueueTransitionEvent(recordDb, event),
  });

  let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
  if (!projectId && issueId) {
    projectId = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
      .then((rows) => rows[0]?.projectId ?? null);
  }

  const missionIdForWake =
    readNonEmptyString(enrichedContextSnapshot.missionId) ??
    (issueId
      ? await db
          .select({ missionId: issues.missionId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0]?.missionId ?? null)
      : null);
  const requestedWorkflowRunId = readNonEmptyString(enrichedContextSnapshot.workflowRunId)
    ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowRunId"] as string)
    ?? null;
  const requestedWorkflowStepRunId = readNonEmptyString(enrichedContextSnapshot.workflowStepRunId)
    ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowStepRunId"] as string)
    ?? null;
  const workflowLink = await resolveWorkflowExecutionLink(db, {
    companyId: agent.companyId,
    issueId: issueId ?? null,
    workflowRunId: requestedWorkflowRunId,
    workflowStepRunId: requestedWorkflowStepRunId,
  });
  const workflowRunIdForWake = workflowLink.workflowRunId;
  const workflowStepRunIdForWake = workflowLink.workflowStepRunId;
  const workflowExecutionGeneration = workflowLink.generation;
  if (workflowRunIdForWake) enrichedContextSnapshot.workflowRunId = workflowRunIdForWake;
  if (workflowStepRunIdForWake) enrichedContextSnapshot.workflowStepRunId = workflowStepRunIdForWake;
  // [AREA: structured-events Task 1D] typed queue context derived from payload/contextSnapshot.
  // 모든 agent_wakeup_requests insert 경로에 mirror. payload 원본은 변경하지 않는다(호환성).
  const typedQueueColumns = {
    requestKind: readNonEmptyString((payload as Record<string, unknown> | null)?.["kind"] as string)
      ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["mutation"] as string)
      ?? reason
      ?? source,
    issueId: issueId ?? null,
    missionId: (missionIdForWake ?? readNonEmptyString(enrichedContextSnapshot.missionId)) ?? null,
    workflowRunId: workflowRunIdForWake,
    workflowStepRunId: workflowStepRunIdForWake,
    ...(workflowExecutionGeneration !== null ? { workflowExecutionGeneration } : {}),
  };
  const correctionRef = readQaCorrectionWakeRef({
    payload, idempotencyKey: opts.idempotencyKey ?? null,
  } as typeof agentWakeupRequests.$inferSelect);
  if (correctionRef) {
    requireDelivery(issueId && missionIdForWake && workflowRunIdForWake && workflowStepRunIdForWake
      && workflowExecutionGeneration !== null, "scope");
    const result = await connectCorrectionDelivery({
      mode: "initial", ref: correctionRef, companyId: agent.companyId, agentId, issueId,
      missionId: missionIdForWake, workflowRunId: workflowRunIdForWake, workflowStepRunId: workflowStepRunIdForWake,
      workflowExecutionGeneration, candidateWakeupRequestId: null,
      request: { source, triggerDetail, reason, payload, contextSnapshot: enrichedContextSnapshot,
        idempotencyKey: opts.idempotencyKey!, requestKind: typedQueueColumns.requestKind,
        requestedByActorType: opts.requestedByActorType ?? null, requestedByActorId: opts.requestedByActorId ?? null },
    }, "public_callback");
    if (result.kind === "new_delivery" && result.run) {
      await recordQueueTransitionEvent({
        companyId: agent.companyId, missionId: missionIdForWake, issueId,
        wakeupRequestId: result.run.wakeupRequestId, heartbeatRunId: result.run.id,
        eventType: "queue_accepted", layer: "queue", decision: "accepted",
        reason: "heartbeat_run_created", reasonCode: "heartbeat_run_created",
        idempotencyKey: `queue-accepted:${result.run.wakeupRequestId ?? "no-wake"}:${result.run.id}`,
      });
      publishQueuedRun(result.run);
      await startNextQueuedRunForAgent(agent.id);
    }
    return result.run;
  }
  const wakeDefaults = {
    companyId: agent.companyId, agentId, source, triggerDetail, reason, payload, ...typedQueueColumns,
    status: "queued", requestedByActorType: opts.requestedByActorType ?? null,
    requestedByActorId: opts.requestedByActorId ?? null, idempotencyKey: opts.idempotencyKey ?? null,
  };
  const recoveryAdmission = { companyId: agent.companyId, agentId, ...typedQueueColumns,
    contextSnapshot: enrichedContextSnapshot, idempotencyKey: opts.idempotencyKey ?? null,
    source, reason, payload, requestedByActorType: opts.requestedByActorType ?? null,
    requestedByActorId: opts.requestedByActorId ?? null, operatorDecisionInitialAdmission: true };
  const queuePausedAgentWakeup = () => withTxTimeout(db, async tx => {
    await assertHeartbeatRecoveryAdmission(tx as unknown as Db, { ...recoveryAdmission, operatorDecisionOnly: true });
    await queuePausedAgentWakeupRequest(tx as unknown as Db, {
      companyId: agent.companyId, agentId, source, triggerDetail, reason, payload, typedQueueColumns,
      requestedByActorType: opts.requestedByActorType ?? null, requestedByActorId: opts.requestedByActorId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null, missionIdForWake, contextSnapshot: enrichedContextSnapshot,
      contextSnapshotKey: deferredWakeContextKey,
      recordEvent: (recordDb, event) => recordHeartbeatQueueTransitionEvent(recordDb, event),
    });
  }, { label: "enqueueWakeup:paused-admission" });
  if (missionIdForWake) {
    try {
      await assertMissionRuntimeAcceptsWork(db, {
        companyId: agent.companyId,
        missionId: missionIdForWake,
      });
    } catch (err) {
      await writeSkippedRequest("mission.terminal");
      throw conflict(err instanceof Error ? err.message : "Mission is terminal", {
        missionId: missionIdForWake,
      });
    }
  }

  if (issueId && missionIdForWake) {
    const deferredOpsIssue = await deferOperationsMissionIssueToMainExecutor({
      agent,
      issueId,
      missionId: missionIdForWake,
    });
    if (deferredOpsIssue) {
      await writeSkippedRequest("operations_mission_issue_deferred_to_main_executor");
      if (deferredOpsIssue.mission.ownerAgentId !== agentId) {
        await enqueueHeartbeatWakeup(deps, deferredOpsIssue.mission.ownerAgentId, {
          source: "automation",
          triggerDetail: "operations_mission_boundary",
          reason: "operations_mission_issue_deferred_to_main_executor",
          idempotencyKey: `ops-mission-boundary:${missionIdForWake}:${issueId}:${deferredOpsIssue.ownerAction.id}`,
          requestedByActorType: "system",
          requestedByActorId: "heartbeat",
          payload: {
            issueId: deferredOpsIssue.ownerAction.id,
            sourceIssueId: issueId,
            operationsAgentId: agentId,
          },
          contextSnapshot: {
            taskKey: `issue:${deferredOpsIssue.ownerAction.id}`,
            issueId: deferredOpsIssue.ownerAction.id,
            missionId: missionIdForWake,
            sourceIssueId: issueId,
            roleBoundary: "hermes_ops_chief_of_staff_liaison",
          },
        });
      }
      return null;
    }
  }

  const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
    issueId,
    projectId,
  });
  if (budgetBlock) {
    await writeSkippedRequest("budget.blocked");
    throw conflict(budgetBlock.reason, {
      scopeType: budgetBlock.scopeType,
      scopeId: budgetBlock.scopeId,
    });
  }

  if (
    agent.status === "paused" ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    if (agent.status === "paused") {
      await queuePausedAgentWakeup();
      return null;
    }
    await writeSkippedRequest(`agent.${agent.status}`);
    return null;
  }

  const policy = parseHeartbeatPolicy(agent);

  if (source === "timer" && !policy.enabled) {
    await writeSkippedRequest("heartbeat.disabled");
    return null;
  }
  if (source !== "timer" && !policy.wakeOnDemand) {
    await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
    return null;
  }

  const bypassIssueExecutionLock =
    reason === "issue_comment_mentioned" ||
    readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

  if (issueId && !bypassIssueExecutionLock) {
    const agentNameKey = normalizeAgentNameKey(agent.name);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey, {
      missionId: readNonEmptyString(enrichedContextSnapshot.missionId),
    });
    const isWorkflowStepResume = isWorkflowStepResumeWake({
      requestKind: typedQueueColumns.requestKind,
      reason,
      payload,
      contextSnapshot: enrichedContextSnapshot,
    });

    const outcome = await withTxTimeout(db, async (tx) => {
      await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
      await tx.execute(
        sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0] ?? null);

      if (!issue) {
        await tx.insert(agentWakeupRequests).values({
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason: "issue_execution_issue_not_found",
          payload,
          status: "skipped",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          ...typedQueueColumns,
          finishedAt: new Date(),
        });
        return { kind: "skipped" as const };
      }

      // [T4 quality] 같은 quality wake 키의 기존 행이 있으면 새 행을 만들지 않고 그 상태를
      // 그대로 반환한다(통신 재전송 멱등 — 수락 원문은 최초 admission tx 에만 존재).
      const existingQualityWake = await findExistingQualityWakeRow(tx as unknown as Db, {
        companyId: agent.companyId,
        idempotencyKey: opts.idempotencyKey ?? null,
      });
      if (existingQualityWake) {
        return { kind: "quality_existing" as const, row: existingQualityWake };
      }

      let activeExecutionRun = issue.executionRunId
        ? await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, issue.executionRunId))
          .then((rows) => rows[0] ?? null)
        : null;

      if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
        activeExecutionRun = null;
      }

      if (!activeExecutionRun && issue.executionRunId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));
      }

      if (!activeExecutionRun) {
        const legacyRun = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, issue.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
              or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`),
            ),
          )
          .orderBy(
            sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
            asc(heartbeatRuns.createdAt),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (legacyRun) {
          activeExecutionRun = legacyRun;
          const legacyAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, legacyRun.agentId))
            .then((rows) => rows[0] ?? null);
          await tx
            .update(issues)
            .set({
              executionRunId: legacyRun.id,
              executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
              executionLockedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }
      }

      if (activeExecutionRun) {
        // [PLAN-QA rework serialization] mission_owner_plan_rework_requested and the T8
        // plan_qa_evidence_resubmission wake must not coalesce into the active same-agent
        // run and must not use deferred_issue_execution: the mission_plan_qa completion gate
        // auto-blocks the issue before the deferred-promotion loop runs, which would strand
        // the wake forever. Persist one queued agent_wakeup_requests row (runId=null) so the
        // queue runner owns promotion after the active run ends. Dedupe by the exact
        // idempotency key so distinct keys are never silently merged. Store the full enriched
        // context snapshot so the promoted follow-up retains its wake context.
        if ((reason === "mission_owner_plan_rework_requested" || reason === "plan_qa_evidence_resubmission") && opts.idempotencyKey) {
          const planReworkQueuedPayload = {
            ...(payload ?? {}),
            issueId,
            [deferredWakeContextKey]: enrichedContextSnapshot,
          };
          const existingQueuedPlanRework = await tx
            .select({ id: agentWakeupRequests.id, coalescedCount: agentWakeupRequests.coalescedCount, payload: agentWakeupRequests.payload })
            .from(agentWakeupRequests)
            .where(and(
              eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "queued"),
              eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey),
              sql`${agentWakeupRequests.runId} is null`,
            ))
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (existingQueuedPlanRework) {
            await tx
              .update(agentWakeupRequests)
              .set({ payload: preserveWorkflowAttemptProof(existingQueuedPlanRework.payload, planReworkQueuedPayload), coalescedCount: (existingQueuedPlanRework.coalescedCount ?? 0) + 1, updatedAt: new Date() })
              .where(eq(agentWakeupRequests.id, existingQueuedPlanRework.id));
          } else {
            await insertWorkflowWakeRequest(tx as unknown as Db, {
              ...wakeDefaults, payload: planReworkQueuedPayload,
            });
          }
          return { kind: "deferred" as const };
        }

        const executionAgent = await tx
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, activeExecutionRun.agentId))
          .then((rows) => rows[0] ?? null);
        const executionAgentNameKey =
          normalizeAgentNameKey(issue.executionAgentNameKey) ??
          normalizeAgentNameKey(executionAgent?.name);
        const isSameExecutionAgent =
          Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
        const shouldQueueFollowupForCommentWake =
          Boolean(wakeCommentId) &&
          activeExecutionRun.status === "running" &&
          isSameExecutionAgent;

        // [T4 quality] quality wake 는 다른 실행(동일 이름의 다른 agent 포함)에 절대
        // 병합·coalesce 되지 않는다 — 아래 deferred 경로로 별도 대기시킨다.
        if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake && !isBoundedExecutionWakeKey(opts.idempotencyKey)
          && !correctionRef && !await isCorrectionRun(tx as unknown as Db, activeExecutionRun)) {
          const mergedContextSnapshot = mergeCoalescedContextSnapshot(
            activeExecutionRun.contextSnapshot,
            enrichedContextSnapshot,
          );
          refreshStepInputManifest(mergedContextSnapshot, runTaskKey(activeExecutionRun));
          const mergedRun = await tx
            .update(heartbeatRuns)
            .set({
              contextSnapshot: mergedContextSnapshot,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, activeExecutionRun.id))
            .returning()
            .then((rows) => rows[0] ?? activeExecutionRun);

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_same_name",
            payload,
            ...typedQueueColumns,
            status: "coalesced",
            coalescedCount: 1,
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            runId: mergedRun.id,
            finishedAt: new Date(),
          });

          return { kind: "coalesced" as const, run: mergedRun };
        }

        const deferredPayload = {
          ...(payload ?? {}),
          issueId,
          [deferredWakeContextKey]: enrichedContextSnapshot,
        };

        const existingDeferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              mergeableWakeupKeyCondition(opts.idempotencyKey),
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (existingDeferred) {
          const existingDeferredPayload = parseObject(existingDeferred.payload);
          const existingDeferredContext = parseObject(existingDeferredPayload[deferredWakeContextKey]);
          const mergedDeferredContext = mergeCoalescedContextSnapshot(
            existingDeferredContext,
            enrichedContextSnapshot,
          );
          refreshStepInputManifest(
            mergedDeferredContext,
            deriveTaskKey(mergedDeferredContext, null),
          );
          const mergedDeferredPayload = {
            ...existingDeferredPayload,
            ...(payload ?? {}),
            issueId,
            [deferredWakeContextKey]: mergedDeferredContext,
          };

          await tx
            .update(agentWakeupRequests)
            .set({
              payload: mergedDeferredPayload,
              coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, existingDeferred.id));

          return { kind: "deferred" as const };
        }

        await insertWorkflowWakeRequest(tx as unknown as Db, {
          ...wakeDefaults, reason: "issue_execution_deferred", payload: deferredPayload, status: "deferred_issue_execution",
        });

        return { kind: "deferred" as const };
      }

      // [B] 같은 mission 에 이미 queued/running run 이 있으면 새 run 을 만들지
      // 않는다(중복 run/issue 차단). 대신 wakeup request 를 runId=null queued
      // 상태로 남겨 실행요청 Queue 처럼 처리하고, agent/mission slot 이 비면
      // startNextQueuedRunForAgent 가 실제 heartbeat run 으로 승격한다.
      const missionIdForDedup = readNonEmptyString(enrichedContextSnapshot.missionId);
      if (missionIdForDedup) {
        const inFlightClause = await lifecycleInFlightClause(tx as unknown as Parameters<typeof lifecycleInFlightClause>[0]);
        const existingMissionRun = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agentId),
              inFlightClause,
              sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionIdForDedup}`,
              // [oversight exemption] 정기 점검(리뷰) 실행은 같은 미션의 새 단계 실행 등록을 막지 않는다.
              missionDedupExemptOversightReviewClause,
            ),
          )
          .limit(1);
        if (existingMissionRun.length > 0) {
          const queuedPayload = {
            ...(payload ?? {}),
            issueId,
            [deferredWakeContextKey]: enrichedContextSnapshot,
          };
          const existingQueuedWake = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "queued"),
                sql`${agentWakeupRequests.runId} is null`,
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                mergeableWakeupKeyCondition(opts.idempotencyKey),
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingQueuedWake) {
            const existingQueuedPayload = parseObject(existingQueuedWake.payload);
            const existingQueuedContext = parseObject(existingQueuedPayload[deferredWakeContextKey]);
            const mergedQueuedContext = mergeCoalescedContextSnapshot(
              existingQueuedContext,
              enrichedContextSnapshot,
            );
            refreshStepInputManifest(
              mergedQueuedContext,
              deriveTaskKey(mergedQueuedContext, null),
            );
            const mergedQueuedPayload = {
              ...existingQueuedPayload,
              ...(payload ?? {}),
              issueId,
              [deferredWakeContextKey]: mergedQueuedContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedQueuedPayload,
                coalescedCount: (existingQueuedWake.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingQueuedWake.id));

            return { kind: "deferred" as const };
          }

          await insertWorkflowWakeRequest(tx as unknown as Db, {
            ...wakeDefaults, payload: queuedPayload,
          });
          return { kind: "deferred" as const };
        }
      }

      const wakeupRequest = await insertWorkflowWakeRequest(tx as unknown as Db, wakeDefaults).then((rows) => rows[0]);

      const newRun = await insertInitialWakeupRun(followupPromotionDeps, tx, {
        agent, request: wakeupRequest, contextSnapshot: enrichedContextSnapshot, taskKey,
        sessionBefore, issue, isWorkflowStepResume,
      });

      return { kind: "queued" as const, run: newRun };
    });

    // [Task 6C] mirror queue decision events based on enqueueWakeup outcome
    if (outcome.kind === "queued" && outcome.run) {
      await recordQueueTransitionEvent({
        companyId: agent.companyId,
        missionId: missionIdForWake,
        issueId: issueId ?? null,
        wakeupRequestId: outcome.run.wakeupRequestId,
        heartbeatRunId: outcome.run.id,
        eventType: "queue_accepted",
        layer: "queue",
        decision: "accepted",
        reason: "heartbeat_run_created",
        reasonCode: "heartbeat_run_created",
        idempotencyKey: `queue-accepted:${outcome.run.wakeupRequestId ?? "no-wake"}:${outcome.run.id}`,
      });
    } else if (outcome.kind === "deferred" || outcome.kind === "coalesced") {
      await recordQueueTransitionEvent({
        companyId: agent.companyId,
        missionId: missionIdForWake,
        issueId: issueId ?? null,
        eventType: "queue_waiting",
        layer: "queue",
        decision: "waiting",
        reason: "active_run_or_execution_lock",
        reasonCode: "active_run_or_execution_lock",
        idempotencyKey: `queue-waiting:${agent.companyId}:${agentId}:${issueId ?? "no-issue"}`,
      });
    }

    if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
    if (outcome.kind === "quality_existing") return null;
    if (outcome.kind === "coalesced") return outcome.run;

    const newRun = outcome.run;
    publishQueuedRun(newRun);

    await startNextQueuedRunForAgent(agent.id);
    return newRun;
  }

  // [mention-wake serialization] 잠긴 경로와 같은 입장 로직을 db/tx 양쪽에서 재사용한다.
  // 논리·필드는 기존 제네릭 입장과 동일하고, 실행기(execDb)만 갈린다.
  const admitUnlockedRun = async (execDb: Db) => {
    const activeRuns = await execDb
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const mergeableRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (const candidate of activeRuns) {
      if (!correctionRef && !await isCorrectionRun(execDb, candidate)) mergeableRuns.push(candidate);
    }
    const sameScopeQueuedRun = mergeableRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = mergeableRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      refreshStepInputManifest(mergedContextSnapshot, runTaskKey(coalescedTargetRun));
      const mergedRun = await execDb
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await execDb.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        ...typedQueueColumns,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return { run: mergedRun, coalesced: true };
    }

    const wakeupRequest = await insertWorkflowWakeRequest(execDb, wakeDefaults).then((rows) => rows[0]);

    const wakeupMissionId = readNonEmptyString(enrichedContextSnapshot.missionId);
    const wakeupEffectiveTaskKey = wakeupMissionId ? `mission:${wakeupMissionId}` : taskKey;
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, wakeupEffectiveTaskKey, {
      missionId: wakeupMissionId,
    });

    const newRun = await insertQueuedHeartbeat(execDb, {
      agent, issueId, source, triggerDetail, wakeupRequestId: wakeupRequest.id,
      contextSnapshot: enrichedContextSnapshot, taskKey, sessionBefore,
    });

    await execDb
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    return { run: newRun, coalesced: false };
  };

  // [mention-wake serialization] issueId 있는 코멘트-멘션 우회 깨움의 런 입장도 잠긴
  // 경로와 같은 직렬화 객체 — 같은 이슈 행 FOR UPDATE + withTxTimeout — 아래에서
  // 실행한다(동시 멘션 깨움의 런 중복 입장과 세대 경쟁, 멘션 × 일반 깨움의 교차-커밋
  // 경쟁을 입장 단계에서 차단). 우회 의미론은 유지: 이 트랜잭션은 issues 의
  // executionRunId/executionLockedAt 등 어느 필드도 쓰지 않고 직렬화 잠금만 가져간다.
  // [dispatchGeneration 비잠금 창 폐쇄] issueId 없는 taskKey 전용 경로도 같은
  //   withTxTimeout 안에서 입장한다 — resolveNextDispatchGeneration 의 어드바이저리
  //   트랜잭션 락이 count→insert 창을 직렬화하려면 입장 전체가 한 트랜잭션이어야 한다.
  //   입장 본문은 짧은 쿼리들뿐(외부 호출 없음)이라 타임아웃 상한 안에서 끝난다.
  const admission = issueId
    ? await withTxTimeout(
        db,
        async (tx) => {
          await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
          await tx.execute(
            sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
          );
          return admitUnlockedRun(tx as unknown as Db);
        },
        { label: "enqueueWakeup:mention-admission" },
      )
    : await withTxTimeout(
        db,
        async (tx) => {
          await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
          return admitUnlockedRun(tx as unknown as Db);
        },
        { label: "enqueueWakeup:taskkey-admission" },
      );

  if (!admission.coalesced) {
    publishQueuedRun(admission.run);

    await startNextQueuedRunForAgent(agent.id);
  }

  return admission.run;
}

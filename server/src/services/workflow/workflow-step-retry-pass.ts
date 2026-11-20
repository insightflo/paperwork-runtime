import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { isWorkflowControlNode } from "./control-flow/control-node-executor.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import {
  appendRetryAttempt,
  hasMalformedWorkflowRetry,
  normalizeWorkflowRetryPolicy,
  readWorkflowRetryMetadata,
  sanitizeErrorSummary,
  type WorkflowRetryAttemptSummary,
  type WorkflowRetryPolicy,
} from "./retry-policy.js";
import { hasActiveWorkflowRetryRecoveryExecution } from "./retry-execution-state.js";
import { scheduleWorkflowStepRetry } from "./step-retry-scheduler.js";
import {
  classifyRetryBatchWithNodeFallback,
  type WorkflowRetryBatchClassifyItem,
} from "./workflow-core-client-s4.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

export interface RetryValidationVerdictObservation {
  verdict: "pass" | "request_changes" | null;
  observedAt: Date | null;
}

export interface WorkflowStepRetryPassContext {
  run: { id: string; companyId: string; status: string };
  steps: WorkflowStep[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function supportedStepType(step: WorkflowStep): boolean {
  const stepType = typeof step.type === "string" ? step.type.trim().toLowerCase() : "";
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((tool) => typeof tool === "string" && tool.trim().length > 0);
  if (stepType === "if" || stepType === "complete") return false;
  // [descope D2] workflow-type S 는 retry 스케줄링에서 명시 제외다 — 자식 실패는 부모 스텝의
  //   종말 정산이고, 재실행은 새 최상위 run 의 몫이다(세대 교체/재개 재시도 없음).
  if (stepType === "workflow") return false;
  return stepType === "" || stepType === "agent" || (stepType === "tool" && hasToolNames);
}


async function clearRetryMetadata(input: {
  db: Db;
  failedRun: StepRun;
  metadata: Record<string, unknown>;
  appendTerminalAttempt: boolean;
  exhaustion?: { attempts: number; maxRetries: number } | null;
}): Promise<boolean> {
  const retry = readWorkflowRetryMetadata(input.metadata.workflowRetry);
  if (input.appendTerminalAttempt && !retry) return false;
  const cleaned = { ...input.metadata };
  if (retry && input.appendTerminalAttempt) {
    const attempt: WorkflowRetryAttemptSummary = {
      retryNumber: retry.retryNumber,
      failedAt: input.failedRun.completedAt?.toISOString() ?? null,
      errorSummary: sanitizeErrorSummary(input.failedRun.lastDispatchErrorSummary),
    };
    cleaned.workflowRetryAttempts = appendRetryAttempt(
      cleaned.workflowRetryAttempts,
      attempt,
    );
  }
  delete cleaned.workflowRetry;
  delete cleaned.workflowRetryExhaustion;
  if (input.exhaustion) cleaned.workflowRetryExhaustion = input.exhaustion;

  const updated = await input.db.update(workflowStepRuns)
    .set({ metadata: cleaned })
    .where(and(
      eq(workflowStepRuns.id, input.failedRun.id),
      eq(workflowStepRuns.workflowRunId, input.failedRun.workflowRunId),
      eq(workflowStepRuns.status, "failed"),
      eq(workflowStepRuns.retryCount, input.failedRun.retryCount),
      eq(workflowStepRuns.metadata, input.failedRun.metadata),
    ))
    .returning({ id: workflowStepRuns.id });
  return updated.length > 0;
}

export async function applyWorkflowStepRetryPass(input: {
  db: Db;
  context: WorkflowStepRetryPassContext;
  stepRuns: StepRun[];
  validationVerdictsByIssueId: Map<string, RetryValidationVerdictObservation>;
}): Promise<StepRun[]> {
  if (input.context.run.status === "cancelled") return input.stepRuns;
  const failedRuns = input.stepRuns.filter((stepRun) => stepRun.status === "failed");
  if (failedRuns.length === 0) return input.stepRuns;

  let metadataChanged = false;
  // [Rust 4B] 분류 입력을 먼저 모아 classify-retry-batch 스폰 1회로 판정한다 —
  //   스폰은 db.transaction 밖(이 pass 자체가 비-tx, scheduleWorkflowStepRetry 가
  //   각 건의 tx 를 연다)에서만 일어난다. 판정 적용 순서는 기존 루프와 동일하다.
  const batchItems: WorkflowRetryBatchClassifyItem[] = [];
  const pendingByStepRunId = new Map<string, {
    failedRun: StepRun;
    metadata: Record<string, unknown>;
    hasRetry: boolean;
    policy: WorkflowRetryPolicy;
  }>();
  for (const failedRun of failedRuns) {
    const step = input.context.steps.find((candidate) => candidate.id === failedRun.stepId);
    if (!step) continue;
    // [descope D2] workflow-type S 는 이 pass 의 "어떤 변이도" 금지된다 — malformed metadata
    //   정리(수리)조차 예외다(수리 없음, fail-closed). retryCount/metadata 는 호출자가 존중해야 할
    //   신원 값이고, 거부는 구조화 사유로 통과된다(무변경).
    if (isWorkflowChildStep(step)) continue;
    const metadata = record(failedRun.metadata);
    if (hasMalformedWorkflowRetry(metadata)) {
      await clearRetryMetadata({
        db: input.db,
        failedRun,
        metadata,
        appendTerminalAttempt: false,
      });
      metadataChanged = true;
      continue;
    }

    const hasRetry = readWorkflowRetryMetadata(metadata.workflowRetry) !== null;
    const policy = normalizeWorkflowRetryPolicy(step);
    if (!policy.enabled) {
      if (hasRetry) {
        await clearRetryMetadata({
          db: input.db,
          failedRun,
          metadata,
          appendTerminalAttempt: true,
        });
        metadataChanged = true;
      }
      continue;
    }

    const qaVerdict = failedRun.issueId
      ? input.validationVerdictsByIssueId.get(failedRun.issueId)
      : undefined;
    const structuralGateExcluded = failedRun.lastDispatchErrorSummary
      === "structural_gate_request_changes"
      || failedRun.lastDispatchErrorSummary === "structural_gate_contract_failure";
    const recoveryActive = failedRun.issueId
      ? await hasActiveWorkflowRetryRecoveryExecution(input.db, {
        companyId: input.context.run.companyId,
        issueId: failedRun.issueId,
      })
      : false;
    const controlNode = isWorkflowControlNode(step);
    batchItems.push({
      id: failedRun.id,
      policy,
      stepRunStatus: failedRun.status,
      retryCount: failedRun.retryCount,
      isControlNode: controlNode,
      stepTypeSupported: !controlNode && supportedStepType(step),
      isQaStep: isQaLikeStep(step),
      qaRequestChanges: qaVerdict?.verdict === "request_changes" || structuralGateExcluded,
      recoveryActive,
      jitterRandom: Math.random(),
    });
    pendingByStepRunId.set(failedRun.id, { failedRun, metadata, hasRetry, policy });
  }

  const decisionByStepRunId = new Map(
    (await classifyRetryBatchWithNodeFallback({ items: batchItems }))
      .map((decision) => [decision.id, decision] as const),
  );
  for (const [stepRunId, pending] of pendingByStepRunId) {
    const { failedRun, metadata, hasRetry, policy } = pending;
    const decision = decisionByStepRunId.get(stepRunId);
    if (!decision) continue;
    if (decision.eligible) {
      const errorSummary = failedRun.lastDispatchErrorSummary
        ?? (metadata.toolResult as Record<string, unknown> | undefined)?.error as string | undefined
        ?? null;
      const result = await scheduleWorkflowStepRetry(input.db, {
        companyId: input.context.run.companyId,
        workflowRunId: input.context.run.id,
        stepRunId: failedRun.id,
        retryNumber: decision.retryNumber,
        maxRetries: decision.maxRetries,
        delaySeconds: decision.delaySeconds,
        observedStatus: failedRun.status,
        observedRetryCount: failedRun.retryCount,
        observedCompletedAt: failedRun.completedAt,
        observedLastDispatchRequestId: failedRun.lastDispatchRequestId,
        observedMetadataSnapshot: record(failedRun.metadata),
        errorSummary,
        observedExecutionGeneration: failedRun.executionGeneration,
      });
      if (result.result === "scheduled") metadataChanged = true;
      continue;
    }
    if (!hasRetry || decision.reason === "recovery_active") continue;
    await clearRetryMetadata({
      db: input.db,
      failedRun,
      metadata,
      appendTerminalAttempt: true,
      exhaustion: decision.reason === "exhausted"
        ? { attempts: failedRun.retryCount + 1, maxRetries: policy.maxRetries }
        : null,
    });
    metadataChanged = true;
  }

  return metadataChanged
    ? input.db.select().from(workflowStepRuns).where(eq(
      workflowStepRuns.workflowRunId,
      input.context.run.id,
    ))
    : input.stepRuns;
}

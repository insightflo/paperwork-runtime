import { eq } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import type { WorkflowExecutionContext, WorkflowStep } from "./dag-engine.js";
import { buildStepRunMap, toConditionalStepObservation } from "./dag-step-observation.js";
import { buildPredFactsMap, type ValidationVerdictObservation } from "./dag-readiness-facts.js";
import { normalizeRecord } from "./dag-metadata-helpers.js";
import { classifyStepActivation, resolveEdges, type StepActivation } from "./control-flow/edge-condition.js";
import { activateStepsWithNodeFallback } from "./workflow-core-client-s5.js";
import { reviveConditionalSkip } from "./conditional-skip-settlement.js";
import { reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { buildWorkflowStepRunMetadata } from "./workflow-step-run-maintenance.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

export type ControlFlowSkipRevivalPassResult = {
  stepRuns: StepRun[];
  proofLost: boolean;
};

/**
 * Revive only skipped rows whose current edge facts are executable again.
 * The sentinel itself is never sufficient authority: legitimate false-branch
 * skips remain closed because classifyStepActivation keeps them non-runnable.
 */
export async function reviveRunnableControlFlowSkippedSteps(input: {
  db: Db;
  context: WorkflowExecutionContext;
  stepRuns: StepRun[];
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation>;
  v1EnforcementEnabled: boolean;
  issueStatusByIssueId?: Map<string, string>;
  onlyEdgeStepIds?: ReadonlySet<string>;
}): Promise<ControlFlowSkipRevivalPassResult> {
  if (input.context.run.status === "cancelled") {
    return { stepRuns: input.stepRuns, proofLost: false };
  }

  let stepRuns = input.stepRuns;
  let proofLost = false;
  const reviveRunMap = buildStepRunMap(stepRuns);
  // Revive consumes the same v1 fact snapshot as launch so a predecessor that
  // is not dispatch-ready cannot accidentally reopen downstream work first.
  let revivePredsByStepId = buildPredFactsMap(
    input.context.steps,
    reviveRunMap,
    input.validationVerdictsByIssueId,
    input.v1EnforcementEnabled,
    input.issueStatusByIssueId,
  );
  // Batch activation through the Node/Rust fallback once, then invalidate the
  // batch whenever a revival changes predecessor facts.
  let reviveActivations: Map<string, StepActivation> | null = null;
  let revivedAny = false;
  const onlyEdgeStepIds = input.onlyEdgeStepIds;

  for (const step of input.context.steps) {
    const stepRun = reviveRunMap.get(step.id);
    if (!stepRun || stepRun.status !== "skipped" || normalizeRecord(stepRun.metadata).controlFlowSkipped !== true) continue;
    if (onlyEdgeStepIds && !resolveEdges(step).some((edge) => onlyEdgeStepIds.has(edge.stepId))) continue;
    reviveActivations ??= await activateStepsWithNodeFallback(input.context.steps, revivePredsByStepId);
    const activation = reviveActivations.get(step.id) ?? classifyStepActivation(step, revivePredsByStepId);
    if (!activation.runnable) continue;

    const nextMetadata = { ...buildWorkflowStepRunMetadata(step, stepRun.metadata), controlFlowSkipped: false };
    const result = await reviveConditionalSkip(input.db, {
      observedRun: input.context.run,
      target: stepRun,
      nextMetadata,
      observedPredecessors: stepRuns
        .filter((predecessor) => predecessor.id !== stepRun.id)
        .map(toConditionalStepObservation),
      invalidateGeneration: input.v1EnforcementEnabled,
    });
    if (result.kind !== "settled") {
      // The CAS proof was lost after the snapshot was taken. Reload authority and
      // stop this sync's derived passes; a later sync re-evaluates fresh state.
      proofLost = true;
      stepRuns = await reloadWorkflowStepRunsForSameRun(input.db, stepRuns);
      break;
    }

    revivedAny = true;
    // Keep later candidates on the authoritative observation returned by the CAS
    // write; otherwise a revived predecessor still looks skipped and causes a
    // false proof loss on the next row.
    stepRun.status = "pending";
    stepRun.startedAt = null;
    stepRun.completedAt = null;
    stepRun.dispatchReadyAt = null;
    stepRun.evidenceReadyAt = null;
    stepRun.dispatchOwnerWakeupRequestId = null;
    stepRun.dispatchOwnerHeartbeatRunId = null;
    stepRun.executionGeneration = result.executionGeneration;
    stepRun.statusTransitionVersion = result.statusTransitionVersion;
    stepRun.metadata = nextMetadata;
    revivePredsByStepId = buildPredFactsMap(
      input.context.steps,
      reviveRunMap,
      input.validationVerdictsByIssueId,
      input.v1EnforcementEnabled,
      input.issueStatusByIssueId,
    );
    reviveActivations = null;
  }

  if (revivedAny) {
    stepRuns = await input.db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, input.context.run.id));
  }
  return { stepRuns, proofLost };
}

/**
 * Finalization guard: true when a control-flow-skipped row is executable under
 * the current edge facts. Such a row is stale recovery residue, not completed work.
 */
export function hasRunnableControlFlowSkippedStep(input: {
  steps: WorkflowStep[];
  stepRuns: StepRun[];
  validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation>;
  v1EnforcementEnabled?: boolean;
  issueStatusByIssueId?: Map<string, string>;
  dynamicLaunchStepIds?: Set<string>;
}): boolean {
  const stepRunMap = buildStepRunMap(input.stepRuns);
  const predsByStepId = buildPredFactsMap(
    input.steps,
    stepRunMap,
    input.validationVerdictsByIssueId,
    input.v1EnforcementEnabled,
    input.issueStatusByIssueId,
  );
  return input.steps.some((step) => {
    if (input.dynamicLaunchStepIds && !input.dynamicLaunchStepIds.has(step.id)) return false;
    const stepRun = stepRunMap.get(step.id);
    if (!stepRun || stepRun.status !== "skipped" || normalizeRecord(stepRun.metadata).controlFlowSkipped !== true) return false;
    return classifyStepActivation(step, predsByStepId).runnable;
  });
}

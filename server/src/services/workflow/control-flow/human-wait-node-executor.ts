// Stage 26 Wave 3c: explicit human_wait DAG node executor.
// Runs inside the workflow launch loop's synchronous branch family (control nodes, child
// steps, issue-less tools): a human_wait node never creates an issue, wakes an agent, or
// dispatches tools. Each evaluation goes through the Wave 3b structured gate
// (evaluateHumanWaitGate) and the directive mapper (buildHumanWaitStepDirective), which
// read ONLY the structured operator_decisions row — no natural-language parsing anywhere
// (rule 8). A pending decision leaves the step untouched (paused, still pending); an
// approved decision completes the step so the same sync continues downstream; a
// rejected/expired decision fails the step through the existing step-failure contract.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { workflowHumanWaitDecisionTemplateSchema } from "@paperclipai/shared/validators/workflow";
import type { WorkflowExecutionContext, WorkflowStep } from "../dag-engine.js";
import { evaluateHumanWaitGate } from "./human-wait-gate.js";
import { buildHumanWaitStepDirective, type HumanWaitStepAction } from "./human-wait-resume.js";

type WorkflowStepRunRow = typeof workflowStepRuns.$inferSelect;

/** Persisted step-run metadata key holding the structured human-wait decision outcome. */
export const HUMAN_WAIT_DECISION_METADATA_KEY = "humanWaitDecision";

/**
 * Explicit Two-Graph node type check — `type === "human_wait"` ONLY. The legacy
 * graphApprovalRequired promotion (isHumanWaitStepDefinition) is intentionally NOT used
 * here so every pre-existing step shape keeps its exact current dispatch behavior.
 */
export function isExplicitHumanWaitNode(step: WorkflowStep): boolean {
  return step.type === "human_wait";
}

/** Template jsonb rides the normalize spread; the engine interface doesn't declare it, so
 *  read it through the same raw-field extension pattern as PersistedWorkflowStep. */
type HumanWaitTemplateCarrier = WorkflowStep & { decisionTemplate?: unknown };

/** Template jsonb is preset metadata (rule 8): a malformed value falls back to the default card. */
function readDecisionTemplate(step: WorkflowStep) {
  const parsed = workflowHumanWaitDecisionTemplateSchema.safeParse((step as HumanWaitTemplateCarrier).decisionTemplate);
  return parsed.success ? parsed.data : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Display-only failure summary; authority stays in the structured metadata record. */
function failedDispatchSummary(reasonCode: string): string {
  return reasonCode === "human_decision_expired"
    ? "Workflow human wait expired without approval"
    : "Workflow human wait was not approved";
}

/**
 * One human_wait node evaluation on the launch loop. The structured gate verdict governs
 * the transition: pause → no step-run write at all (the card was already ensured
 * idempotently by the gate), otherwise claim the pending step with a run-scoped CAS and
 * write the terminal state exactly like control nodes do. A lost claim race returns
 * hold_waiting_approval so the owning pass keeps the transition.
 */
export async function executeHumanWaitNode(input: {
  db: Db;
  context: WorkflowExecutionContext;
  step: WorkflowStep;
  stepRun: WorkflowStepRunRow;
}): Promise<HumanWaitStepAction> {
  if (!isExplicitHumanWaitNode(input.step)) return "hold_waiting_approval";
  const { db, context, step, stepRun } = input;
  const generation = stepRun.executionGeneration;
  const gate = await evaluateHumanWaitGate(db, {
    companyId: context.run.companyId,
    workflowRunId: context.run.id,
    stepKey: step.id,
    generation,
    missionId: context.run.missionId,
    issueId: null,
    stepName: step.name,
    decisionTemplate: readDecisionTemplate(step),
  });
  const directive = buildHumanWaitStepDirective(gate, {
    workflowRunId: context.run.id,
    stepKey: step.id,
    generation,
  });
  if (directive.stepAction === "hold_waiting_approval") return directive.stepAction;

  const claimed = await db
    .update(workflowStepRuns)
    .set({ status: "running", startedAt: stepRun.startedAt ?? new Date(), completedAt: null })
    .where(and(
      eq(workflowStepRuns.id, stepRun.id),
      eq(workflowStepRuns.workflowRunId, context.run.id),
      eq(workflowStepRuns.status, "pending"),
    ))
    .returning({ id: workflowStepRuns.id });
  if (claimed.length === 0) return "hold_waiting_approval";

  const now = new Date();
  const metadata = normalizeRecord(stepRun.metadata);
  metadata[HUMAN_WAIT_DECISION_METADATA_KEY] = {
    schemaVersion: 1,
    decisionId: directive.decisionId,
    requestKey: directive.requestKey,
    reasonCode: directive.reasonCode,
    resolvedAt: now.toISOString(),
  };

  if (directive.stepAction === "complete_and_continue") {
    await db
      .update(workflowStepRuns)
      .set({
        status: "completed",
        completedAt: now,
        dispatchReadyAt: now,
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        metadata,
      })
      .where(and(
        eq(workflowStepRuns.id, stepRun.id),
        eq(workflowStepRuns.workflowRunId, context.run.id),
        eq(workflowStepRuns.status, "running"),
      ));
    return directive.stepAction;
  }

  await db
    .update(workflowStepRuns)
    .set({
      status: "failed",
      completedAt: now,
      lastDispatchErrorAt: now,
      lastDispatchErrorSummary: failedDispatchSummary(directive.reasonCode),
      metadata,
    })
    .where(and(
      eq(workflowStepRuns.id, stepRun.id),
      eq(workflowStepRuns.workflowRunId, context.run.id),
      eq(workflowStepRuns.status, "running"),
    ));
  return directive.stepAction;
}

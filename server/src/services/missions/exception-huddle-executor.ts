import {
  exceptionHuddleDecisionSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";

export type ExceptionHuddleDecisionNotReady = {
  readonly ok: false;
  readonly code: "huddle_decision_not_ready";
};

export type RetryExistingStepExecutionCommand = {
  readonly kind: "retry_existing_step";
  readonly createUnblockIssue: false;
  readonly workflowRunId: string;
  readonly sourceStepId: string;
  readonly sourceIssueId: string | null;
  readonly guidance: string;
  readonly rationale: string;
  readonly forcedByChair: boolean;
  readonly idempotencyKey: string;
};

export type RecordWaiverPassExecutionCommand = {
  readonly kind: "record_waiver_pass";
  readonly workflowRunId: string;
  readonly sourceStepId: string;
  readonly sourceIssueId: string | null;
  readonly waiverCondition: string;
  readonly rationale: string;
  readonly forcedByChair: boolean;
  readonly idempotencyKey: string;
};

export type ReplanRemainingStepsExecutionCommand = {
  readonly kind: "replan_remaining_steps";
  readonly missionId: string;
  readonly workflowRunId: string;
  readonly sourceStepId: string;
  readonly replanSummary: string;
  readonly rationale: string;
  readonly forcedByChair: boolean;
  readonly idempotencyKey: string;
};

export type EscalateToOperatorExecutionCommand = {
  readonly kind: "escalate_to_operator";
  readonly missionId: string;
  readonly workflowRunId: string;
  readonly sourceStepId: string;
  readonly sourceIssueId: string | null;
  readonly escalationReason: string;
  readonly rationale: string;
  readonly forcedByChair: boolean;
  readonly idempotencyKey: string;
};

export type ExceptionHuddleExecutionCommand =
  | RetryExistingStepExecutionCommand
  | RecordWaiverPassExecutionCommand
  | ReplanRemainingStepsExecutionCommand
  | EscalateToOperatorExecutionCommand;

export type ExceptionHuddleExecutionPlan =
  | { readonly ok: true; readonly command: ExceptionHuddleExecutionCommand }
  | ExceptionHuddleDecisionNotReady;

export type ExceptionHuddleExecutionHandlers = {
  readonly onRetryWithGuidance: (command: RetryExistingStepExecutionCommand) => unknown;
  readonly onAcceptWithWaiver: (command: RecordWaiverPassExecutionCommand) => unknown;
  readonly onReplanRemaining: (command: ReplanRemainingStepsExecutionCommand) => unknown;
  readonly onEscalate: (command: EscalateToOperatorExecutionCommand) => unknown;
};

const notReady = (): ExceptionHuddleDecisionNotReady => ({ ok: false, code: "huddle_decision_not_ready" });

function executionIdempotencyKey(
  huddle: ExceptionHuddleMetadata,
  decisionKind: ExceptionHuddleDecision["kind"],
): string {
  return `huddle-exec:${huddle.workflowRunId}:${huddle.sourceStepId}:${decisionKind}`;
}

export function planExceptionHuddleExecution(huddle: ExceptionHuddleMetadata): ExceptionHuddleExecutionPlan {
  if (huddle.status !== "decided" || !huddle.decision) return notReady();
  const parsed = exceptionHuddleDecisionSchema.safeParse(huddle.decision);
  if (!parsed.success) return notReady();
  const decision = parsed.data;
  const idempotencyKey = executionIdempotencyKey(huddle, decision.kind);

  switch (decision.kind) {
    case "retry_with_guidance":
      return { ok: true, command: {
        kind: "retry_existing_step",
        createUnblockIssue: false,
        workflowRunId: huddle.workflowRunId,
        sourceStepId: huddle.sourceStepId,
        sourceIssueId: huddle.sourceIssueId,
        guidance: decision.guidance!,
        rationale: decision.rationale,
        forcedByChair: decision.forcedByChair,
        idempotencyKey,
      } };
    case "accept_with_waiver":
      return { ok: true, command: {
        kind: "record_waiver_pass",
        workflowRunId: huddle.workflowRunId,
        sourceStepId: huddle.sourceStepId,
        sourceIssueId: huddle.sourceIssueId,
        waiverCondition: decision.waiverCondition!,
        rationale: decision.rationale,
        forcedByChair: decision.forcedByChair,
        idempotencyKey,
      } };
    case "replan_remaining":
      return { ok: true, command: {
        kind: "replan_remaining_steps",
        missionId: huddle.missionId,
        workflowRunId: huddle.workflowRunId,
        sourceStepId: huddle.sourceStepId,
        replanSummary: decision.replanSummary!,
        rationale: decision.rationale,
        forcedByChair: decision.forcedByChair,
        idempotencyKey,
      } };
    case "escalate":
      return { ok: true, command: {
        kind: "escalate_to_operator",
        missionId: huddle.missionId,
        workflowRunId: huddle.workflowRunId,
        sourceStepId: huddle.sourceStepId,
        sourceIssueId: huddle.sourceIssueId,
        escalationReason: decision.escalationReason!,
        rationale: decision.rationale,
        forcedByChair: decision.forcedByChair,
        idempotencyKey,
      } };
  }
}

export function executeExceptionHuddleDecision(
  huddle: ExceptionHuddleMetadata,
  handlers: ExceptionHuddleExecutionHandlers,
): ExceptionHuddleExecutionPlan {
  const plan = planExceptionHuddleExecution(huddle);
  if (!plan.ok) return plan;
  switch (plan.command.kind) {
    case "retry_existing_step":
      handlers.onRetryWithGuidance(plan.command);
      break;
    case "record_waiver_pass":
      handlers.onAcceptWithWaiver(plan.command);
      break;
    case "replan_remaining_steps":
      handlers.onReplanRemaining(plan.command);
      break;
    case "escalate_to_operator":
      handlers.onEscalate(plan.command);
      break;
  }
  return plan;
}

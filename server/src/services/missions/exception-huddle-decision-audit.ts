import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  planExceptionHuddleExecution,
  type ExceptionHuddleExecutionCommand,
} from "./exception-huddle-executor.js";

export type ExceptionHuddleDecisionAuditResult =
  | { readonly recorded: false; readonly code: "huddle_decision_not_ready" }
  | {
    readonly recorded: true;
    readonly plan: ExceptionHuddleExecutionCommand;
    readonly inserted: boolean;
  };

export async function recordExceptionHuddleExecutionPlan(
  db: Db,
  input: {
    companyId: string;
    threadId: string;
    huddle: ExceptionHuddleMetadata;
    now?: Date;
  },
): Promise<ExceptionHuddleDecisionAuditResult> {
  const planned = planExceptionHuddleExecution(input.huddle);
  if (!planned.ok) return { recorded: false, code: planned.code };
  const plan = planned.command;
  const inserted = await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.huddle.missionId,
    workflowRunId: input.huddle.workflowRunId,
    issueId: input.huddle.sourceIssueId,
    eventType: "exception_huddle_decision_planned",
    layer: "mission_owner_recovery",
    reasonCode: input.huddle.decision!.kind,
    idempotencyKey: plan.idempotencyKey,
    payload: { threadId: input.threadId, plan },
    createdAt: input.now ?? new Date(),
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  return { recorded: true, plan, inserted: inserted.length > 0 };
}

// Stage 26 Wave 3: human_wait decision card creator.
// Bridges WorkflowHumanWaitDecisionTemplate into a structured operator_decisions card.
// Template fields map 1:1 into title/description/option labels/facts — there is no
// natural-language parsing here, and decision authority stays in operator_decisions.result
// (rule 8: the template is preset metadata, never execution authority).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { operatorDecisions } from "@paperclipai/db";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
} from "@paperclipai/shared/types/operator-decision";
import type { WorkflowHumanWaitDecisionTemplate } from "@paperclipai/shared/validators/workflow";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";

export const HUMAN_WAIT_SOURCE_TYPE = "workflow_human_wait";

const APPROVE_OPTION_ID = "approve";
const REJECT_OPTION_ID = "reject";
const SUBMIT_ACTION_ID = "submit";
const DEFAULT_APPROVAL_LABEL = "Approve";
const DEFAULT_REJECT_LABEL = "Reject";

export interface HumanWaitRequestKeyParams {
  companyId: string;
  workflowRunId: string;
  stepKey: string;
  generation: number;
}

export interface HumanWaitDecisionCardParams extends HumanWaitRequestKeyParams {
  missionId: string | null;
  issueId: string | null;
  stepName: string;
  decisionTemplate: WorkflowHumanWaitDecisionTemplate | null;
}

/** CreateOperatorDecisionInput plus the owning company for scoped inserts. */
export type HumanWaitDecisionCardInput = CreateOperatorDecisionInput & { companyId: string };

export interface HumanWaitDecisionCardResult {
  card: typeof operatorDecisions.$inferSelect;
  /** true when this call inserted the card; false when an existing card was returned. */
  created: boolean;
}

/**
 * Deterministic idempotency key: identical (company, run, step, generation) inputs always
 * produce the same key, so retries hit the operator_decisions_company_request_uq index
 * instead of creating duplicate decision cards.
 */
export function buildHumanWaitRequestKey(params: HumanWaitRequestKeyParams): string {
  return `human-wait:${params.companyId}:${params.workflowRunId}:${params.stepKey}:${params.generation}`;
}

const clip = (value: string, max: number): string => value.length > max ? value.slice(0, max) : value;

/** Preset template metadata becomes structured option facts (known status), never prose choices. */
function templateFacts(template: WorkflowHumanWaitDecisionTemplate): OperatorDecisionDefinition["options"][number]["facts"] {
  const facts: OperatorDecisionDefinition["options"][number]["facts"] = [];
  if (template.requiredRole != null && template.requiredRole !== "") {
    facts.push({ label: "Required role", value: template.requiredRole, status: "known" });
  }
  if (template.timeoutMinutes != null) {
    facts.push({ label: "Timeout", value: `${template.timeoutMinutes} minutes`, status: "known" });
  }
  return facts;
}

/**
 * Maps a human_wait step's decision template cleanly into the strict structured
 * operator_decisions create payload. Validation and hashing happen through
 * validateAndHashOperatorDecisionCreate when the card is inserted.
 */
export function buildHumanWaitDecisionInput(params: HumanWaitDecisionCardParams): HumanWaitDecisionCardInput {
  const template = params.decisionTemplate ?? {};
  const allowReject = template.allowReject !== false;
  const approvalLabel = template.approvalLabel ?? DEFAULT_APPROVAL_LABEL;
  const rejectLabel = template.rejectLabel ?? DEFAULT_REJECT_LABEL;
  const facts = templateFacts(template);
  const options = [
    {
      id: APPROVE_OPTION_ID,
      label: approvalLabel,
      description: null,
      facts,
      evidenceRefs: [],
    },
    ...(allowReject ? [{
      id: REJECT_OPTION_ID,
      label: rejectLabel,
      description: null,
      facts,
      evidenceRefs: [],
    }] : []),
  ];
  const definition: OperatorDecisionDefinition = {
    options,
    actions: [{
      id: SUBMIT_ACTION_ID,
      label: clip(approvalLabel, 80),
      outcome: "submit",
      tone: "primary",
      requiresSelection: true,
    }],
    selection: { min: 1, max: 1 },
    // Enabled comment mode requires a non-null label and positive max length (commentSchema).
    comment: { mode: "optional", label: "Comment", placeholder: null, maxLength: 2_000 },
    approvedScope: [],
    forbiddenScope: [],
    humanReview: null,
  };
  return {
    companyId: params.companyId,
    schemaVersion: 1,
    requestKey: buildHumanWaitRequestKey(params),
    priority: "high",
    interactionType: "single_select",
    title: clip(template.title ?? `Human approval: ${params.stepName}`, 200),
    description: clip(
      template.prompt ?? `Step "${params.stepName}" is waiting for a human decision before the workflow can continue.`,
      4_000,
    ),
    sourceType: HUMAN_WAIT_SOURCE_TYPE,
    sourceId: clip(`${params.workflowRunId}:${params.stepKey}`, 200),
    sourceContext: {
      missionId: params.missionId,
      workflowId: null,
      workflowRunId: params.workflowRunId,
      artifactRefs: [],
      // generation rides the schema-validated currentness snapshot, not free-form metadata.
      targetSnapshot: { executionGeneration: params.generation },
    },
    definition,
    issueId: params.issueId,
    continuationMode: params.issueId ? "issue_current_assignee" : "none",
  };
}

/**
 * Idempotent insert-or-return-existing keyed by (companyId, requestKey). Concurrent
 * inserters lose the ON CONFLICT race atomically and read back the winner's row, so
 * retries never create duplicate decision cards. Fails closed if the conflicting row
 * vanished before read-back.
 */
export async function ensureHumanWaitDecisionCard(
  db: Db,
  input: HumanWaitDecisionCardInput,
): Promise<HumanWaitDecisionCardResult> {
  const { companyId, ...create } = input;
  const { requestHash } = validateAndHashOperatorDecisionCreate(create);
  const [inserted] = await db.insert(operatorDecisions).values({
    companyId,
    requestKey: create.requestKey,
    requestHash,
    schemaVersion: 1,
    priority: create.priority,
    interactionType: create.interactionType,
    title: create.title,
    description: create.description,
    sourceType: create.sourceType,
    sourceId: create.sourceId,
    sourceContext: create.sourceContext,
    definition: create.definition,
    issueId: create.issueId,
    continuationMode: create.continuationMode,
  }).onConflictDoNothing({
    target: [operatorDecisions.companyId, operatorDecisions.requestKey],
  }).returning();
  if (inserted) return { card: inserted, created: true };
  const [existing] = await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId),
    eq(operatorDecisions.requestKey, create.requestKey),
  ));
  if (!existing) throw new Error(`human wait decision card missing after conflict: ${create.requestKey}`);
  return { card: existing, created: false };
}

import { z } from "zod";

export const EXCEPTION_HUDDLE_MAX_ROUNDS = 2;
export const EXCEPTION_HUDDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const exceptionHuddleRoleSchema = z.enum(["owner", "producer", "validator"]);
export const exceptionHuddleStatusSchema = z.enum(["open", "decided", "timed_out", "cancelled"]);
export const exceptionHuddleDecisionKindSchema = z.enum([
  "retry_with_guidance", "accept_with_waiver", "replan_remaining", "escalate",
]);

const text = z.string().trim().min(1);
const decisionFields = {
  retry_with_guidance: "guidance",
  accept_with_waiver: "waiverCondition",
  replan_remaining: "replanSummary",
  escalate: "escalationReason",
} as const;

export const exceptionHuddleDecisionSchema = z.object({
  kind: exceptionHuddleDecisionKindSchema,
  rationale: text.max(4000),
  guidance: text.optional(),
  waiverCondition: text.optional(),
  replanSummary: text.optional(),
  escalationReason: text.optional(),
  forcedByChair: z.boolean().default(false),
}).strict().superRefine((decision, ctx) => {
  const field = decisionFields[decision.kind];
  if (decision[field] === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required` });
  }
});

const id = z.string().trim().min(1);
export const exceptionHuddleMetadataSchema = z.object({
  schemaVersion: z.literal("workflow.exception-huddle.v1"),
  missionId: id,
  workflowRunId: id,
  sourceStepId: id,
  sourceIssueId: id.nullable(),
  workProductLinks: z.array(z.string()),
  participants: z.object({
    ownerAgentId: id,
    producerAgentId: id,
    validatorAgentId: id,
  }).strict(),
  maxRounds: z.number().int().min(1).max(EXCEPTION_HUDDLE_MAX_ROUNDS).default(2),
  currentRound: z.number().int().min(1).max(EXCEPTION_HUDDLE_MAX_ROUNDS).default(1),
  timeoutAt: z.string().datetime(),
  status: exceptionHuddleStatusSchema,
  decision: exceptionHuddleDecisionSchema.nullable(),
  decidedByAgentId: id.nullable(),
  decidedAt: z.string().datetime().nullable(),
}).strict().refine((metadata) => metadata.currentRound <= metadata.maxRounds, {
  path: ["currentRound"], message: "currentRound must not exceed maxRounds",
});

export type ExceptionHuddleRole = z.infer<typeof exceptionHuddleRoleSchema>;
export type ExceptionHuddleStatus = z.infer<typeof exceptionHuddleStatusSchema>;
export type ExceptionHuddleDecisionKind = z.infer<typeof exceptionHuddleDecisionKindSchema>;
export type ExceptionHuddleDecision = z.infer<typeof exceptionHuddleDecisionSchema>;
export type ExceptionHuddleMetadata = z.infer<typeof exceptionHuddleMetadataSchema>;

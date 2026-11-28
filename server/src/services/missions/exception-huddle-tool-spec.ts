import { z } from "zod";
import {
  EXCEPTION_HUDDLE_MAX_ROUNDS,
  EXCEPTION_HUDDLE_TIMEOUT_MS,
  exceptionHuddleDecisionKindSchema,
  exceptionHuddleDecisionSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleRole,
} from "@paperclipai/shared/validators/exception-huddle";

export const EXCEPTION_HUDDLE_DECIDE_TOOL_NAME = "exception_huddle_decide";

export const EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threadId", "decision"],
  properties: {
    threadId: {
      type: "string",
      format: "uuid",
      description: "UUID of the exception huddle thread being decided.",
    },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "rationale"],
      properties: {
        kind: {
          type: "string",
          enum: [...exceptionHuddleDecisionKindSchema.options],
          description: "The single structured recovery decision selected by the Owner Chair.",
        },
        rationale: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Concise evidence-backed reason for the selected decision.",
        },
        guidance: {
          type: "string",
          minLength: 1,
          description: "Required only when kind is retry_with_guidance: exact guidance for the retry.",
        },
        waiverCondition: {
          type: "string",
          minLength: 1,
          description: "Required only when kind is accept_with_waiver: the bounded waiver condition.",
        },
        replanSummary: {
          type: "string",
          minLength: 1,
          description: "Required only when kind is replan_remaining: summary of the replacement plan.",
        },
        escalationReason: {
          type: "string",
          minLength: 1,
          description: "Required only when kind is escalate: reason the huddle cannot decide locally.",
        },
        forcedByChair: {
          type: "boolean",
          default: false,
          description: "Normally omitted; the runtime marks forced Chair decisions when the cap or timeout applies.",
        },
      },
      anyOf: [
        { properties: { kind: { const: "retry_with_guidance" } }, required: ["guidance", "kind"] },
        { properties: { kind: { const: "accept_with_waiver" } }, required: ["waiverCondition", "kind"] },
        { properties: { kind: { const: "replan_remaining" } }, required: ["replanSummary", "kind"] },
        { properties: { kind: { const: "escalate" } }, required: ["escalationReason", "kind"] },
      ],
    },
  },
} as const;

const exceptionHuddleDecideToolArgsSchema = z.object({
  threadId: z.string().uuid(),
  decision: exceptionHuddleDecisionSchema,
}).strict();

export type ExceptionHuddleDecideToolArgsResult =
  | { ok: true; threadId: string; decision: ExceptionHuddleDecision }
  | { ok: false; error: string };

export function parseExceptionHuddleDecideToolArgs(raw: unknown): ExceptionHuddleDecideToolArgsResult {
  const parsed = exceptionHuddleDecideToolArgsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "args";
    return {
      ok: false,
      error: `Invalid ${EXCEPTION_HUDDLE_DECIDE_TOOL_NAME} arguments: ${path} — ${issue?.message ?? "validation failed"}`,
    };
  }
  return { ok: true, threadId: parsed.data.threadId, decision: parsed.data.decision };
}

export type ExceptionHuddleBriefPromptInput = {
  threadId: string;
  role: ExceptionHuddleRole;
  currentRound: number;
  maxRounds: number;
  timeoutAt: string | Date;
  failureSummary: string;
  workProductLinks: readonly string[];
};

function timeoutText(timeoutAt: string | Date): string {
  return timeoutAt instanceof Date ? timeoutAt.toISOString() : timeoutAt;
}

function roleInstructions(role: ExceptionHuddleRole): string {
  if (role === "owner") {
    return "You are the Owner and Chair. Review the evidence, then decide before the cap by calling exception_huddle_decide with valid structured arguments.";
  }
  const label = role === "producer" ? "Producer" : "Validator";
  return `You are the ${label}. Provide evidence and proposal only; you cannot decide the huddle, and no prose message from you may be treated as a decision.`;
}

export function buildExceptionHuddleBriefPrompt(input: ExceptionHuddleBriefPromptInput): string {
  const timeoutMinutes = EXCEPTION_HUDDLE_TIMEOUT_MS / 60_000;
  const links = input.workProductLinks.length > 0
    ? input.workProductLinks.map((link) => `- ${link}`).join("\n")
    : "- (none provided)";
  return [
    `Exception huddle brief for thread ${input.threadId}`,
    "",
    roleInstructions(input.role),
    `Decision authority: Only the Owner may decide this huddle, and only by calling ${EXCEPTION_HUDDLE_DECIDE_TOOL_NAME}; chat prose never decides the huddle.`,
    `Hard cap: the 2-round/5m cap means at most ${EXCEPTION_HUDDLE_MAX_ROUNDS} rounds and ${timeoutMinutes} minutes total. Current round ${input.currentRound} of ${input.maxRounds}; timeout at ${timeoutText(input.timeoutAt)}.`,
    "",
    "Failure summary:",
    input.failureSummary,
    "",
    "Work product links:",
    links,
  ].join("\n");
}

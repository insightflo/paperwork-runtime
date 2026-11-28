import {
  EXCEPTION_HUDDLE_TIMEOUT_MS,
  exceptionHuddleDecisionSchema,
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
  type ExceptionHuddleRole,
} from "@paperclipai/shared/validators/exception-huddle";

/** Persist the complete state, including turn receipts, atomically at the integration boundary. */
export interface ExceptionHuddleState extends ExceptionHuddleMetadata {
  roundTurns: Record<1 | 2, ExceptionHuddleRole[]>;
}

export type ExceptionHuddleRejectionCode =
  | "huddle_already_closed"
  | "huddle_actor_not_participant"
  | "huddle_timed_out_chair_decision_required"
  | "huddle_round_cap_reached_chair_decision_required"
  | "huddle_duplicate_turn"
  | "huddle_chair_only_decision"
  | "huddle_invalid_decision";

export type ExceptionHuddleEvaluation =
  | { ok: true; state: ExceptionHuddleState }
  | { ok: false; code: ExceptionHuddleRejectionCode };

export type CreateExceptionHuddleInput = Pick<ExceptionHuddleMetadata,
  "missionId" | "workflowRunId" | "sourceStepId" | "sourceIssueId" | "workProductLinks" | "participants"
> & { now: Date; maxRounds?: number; timeoutMs?: number };

function timestamp(now: Date): number {
  const value = now.getTime();
  if (!Number.isFinite(value)) throw new RangeError("Invalid huddle time");
  return value;
}

export function createInitialExceptionHuddleState(input: CreateExceptionHuddleInput): ExceptionHuddleState {
  const timeoutMs = input.timeoutMs ?? EXCEPTION_HUDDLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXCEPTION_HUDDLE_TIMEOUT_MS) {
    throw new RangeError("Huddle timeout must be positive and no more than five minutes");
  }
  const metadata = exceptionHuddleMetadataSchema.parse({
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    sourceStepId: input.sourceStepId,
    sourceIssueId: input.sourceIssueId,
    workProductLinks: input.workProductLinks,
    participants: input.participants,
    maxRounds: input.maxRounds,
    currentRound: 1,
    timeoutAt: new Date(timestamp(input.now) + timeoutMs).toISOString(),
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
  });
  return { ...metadata, roundTurns: { 1: [], 2: [] } };
}

function participantRole(state: ExceptionHuddleState, actorAgentId: string): ExceptionHuddleRole | null {
  const { ownerAgentId, producerAgentId, validatorAgentId } = state.participants;
  if (actorAgentId === ownerAgentId) return "owner";
  if (actorAgentId === producerAgentId) return "producer";
  if (actorAgentId === validatorAgentId) return "validator";
  return null;
}

function roundComplete(turns: ExceptionHuddleRole[]): boolean {
  return turns.includes("producer") && turns.includes("validator");
}

function roundCapReached(state: ExceptionHuddleState): boolean {
  return state.currentRound > state.maxRounds || (state.currentRound === state.maxRounds
    && roundComplete(state.roundTurns[state.currentRound as 1 | 2]));
}

/** Message text is deliberately absent: turns can record participation, never a decision. */
export function evaluateHuddleTurn(
  state: ExceptionHuddleState,
  input: { actorAgentId: string; now: Date },
): ExceptionHuddleEvaluation {
  if (state.status !== "open") return { ok: false, code: "huddle_already_closed" };
  const role = participantRole(state, input.actorAgentId);
  if (!role) return { ok: false, code: "huddle_actor_not_participant" };
  if (timestamp(input.now) >= Date.parse(state.timeoutAt)) {
    return { ok: false, code: "huddle_timed_out_chair_decision_required" };
  }
  if (roundCapReached(state)) {
    return { ok: false, code: "huddle_round_cap_reached_chair_decision_required" };
  }
  const round = state.currentRound as 1 | 2;
  const turns = state.roundTurns[round];
  if (turns.includes(role)) return { ok: false, code: "huddle_duplicate_turn" };
  const nextTurns = [...turns, role];
  return { ok: true, state: {
    ...state,
    currentRound: roundComplete(nextTurns) && round < state.maxRounds ? round + 1 : round,
    roundTurns: { ...state.roundTurns, [round]: nextTurns },
  } };
}

export function evaluateHuddleDecision(
  state: ExceptionHuddleState,
  input: { actorAgentId: string; decision: ExceptionHuddleDecision; now: Date },
): ExceptionHuddleEvaluation {
  if (input.actorAgentId !== state.participants.ownerAgentId) {
    return { ok: false, code: "huddle_chair_only_decision" };
  }
  if (state.status === "decided" || state.status === "cancelled") {
    return { ok: false, code: "huddle_already_closed" };
  }
  const parsed = exceptionHuddleDecisionSchema.safeParse(input.decision);
  if (!parsed.success) return { ok: false, code: "huddle_invalid_decision" };
  const now = timestamp(input.now);
  const forcedByChair = parsed.data.forcedByChair || state.status === "timed_out"
    || now >= Date.parse(state.timeoutAt) || roundCapReached(state);
  return { ok: true, state: {
    ...state,
    status: "decided",
    decision: { ...parsed.data, forcedByChair },
    decidedByAgentId: input.actorAgentId,
    decidedAt: input.now.toISOString(),
  } };
}

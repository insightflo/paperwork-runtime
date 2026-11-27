// Stage 26 Wave 3b: human_wait control-flow gate.
// Bridges the Wave 3a decision card into a workflow gate verdict. Reads ONLY the
// structured operator_decisions row (status + result JSON) — there is no natural-language
// parsing anywhere in this module (rule 8: comments/prose are never execution authority).
// Unknown or authority-less structured states fail closed instead of resuming.
import type { Db } from "@paperclipai/db";
import type { OperatorDecisionResultJson } from "@paperclipai/db";
import {
  buildHumanWaitDecisionInput,
  ensureHumanWaitDecisionCard,
  type HumanWaitDecisionCardParams,
} from "../human-wait-card.js";

/**
 * Structured option ids the Wave 3a card creator writes into definition.options. Kept as
 * local contract constants (the card creator file is not modified in this wave);
 * human-wait-gate.test.ts asserts these ids against buildHumanWaitDecisionInput output
 * so any drift fails tests instead of silently diverging at runtime.
 */
export const HUMAN_WAIT_APPROVE_OPTION_ID = "approve";
export const HUMAN_WAIT_REJECT_OPTION_ID = "reject";

/** Gate verdict without card identity; classifyHumanWaitDecisionRow returns this shape. */
export type HumanWaitGateOutcome =
  | { action: "pause"; reason: "awaiting_human_decision" }
  | { action: "resume"; resolution: "approved" }
  | { action: "fail"; resolution: "rejected" | "expired" };

/** Gate verdict enriched with the structured card identity. */
export type HumanWaitGateDecision = HumanWaitGateOutcome & {
  decisionId: string;
  requestKey: string;
};

/** Minimal row shape consumed by the pure classifier (subset of operator_decisions rows). */
export interface HumanWaitDecisionRowShape {
  status: string;
  result: OperatorDecisionResultJson | null;
}

export type HumanWaitGateInput = HumanWaitDecisionCardParams;

/**
 * Classifies one structured operator_decisions row into a gate verdict. Deterministic
 * over (status, result) only:
 * - pending → pause (awaiting human decision)
 * - resolved with approval outcome or approval selection → resume
 * - resolved without structured approval authority (reject outcome/selection, hold,
 *   empty selection, or a missing result row) → fail closed as rejected
 * - cancelled → fail as rejected (operator withdrawal of the wait)
 * - expired → fail as expired (reserved terminal state for time-based withdrawal)
 * - any unrecognized status → fail closed as rejected
 */
export function classifyHumanWaitDecisionRow(row: HumanWaitDecisionRowShape): HumanWaitGateOutcome {
  if (row.status === "pending") {
    return { action: "pause", reason: "awaiting_human_decision" };
  }
  if (row.status === "resolved") {
    const result = row.result;
    if (result?.outcome === "approve") return { action: "resume", resolution: "approved" };
    if (result?.outcome === "reject") return { action: "fail", resolution: "rejected" };
    const selected = new Set(result?.selectedOptionIds ?? []);
    // The human_wait card resolves via a submit action carrying a single approve/reject
    // selection; that selection is the structured approval authority for this card type.
    if (selected.has(HUMAN_WAIT_APPROVE_OPTION_ID) && !selected.has(HUMAN_WAIT_REJECT_OPTION_ID)) {
      return { action: "resume", resolution: "approved" };
    }
    return { action: "fail", resolution: "rejected" };
  }
  if (row.status === "expired") {
    return { action: "fail", resolution: "expired" };
  }
  // cancelled and unrecognized statuses end the wait without structured approval.
  return { action: "fail", resolution: "rejected" };
}

/**
 * Gate evaluation for a human_wait workflow step: idempotently ensures the
 * operator_decisions card exists (Wave 3a contract), then classifies its structured
 * state. Identical (company, run, step, generation) inputs always map to the same
 * card, so repeated gate evaluations never duplicate decision cards.
 */
export async function evaluateHumanWaitGate(
  db: Db,
  input: HumanWaitGateInput,
): Promise<HumanWaitGateDecision> {
  const { card } = await ensureHumanWaitDecisionCard(db, buildHumanWaitDecisionInput(input));
  return {
    decisionId: card.id,
    requestKey: card.requestKey,
    ...classifyHumanWaitDecisionRow(card),
  };
}

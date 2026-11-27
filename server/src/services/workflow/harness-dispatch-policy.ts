// server/src/services/workflow/harness-dispatch-policy.ts
//
// Pure workflow harness dispatch policy adapter. It maps one workflow step's
// structured context onto a dispatch plan: dgate-style route (sharp / split /
// escalate_advisor), the advisor gate that must be passed first, a machine
// reason code, and the watchdog (stall) thresholds to run the step under.
//
// This is a synchronous, database-free TypeScript policy. It shares its route
// vocabulary and ordering with the Rust `harness_gate.rs` primitives exposed by
// workflow-harness-rust-client.ts, but adds the `requiresWrite` guard the Rust
// input does not carry. It never reads or produces execution authority from
// natural language: `reason` is a stable code for logs and tests only, and
// callers must branch on `route` / `requiredAdvisorGate` / `inputValid`.

import type { WorkflowAdvisorGatePhase } from "./harness-watchdog.js";

const DISPATCH_ROUTES = ["sharp", "split", "escalate_advisor"] as const;
const ADVISOR_GATES = ["g1", "g2", "g3", "none"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const ADVISOR_GATE_PHASES = ["planning", "retry", "merge"] as const satisfies readonly WorkflowAdvisorGatePhase[];

export type WorkflowDispatchRoute = (typeof DISPATCH_ROUTES)[number];
export type WorkflowDispatchAdvisorGate = (typeof ADVISOR_GATES)[number];
export type WorkflowDispatchRiskLevel = (typeof RISK_LEVELS)[number];

/** Same value as HARNESS_DEFAULT_SHARP_THRESHOLD (kept local so this adapter stays import-light). */
export const WORKFLOW_DISPATCH_SHARP_SUCCESS_RATE_THRESHOLD = 0.7;
/** Same value as the Rust FORCED_SPLIT_ERRORS — at or above this the route is forced to escalate_advisor. */
export const WORKFLOW_DISPATCH_FORCED_ESCALATION_CONSECUTIVE_FAILURES = 2;

export interface WorkflowStepDispatchInput {
  /** Whether the step mutates files or external state. Any write is excluded from the sharp fast-path. */
  requiresWrite: boolean;
  riskLevel: WorkflowDispatchRiskLevel;
  /** Consecutive failed attempts of this step. >= 2 forces escalate_advisor and the g2 advisor gate. */
  consecutiveFailures: number;
  /** Measured success probability in [0, 1] (EWMA/Beta posterior mean or prior p0). */
  priorSuccessRate: number;
  phase: WorkflowAdvisorGatePhase;
}

export interface WorkflowStepStallThresholdsMs {
  /** Output-idle time before the step is reported stalled. */
  idleMs: number;
  /** Total wall-clock time before the step is reported timed out. */
  maxMs: number;
}

export interface WorkflowStepDispatchPlan {
  route: WorkflowDispatchRoute;
  requiredAdvisorGate: WorkflowDispatchAdvisorGate;
  /** Stable machine reason code. Diagnostic only — never an execution authority. */
  reason: string;
  stallThresholdsMs: WorkflowStepStallThresholdsMs;
  /** false when some input field was invalid and the fail-closed plan was returned. */
  inputValid: boolean;
}

/**
 * Watchdog budgets per route. The sharp fast-path is only for high-confidence
 * work, so it gets the tightest budget; escalation includes an advisor review
 * and therefore the loosest. Thresholds are always positive (never disabled).
 */
export const WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS: Readonly<
  Record<WorkflowDispatchRoute, WorkflowStepStallThresholdsMs>
> = Object.freeze({
  sharp: Object.freeze({ idleMs: 60_000, maxMs: 10 * 60_000 }),
  split: Object.freeze({ idleMs: 120_000, maxMs: 30 * 60_000 }),
  escalate_advisor: Object.freeze({ idleMs: 180_000, maxMs: 45 * 60_000 }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonNegativeUint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isSuccessRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Field validators in report order; the first failing field names come first in the invalid-input reason. */
const FIELD_VALIDATORS: ReadonlyArray<[keyof WorkflowStepDispatchInput, (value: unknown) => boolean]> = [
  ["requiresWrite", (value) => typeof value === "boolean"],
  ["riskLevel", (value) => isOneOf(value, RISK_LEVELS)],
  ["consecutiveFailures", isNonNegativeUint],
  ["priorSuccessRate", isSuccessRate],
  ["phase", (value) => isOneOf(value, ADVISOR_GATE_PHASES)],
];

/**
 * Advisor gate priority, matching Rust `required_advisor_gate`: the acute
 * regression gate (g2) outranks the plan gate (g1), which outranks the
 * pre-closeout gate (g3). No trigger means no gate ("none").
 */
function selectAdvisorGate(
  consecutiveFailures: number,
  phase: WorkflowAdvisorGatePhase,
): WorkflowDispatchAdvisorGate {
  if (consecutiveFailures >= WORKFLOW_DISPATCH_FORCED_ESCALATION_CONSECUTIVE_FAILURES) return "g2";
  if (phase === "planning") return "g1";
  if (phase === "merge") return "g3";
  return "none";
}

function buildPlan(input: unknown): WorkflowStepDispatchPlan {
  if (!isRecord(input)) {
    return failClosedPlan(["input"]);
  }
  const invalidFields = FIELD_VALIDATORS
    .filter(([name, isValid]) => !isValid(input[name]))
    .map(([name]) => name);
  if (invalidFields.length > 0) {
    return failClosedPlan(invalidFields);
  }

  const requiresWrite = input.requiresWrite as boolean;
  const riskLevel = input.riskLevel as WorkflowDispatchRiskLevel;
  const consecutiveFailures = input.consecutiveFailures as number;
  const priorSuccessRate = input.priorSuccessRate as number;
  const phase = input.phase as WorkflowAdvisorGatePhase;

  let route: WorkflowDispatchRoute;
  let reason: string;
  if (consecutiveFailures >= WORKFLOW_DISPATCH_FORCED_ESCALATION_CONSECUTIVE_FAILURES) {
    route = "escalate_advisor";
    reason = "consecutive_failures>=2";
  } else if (requiresWrite) {
    route = "split";
    reason = "requires_write";
  } else if (riskLevel !== "low") {
    route = "split";
    reason = `risk_level_${riskLevel}`;
  } else if (priorSuccessRate >= WORKFLOW_DISPATCH_SHARP_SUCCESS_RATE_THRESHOLD) {
    route = "sharp";
    reason = "read_only_low_risk_success_rate>=threshold";
  } else {
    route = "split";
    reason = "read_only_low_risk_success_rate_below_threshold";
  }

  const requiredAdvisorGate = selectAdvisorGate(consecutiveFailures, phase);
  return {
    route,
    requiredAdvisorGate,
    reason,
    stallThresholdsMs: WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS[route],
    inputValid: true,
  };
}

/**
 * Fail-closed plan for invalid input: the most restrictive route and the
 * highest-priority advisor gate. An untrustworthy context never earns the
 * sharp fast-path and never skips advisor review.
 */
function failClosedPlan(invalidFields: readonly string[]): WorkflowStepDispatchPlan {
  return {
    route: "escalate_advisor",
    requiredAdvisorGate: "g2",
    reason: `invalid_input:${invalidFields.join(",")}`,
    stallThresholdsMs: WORKFLOW_DISPATCH_STALL_THRESHOLDS_MS.escalate_advisor,
    inputValid: false,
  };
}

/**
 * Plan the dispatch of one workflow step.
 *
 * - `escalate_advisor` when consecutiveFailures >= 2, regardless of everything else.
 * - `split` for any write, or for medium/high risk.
 * - `sharp` only for read-only, low-risk steps with priorSuccessRate >= 0.7.
 *
 * Invalid input (wrong type, NaN, out-of-range, unknown enum, non-object) does
 * not throw and does not fall back to a permissive default: it returns the
 * fail-closed plan with `inputValid: false`.
 */
export function planWorkflowStepDispatch(input: WorkflowStepDispatchInput): WorkflowStepDispatchPlan {
  return buildPlan(input);
}

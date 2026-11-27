// server/src/services/workflow/harness-watchdog.ts
//
// Pure workflow harness watchdog and advisor-gate evaluators. These helpers are
// database-free adaptations of dgate's execution guardrails: output-idle stall
// detection, total-duration timeout, the three advisor checkpoints, and the
// verification backpropagation routing signal.

export type WorkflowStepStallStatus = "healthy" | "stalled" | "timed_out";

export interface EvaluateStepStallInput {
  startedAtMs: number;
  lastActivityAtMs: number;
  nowMs: number;
  stallMs: number;
  maxMs: number;
}

export interface WorkflowStepStallEvaluation {
  status: WorkflowStepStallStatus;
  idleMs: number;
  elapsedMs: number;
  reason?: string;
}

export type WorkflowAdvisorGatePhase = "planning" | "retry" | "merge";
export type WorkflowAdvisorGate = "g1" | "g2" | "g3";

export interface EvaluateAdvisorGateRequirementInput {
  phase: WorkflowAdvisorGatePhase;
  consecutiveSameErrors: number;
  touchesCriticalFiles: boolean;
  /** Whether the independent verifier has already passed this unit of work. */
  hasPassVerdict: boolean;
}

export interface WorkflowAdvisorGateRequirement {
  required: boolean;
  gate: WorkflowAdvisorGate | null;
  reason?: string;
}

export interface ComputeBackpropReliabilityInput {
  priorSuccesses: number;
  priorFailures: number;
  verdictPass: boolean;
  stalled: boolean;
}

export interface WorkflowBackpropReliability {
  successRate: number;
  nextRoute: "sharp" | "split" | "escalate";
}

const SHARP_SUCCESS_RATE_THRESHOLD = 0.7;

function requireFiniteMs(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite millisecond timestamp or duration`);
  }
}

function requireNonNegativeFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

/**
 * Evaluate output-idle and wall-clock watchdog state for one workflow step.
 *
 * Non-positive thresholds disable their respective watchdog, matching `dg wrap`.
 * The exact threshold is reached inclusively. When both fire, `stalled` wins,
 * matching dgate's failure-cause precedence. Returned durations are clamped at
 * zero so small clock skew cannot produce negative idle or elapsed values.
 */
export function evaluateStepStall(input: EvaluateStepStallInput): WorkflowStepStallEvaluation {
  requireFiniteMs("startedAtMs", input.startedAtMs);
  requireFiniteMs("lastActivityAtMs", input.lastActivityAtMs);
  requireFiniteMs("nowMs", input.nowMs);
  requireFiniteMs("stallMs", input.stallMs);
  requireFiniteMs("maxMs", input.maxMs);

  const idleMs = Math.max(0, input.nowMs - input.lastActivityAtMs);
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);

  if (input.stallMs > 0 && idleMs >= input.stallMs) {
    return {
      status: "stalled",
      idleMs,
      elapsedMs,
      reason: "idle_ms_reached_stall_ms",
    };
  }
  if (input.maxMs > 0 && elapsedMs >= input.maxMs) {
    return {
      status: "timed_out",
      idleMs,
      elapsedMs,
      reason: "elapsed_ms_reached_max_ms",
    };
  }
  return { status: "healthy", idleMs, elapsedMs };
}

/**
 * Evaluate whether one of dgate's three advisor checkpoints is required.
 *
 * - g1: before a coder implements a confirmed plan.
 * - g2: at the second consecutive same error, before a third retry.
 * - g3: before final merge after independent verification has passed.
 *
 * Critical-file context never weakens a gate; it is preserved in the machine
 * reason so callers can surface why review is especially sensitive.
 */
export function evaluateAdvisorGateRequirement(
  input: EvaluateAdvisorGateRequirementInput,
): WorkflowAdvisorGateRequirement {
  requireNonNegativeInteger("consecutiveSameErrors", input.consecutiveSameErrors);

  if (input.phase === "planning") {
    return {
      required: true,
      gate: "g1",
      reason: input.touchesCriticalFiles
        ? "before_coder_plan_gate_critical_files"
        : "before_coder_plan_gate",
    };
  }

  if (input.phase === "retry") {
    if (input.consecutiveSameErrors < 2) {
      return {
        required: false,
        gate: null,
        reason: "consecutive_same_errors_below_2",
      };
    }
    return {
      required: true,
      gate: "g2",
      reason: "consecutive_same_errors>=2",
    };
  }

  if (input.phase === "merge") {
    if (!input.hasPassVerdict) {
      return {
        required: false,
        gate: null,
        reason: "pass_verdict_required_before_merge_gate",
      };
    }
    return {
      required: true,
      gate: "g3",
      reason: input.touchesCriticalFiles
        ? "before_final_merge_gate_critical_files"
        : "before_final_merge_gate",
    };
  }

  throw new TypeError(`unknown advisor gate phase: ${String(input.phase)}`);
}

/**
 * Fold the latest structured verdict back into measured execution reliability.
 *
 * `priorSuccesses` and `priorFailures` may be integer counts or fractional
 * EWMA-style weights. A stalled execution is never counted as a success, even
 * if a verdict payload claims pass, because the execution evidence itself is
 * untrustworthy. Stalls escalate; otherwise dgate's 0.70 sharp threshold is
 * used and any non-pass verdict keeps the safer split route.
 */
export function computeBackpropReliability(
  input: ComputeBackpropReliabilityInput,
): WorkflowBackpropReliability {
  requireNonNegativeFiniteNumber("priorSuccesses", input.priorSuccesses);
  requireNonNegativeFiniteNumber("priorFailures", input.priorFailures);

  const currentSucceeded = input.verdictPass && !input.stalled;
  const successes = input.priorSuccesses + (currentSucceeded ? 1 : 0);
  const failures = input.priorFailures + (currentSucceeded ? 0 : 1);
  const successRate = successes / (successes + failures);

  if (input.stalled) {
    return { successRate, nextRoute: "escalate" };
  }
  if (input.verdictPass && successRate >= SHARP_SUCCESS_RATE_THRESHOLD) {
    return { successRate, nextRoute: "sharp" };
  }
  return { successRate, nextRoute: "split" };
}

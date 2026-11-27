// server/src/services/workflow/harness-summary.ts
//
// Pure, database-free run-level harness summary. It folds the step rows of one
// workflow run through the dgate-derived evaluators in `harness-watchdog.ts`
// so the read-only `GET /workflow-runs/:runId/harness-status` route can expose
// stall state, backprop route, and the next advisor gate without touching
// execution control.

import {
  computeBackpropReliability,
  evaluateAdvisorGateRequirement,
  evaluateStepStall,
  type WorkflowAdvisorGate,
  type WorkflowStepStallEvaluation,
  type WorkflowStepStallStatus,
} from "./harness-watchdog.js";
import type { WorkflowRun, WorkflowStepRun } from "./types.js";

export type WorkflowRunHarnessRoute = "sharp" | "split" | "escalate";
export type WorkflowRunHarnessAdvisorGate = "g1_pending" | "g2_challenge" | "g3_pass" | "none";

export interface WorkflowRunHarnessSummary {
  runId: string;
  /** Worst watchdog state among running steps; `timed_out` outranks `stalled`. */
  stallStatus: WorkflowStepStallStatus;
  /** Idle time of the step that decided `stallStatus`; `0` when nothing is running. */
  idleMs: number;
  route: WorkflowRunHarnessRoute;
  advisorGate: WorkflowRunHarnessAdvisorGate;
  /** `completed / (completed + failed)` as a percentage, or `null` without terminal evidence. */
  successRatePct: number | null;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  /** Running steps whose watchdog fired (stalled or timed out). */
  stalledSteps: number;
  evaluatedAt: string;
}

export interface WorkflowHarnessThresholds {
  /** Output-idle threshold per running step; non-positive disables. */
  stallMs: number;
  /** Wall-clock threshold per running step; non-positive disables. */
  maxMs: number;
}

/** Mirrors `dg wrap` defaults: 10 minutes without output, 60 minutes total. */
export const DEFAULT_HARNESS_THRESHOLDS: WorkflowHarnessThresholds = {
  stallMs: 10 * 60 * 1_000,
  maxMs: 60 * 60 * 1_000,
};

export type HarnessSummaryRun = Pick<WorkflowRun, "id" | "status" | "startedAt" | "createdAt">;
export type HarnessSummaryStepRun = Pick<
  WorkflowStepRun,
  "id" | "status" | "startedAt" | "completedAt" | "retryCount" | "lastDispatchErrorAt" | "lastDispatchAcceptedAt" | "lastDispatchAttemptAt"
>;

const ADVISOR_GATE_LABEL: Record<WorkflowAdvisorGate, Exclude<WorkflowRunHarnessAdvisorGate, "none">> = {
  g1: "g1_pending",
  g2: "g2_challenge",
  g3: "g3_pass",
};

function toMs(value: Date | null | undefined): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function latestMs(...values: Array<Date | null | undefined>): number | null {
  const candidates = values.map(toMs).filter((ms): ms is number => ms !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function isRunning(step: HarnessSummaryStepRun): boolean {
  return step.status === "running";
}

function evaluateRunningStep(
  run: HarnessSummaryRun,
  step: HarnessSummaryStepRun,
  nowMs: number,
  thresholds: WorkflowHarnessThresholds,
): WorkflowStepStallEvaluation | null {
  const startedAtMs = toMs(step.startedAt) ?? toMs(run.startedAt) ?? toMs(run.createdAt);
  const lastActivityAtMs = latestMs(step.lastDispatchAcceptedAt, step.lastDispatchAttemptAt, step.startedAt) ?? startedAtMs;
  if (startedAtMs === null || lastActivityAtMs === null) {
    return null;
  }
  return evaluateStepStall({ startedAtMs, lastActivityAtMs, nowMs, stallMs: thresholds.stallMs, maxMs: thresholds.maxMs });
}

const STALL_RANK: Record<WorkflowStepStallStatus, number> = { healthy: 0, stalled: 1, timed_out: 2 };

/** Pick the worst evaluation: higher rank first, then the longest idle time. */
function pickWorst(evaluations: WorkflowStepStallEvaluation[]): WorkflowStepStallEvaluation {
  return evaluations.reduce<WorkflowStepStallEvaluation>(
    (worst, current) => (STALL_RANK[current.status] > STALL_RANK[worst.status]
      || (STALL_RANK[current.status] === STALL_RANK[worst.status] && current.idleMs > worst.idleMs)) ? current : worst,
    { status: "healthy", idleMs: 0, elapsedMs: 0 },
  );
}

/** Most recently finished terminal step, by `completedAt` then by list order. */
function latestTerminalStep(steps: HarnessSummaryStepRun[]): HarnessSummaryStepRun | null {
  let latest: HarnessSummaryStepRun | null = null;
  let latestMsValue = -Infinity;
  for (const step of steps) {
    if (step.status !== "completed" && step.status !== "failed") continue;
    const finishedAt = toMs(step.completedAt) ?? latestMsValue;
    if (latest === null || finishedAt >= latestMsValue) {
      latest = step;
      latestMsValue = finishedAt;
    }
  }
  return latest;
}

function deriveAdvisorGate(run: HarnessSummaryRun, running: HarnessSummaryStepRun[], completed: number, failed: number): WorkflowRunHarnessAdvisorGate {
  let gate: WorkflowAdvisorGate | null = null;
  if (run.status === "completed") {
    gate = evaluateAdvisorGateRequirement({
      phase: "merge",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: failed === 0 && completed > 0,
    }).gate;
  } else if (running.length > 0) {
    const consecutiveSameErrors = Math.max(0, ...running.map((step) => (step.lastDispatchErrorAt ? step.retryCount ?? 0 : 0)));
    gate = evaluateAdvisorGateRequirement({
      phase: "retry",
      consecutiveSameErrors,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    }).gate;
  } else if (run.status === "failed" || run.status === "cancelled") {
    gate = null;
  } else {
    gate = evaluateAdvisorGateRequirement({
      phase: "planning",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    }).gate;
  }
  return gate ? ADVISOR_GATE_LABEL[gate] : "none";
}

/**
 * Summarize harness telemetry for one run.
 *
 * - Watchdog state comes from running steps only; terminal and pending steps
 *   are counted but never stalled.
 * - Routing folds the latest terminal step's verdict (completed = pass) on top
 *   of the other terminal steps; a fired watchdog forces `escalate`, matching
 *   dgate's rule that a stalled execution is never a success.
 * - Advisor gate: `g3` once the run completed with a clean pass record, `g2`
 *   while a running step has retried into the same error twice, the planning
 *   gate `g1` for runs that have not started executing yet (pending, or
 *   running between steps), and `none` for failed or cancelled runs.
 */
export function buildWorkflowRunHarnessSummary(
  run: HarnessSummaryRun,
  stepRuns: HarnessSummaryStepRun[],
  now: Date = new Date(),
  thresholds: WorkflowHarnessThresholds = DEFAULT_HARNESS_THRESHOLDS,
): WorkflowRunHarnessSummary {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const nowMs = now.getTime();
  const running = stepRuns.filter(isRunning);
  const evaluations = running
    .map((step) => evaluateRunningStep(run, step, nowMs, thresholds))
    .filter((evaluation): evaluation is WorkflowStepStallEvaluation => evaluation !== null);
  const worst = pickWorst(evaluations);
  const stalled = worst.status !== "healthy";

  const completedSteps = stepRuns.filter((step) => step.status === "completed").length;
  const failedSteps = stepRuns.filter((step) => step.status === "failed").length;
  const latest = latestTerminalStep(stepRuns);
  const latestVerdictPass = latest?.status === "completed";
  const priorSuccesses = completedSteps - (latestVerdictPass ? 1 : 0);
  const priorFailures = failedSteps - (latest && !latestVerdictPass ? 1 : 0);
  const reliability = computeBackpropReliability({ priorSuccesses, priorFailures, verdictPass: latestVerdictPass, stalled });
  const hasTerminalEvidence = completedSteps + failedSteps > 0;

  return {
    runId: run.id,
    stallStatus: worst.status,
    idleMs: worst.idleMs,
    route: reliability.nextRoute,
    advisorGate: deriveAdvisorGate(run, running, completedSteps, failedSteps),
    successRatePct: hasTerminalEvidence ? Math.round(reliability.successRate * 1000) / 10 : null,
    totalSteps: stepRuns.length,
    completedSteps,
    failedSteps,
    stalledSteps: evaluations.filter((evaluation) => evaluation.status !== "healthy").length,
    evaluatedAt: now.toISOString(),
  };
}

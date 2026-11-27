// server/src/services/workflow/harness-fleet-metrics.ts
//
// Pure, database-free company-level rollup of `WorkflowRunHarnessSummary`
// rows. It never reads step or run tables; callers hand it the per-run
// summaries and get back counts and worst-case pointers for a fleet view.

import type { WorkflowRunHarnessSummary } from "./harness-summary.js";

export interface WorkflowHarnessFleetMetrics {
  totalRuns: number;
  /** Runs whose worst running step is healthy / stalled / timed out. */
  healthyRuns: number;
  stalledRuns: number;
  timedOutRuns: number;
  /** Backprop route counts (sharp / split / escalate). */
  sharpRuns: number;
  splitRuns: number;
  escalatedRuns: number;
  /** Advisor gates awaiting a human (`g1_pending`) or a challenge (`g2_challenge`). */
  pendingAdvisorGates: number;
  challengedAdvisorGates: number;
  /** Mean of non-null `successRatePct`; `null` when no run has terminal evidence. */
  avgSuccessRatePct: number | null;
  /**
   * Run with the worst stall state: `timed_out` > `stalled` > `healthy`, then the
   * longest `idleMs`; equal rank and idle keep the earliest run in list order.
   * `null` for an empty fleet.
   */
  worstStallRunId: string | null;
  /** Longest `idleMs` across runs; `0` for an empty fleet. */
  maxIdleMs: number;
}

const STALL_RANK: Record<WorkflowRunHarnessSummary["stallStatus"], number> = { healthy: 0, stalled: 1, timed_out: 2 };

/** Non-finite or negative idle values contribute nothing instead of poisoning maxima. */
function safeIdleMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isWorseStall(current: WorkflowRunHarnessSummary, worst: WorkflowRunHarnessSummary | null): boolean {
  if (worst === null) return true;
  const rankDelta = STALL_RANK[current.stallStatus] - STALL_RANK[worst.stallStatus];
  if (rankDelta !== 0) return rankDelta > 0;
  return safeIdleMs(current.idleMs) > safeIdleMs(worst.idleMs);
}

function averageSuccessRate(summaries: WorkflowRunHarnessSummary[]): number | null {
  let total = 0;
  let count = 0;
  for (const summary of summaries) {
    const rate = summary.successRatePct;
    if (rate === null || !Number.isFinite(rate)) continue;
    total += rate;
    count += 1;
  }
  // Guard the division explicitly so an empty evidence set is `null`, never NaN.
  return count > 0 ? total / count : null;
}

/**
 * Aggregate per-run harness summaries into fleet metrics.
 *
 * Every counter is a plain tally, so an empty list yields all zeros,
 * `avgSuccessRatePct: null`, and `worstStallRunId: null`. No result can be
 * NaN or Infinite: the average is divided only by a positive count, and idle
 * values are coerced to a finite non-negative number before comparison.
 */
export function aggregateWorkflowHarnessFleet(summaries: WorkflowRunHarnessSummary[]): WorkflowHarnessFleetMetrics {
  const metrics: WorkflowHarnessFleetMetrics = {
    totalRuns: summaries.length,
    healthyRuns: 0,
    stalledRuns: 0,
    timedOutRuns: 0,
    sharpRuns: 0,
    splitRuns: 0,
    escalatedRuns: 0,
    pendingAdvisorGates: 0,
    challengedAdvisorGates: 0,
    avgSuccessRatePct: null,
    worstStallRunId: null,
    maxIdleMs: 0,
  };
  let worst: WorkflowRunHarnessSummary | null = null;

  for (const summary of summaries) {
    switch (summary.stallStatus) {
      case "healthy": metrics.healthyRuns += 1; break;
      case "stalled": metrics.stalledRuns += 1; break;
      case "timed_out": metrics.timedOutRuns += 1; break;
    }
    switch (summary.route) {
      case "sharp": metrics.sharpRuns += 1; break;
      case "split": metrics.splitRuns += 1; break;
      case "escalate": metrics.escalatedRuns += 1; break;
    }
    if (summary.advisorGate === "g1_pending") metrics.pendingAdvisorGates += 1;
    if (summary.advisorGate === "g2_challenge") metrics.challengedAdvisorGates += 1;

    const idleMs = safeIdleMs(summary.idleMs);
    if (idleMs > metrics.maxIdleMs) metrics.maxIdleMs = idleMs;
    if (isWorseStall(summary, worst)) worst = summary;
  }

  metrics.avgSuccessRatePct = averageSuccessRate(summaries);
  metrics.worstStallRunId = worst?.runId ?? null;
  return metrics;
}

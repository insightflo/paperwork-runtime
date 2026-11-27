import { describe, expect, it } from "vitest";
import {
  aggregateWorkflowHarnessFleet,
  type WorkflowHarnessFleetMetrics,
} from "../services/workflow/harness-fleet-metrics.js";
import type { WorkflowRunHarnessSummary } from "../services/workflow/harness-summary.js";

function makeSummary(overrides: Partial<WorkflowRunHarnessSummary> = {}): WorkflowRunHarnessSummary {
  return {
    runId: "run-x",
    stallStatus: "healthy",
    idleMs: 0,
    route: "sharp",
    advisorGate: "none",
    successRatePct: null,
    totalSteps: 1,
    completedSteps: 0,
    failedSteps: 0,
    stalledSteps: 0,
    evaluatedAt: "2025-01-01T12:00:00.000Z",
    ...overrides,
  };
}

const EMPTY: WorkflowHarnessFleetMetrics = {
  totalRuns: 0,
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

describe("aggregateWorkflowHarnessFleet", () => {
  it("returns all-zero metrics with null pointers for an empty fleet", () => {
    expect(aggregateWorkflowHarnessFleet([])).toEqual(EMPTY);
  });

  it("counts healthy, stalled, and timed_out runs alongside routes and advisor gates", () => {
    const metrics = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "run-healthy-sharp", idleMs: 1_000, successRatePct: 100 }),
      makeSummary({ runId: "run-healthy-split", route: "split", advisorGate: "g1_pending", idleMs: 2_000 }),
      makeSummary({
        runId: "run-stalled",
        stallStatus: "stalled",
        route: "escalate",
        advisorGate: "g2_challenge",
        idleMs: 300_000,
        successRatePct: 50,
      }),
      makeSummary({ runId: "run-timed-out", stallStatus: "timed_out", route: "escalate", idleMs: 60_000 }),
      makeSummary({ runId: "run-escalated", route: "escalate", advisorGate: "g3_pass", idleMs: 500 }),
    ]);

    expect(metrics).toEqual({
      ...EMPTY,
      totalRuns: 5,
      healthyRuns: 3,
      stalledRuns: 1,
      timedOutRuns: 1,
      sharpRuns: 1,
      splitRuns: 1,
      escalatedRuns: 3,
      pendingAdvisorGates: 1,
      challengedAdvisorGates: 1,
      avgSuccessRatePct: 75,
      worstStallRunId: "run-timed-out",
      maxIdleMs: 300_000,
    });
  });

  it("ranks timed_out above stalled regardless of idle time", () => {
    const metrics = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "stalled-long", stallStatus: "stalled", idleMs: 900_000 }),
      makeSummary({ runId: "timed-out-short", stallStatus: "timed_out", idleMs: 1_000 }),
    ]);
    expect(metrics.worstStallRunId).toBe("timed-out-short");
    expect(metrics.maxIdleMs).toBe(900_000);
  });

  it("ranks stalled above healthy regardless of idle time", () => {
    const metrics = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "healthy-long", idleMs: 900_000 }),
      makeSummary({ runId: "stalled-short", stallStatus: "stalled", idleMs: 1_000 }),
    ]);
    expect(metrics.worstStallRunId).toBe("stalled-short");
  });

  it("breaks same-rank ties by the longest idle time", () => {
    expect(aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "a", stallStatus: "stalled", idleMs: 10 }),
      makeSummary({ runId: "b", stallStatus: "stalled", idleMs: 30 }),
      makeSummary({ runId: "c", stallStatus: "stalled", idleMs: 20 }),
    ]).worstStallRunId).toBe("b");

    expect(aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "a", idleMs: 10 }),
      makeSummary({ runId: "b", idleMs: 30 }),
      makeSummary({ runId: "c", idleMs: 20 }),
    ]).worstStallRunId).toBe("b");
  });

  it("keeps the earliest run when rank and idle time are equal", () => {
    expect(aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "first", stallStatus: "timed_out", idleMs: 5_000 }),
      makeSummary({ runId: "second", stallStatus: "timed_out", idleMs: 5_000 }),
    ]).worstStallRunId).toBe("first");
  });

  it("excludes null success rates from the average and yields null without evidence", () => {
    const metrics = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "a", successRatePct: 100 }),
      makeSummary({ runId: "b", successRatePct: null }),
      makeSummary({ runId: "c", successRatePct: 50 }),
    ]);
    expect(metrics.avgSuccessRatePct).toBe(75);

    const noEvidence = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "a", successRatePct: null }),
      makeSummary({ runId: "b", successRatePct: null }),
    ]);
    expect(noEvidence.avgSuccessRatePct).toBeNull();
    expect(noEvidence.totalRuns).toBe(2);
  });

  it("never produces NaN or Infinity from degenerate idle values", () => {
    const metrics = aggregateWorkflowHarnessFleet([
      makeSummary({ runId: "nan-idle", idleMs: Number.NaN, successRatePct: Number.NaN }),
      makeSummary({ runId: "inf-idle", stallStatus: "stalled", idleMs: Number.POSITIVE_INFINITY }),
      makeSummary({ runId: "negative", idleMs: -5, successRatePct: 0 }),
    ]);
    expect(metrics.maxIdleMs).toBe(0);
    expect(metrics.avgSuccessRatePct).toBe(0);
    // `inf-idle` is stalled, so it still wins by rank even though its idle time is discarded.
    expect(metrics.worstStallRunId).toBe("inf-idle");
    expect(Number.isFinite(metrics.avgSuccessRatePct)).toBe(true);
  });
});

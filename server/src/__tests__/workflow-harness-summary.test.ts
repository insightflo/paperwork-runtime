import { describe, expect, it } from "vitest";
import {
  buildWorkflowRunHarnessSummary,
  DEFAULT_HARNESS_THRESHOLDS,
  type HarnessSummaryRun,
  type HarnessSummaryStepRun,
} from "../services/workflow/harness-summary.js";

const NOW = new Date("2025-01-01T12:00:00.000Z");
const T0 = 10 * 60 * 1_000; // run started 10 minutes before NOW
const THRESHOLDS = { stallMs: 5 * 60 * 1_000, maxMs: 60 * 60 * 1_000 };

function makeRun(overrides: Partial<HarnessSummaryRun> = {}): HarnessSummaryRun {
  return {
    id: "run-1",
    status: "running",
    startedAt: new Date(NOW.getTime() - T0),
    createdAt: new Date(NOW.getTime() - T0),
    ...overrides,
  };
}

function makeStep(overrides: Partial<HarnessSummaryStepRun> = {}): HarnessSummaryStepRun {
  return {
    id: `step-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    startedAt: new Date(NOW.getTime() - T0),
    completedAt: null,
    retryCount: 0,
    lastDispatchErrorAt: null,
    lastDispatchAcceptedAt: null,
    lastDispatchAttemptAt: null,
    ...overrides,
  };
}

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60 * 1_000);
}

describe("buildWorkflowRunHarnessSummary", () => {
  it("reports healthy with the latest dispatch as activity", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ lastDispatchAcceptedAt: minutesAgo(1) })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.stallStatus).toBe("healthy");
    expect(summary.idleMs).toBe(60 * 1_000);
    expect(summary.stalledSteps).toBe(0);
    expect(summary.evaluatedAt).toBe(NOW.toISOString());
  });

  it("reports stalled when a running step is idle past stallMs", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ lastDispatchAcceptedAt: minutesAgo(5) })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.stallStatus).toBe("stalled");
    expect(summary.idleMs).toBe(5 * 60 * 1_000);
    expect(summary.stalledSteps).toBe(1);
  });

  it("reports timed_out when elapsed reaches maxMs even with recent activity", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ startedAt: minutesAgo(60) }),
      [makeStep({ startedAt: minutesAgo(60), lastDispatchAttemptAt: minutesAgo(1) })],
      NOW,
      { stallMs: 5 * 60 * 1_000, maxMs: 60 * 60 * 1_000 },
    );
    expect(summary.stallStatus).toBe("timed_out");
    expect(summary.route).toBe("escalate");
  });

  it("prefers timed_out over stalled and the longest idle among equals", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ startedAt: minutesAgo(90) }),
      [
        makeStep({ startedAt: minutesAgo(90), lastDispatchAcceptedAt: minutesAgo(1) }),
        makeStep({ startedAt: minutesAgo(20), lastDispatchAcceptedAt: minutesAgo(7) }),
        makeStep({ startedAt: minutesAgo(20), lastDispatchAcceptedAt: minutesAgo(6) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.stallStatus).toBe("timed_out");
    expect(summary.idleMs).toBe(60 * 1_000);
    expect(summary.stalledSteps).toBe(3);
    expect(summary.totalSteps).toBe(3);
  });

  it("escalates whenever the watchdog fired, regardless of verdict history", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [
        makeStep({ status: "completed", completedAt: minutesAgo(30) }),
        makeStep({ lastDispatchAcceptedAt: minutesAgo(30) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.stallStatus).toBe("stalled");
    expect(summary.route).toBe("escalate");
    expect(summary.completedSteps).toBe(1);
  });

  it("routes sharp when the latest verdict passes and the rate is at least 70%", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [
        makeStep({ status: "completed", completedAt: minutesAgo(50) }),
        makeStep({ status: "failed", completedAt: minutesAgo(40) }),
        makeStep({ status: "completed", completedAt: minutesAgo(30) }),
        makeStep({ status: "completed", completedAt: minutesAgo(20) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.route).toBe("sharp");
    expect(summary.successRatePct).toBe(75);
    expect(summary.completedSteps).toBe(3);
    expect(summary.failedSteps).toBe(1);
    expect(summary.stallStatus).toBe("healthy");
    expect(summary.idleMs).toBe(0);
  });

  it("routes split when the latest verdict failed, even with a high success rate", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [
        makeStep({ status: "completed", completedAt: minutesAgo(40) }),
        makeStep({ status: "completed", completedAt: minutesAgo(30) }),
        makeStep({ status: "failed", completedAt: minutesAgo(20) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.route).toBe("split");
    expect(summary.successRatePct).toBe(66.7);
  });

  it("routes split when the latest verdict passed but the rate is below 70%", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [
        makeStep({ status: "failed", completedAt: minutesAgo(40) }),
        makeStep({ status: "failed", completedAt: minutesAgo(30) }),
        makeStep({ status: "completed", completedAt: minutesAgo(20) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.route).toBe("split");
    expect(summary.successRatePct).toBe(33.3);
  });

  it("marks g1_pending for a pending run that has not started executing", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ status: "pending", startedAt: null }),
      [makeStep({ status: "pending", startedAt: null })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.advisorGate).toBe("g1_pending");
    expect(summary.stallStatus).toBe("healthy");
  });

  it("marks g1_pending for a running run between steps", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ status: "completed", completedAt: minutesAgo(1) }), makeStep({ status: "pending", startedAt: null })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.advisorGate).toBe("g1_pending");
  });

  it("marks g2_challenge only once a running step retried into the same error twice", () => {
    const base = [makeStep({ lastDispatchAcceptedAt: minutesAgo(1), retryCount: 1, lastDispatchErrorAt: minutesAgo(2) })];
    expect(buildWorkflowRunHarnessSummary(makeRun(), base, NOW, THRESHOLDS).advisorGate).toBe("none");

    const challenged = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ lastDispatchAcceptedAt: minutesAgo(1), retryCount: 2, lastDispatchErrorAt: minutesAgo(2) })],
      NOW,
      THRESHOLDS,
    );
    expect(challenged.advisorGate).toBe("g2_challenge");
  });

  it("ignores retryCount without a dispatch error for g2", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ lastDispatchAcceptedAt: minutesAgo(1), retryCount: 5 })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.advisorGate).toBe("none");
  });

  it("marks g3_pass for a completed run with a clean pass record", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ status: "completed" }),
      [makeStep({ status: "completed", completedAt: minutesAgo(5) })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.advisorGate).toBe("g3_pass");
    expect(summary.route).toBe("sharp");
  });

  it("does not open g3 for a completed run that has failed steps", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ status: "completed" }),
      [
        makeStep({ status: "failed", completedAt: minutesAgo(6) }),
        makeStep({ status: "completed", completedAt: minutesAgo(5) }),
      ],
      NOW,
      THRESHOLDS,
    );
    expect(summary.advisorGate).toBe("none");
  });

  it("returns none for failed and cancelled runs", () => {
    expect(buildWorkflowRunHarnessSummary(makeRun({ status: "failed" }), [], NOW, THRESHOLDS).advisorGate).toBe("none");
    expect(buildWorkflowRunHarnessSummary(makeRun({ status: "cancelled" }), [], NOW, THRESHOLDS).advisorGate).toBe("none");
  });

  it("returns an empty, evidence-free summary for a run without steps", () => {
    expect(buildWorkflowRunHarnessSummary(makeRun(), [], NOW, THRESHOLDS)).toEqual({
      runId: "run-1",
      stallStatus: "healthy",
      idleMs: 0,
      route: "split",
      advisorGate: "g1_pending",
      successRatePct: null,
      totalSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      stalledSteps: 0,
      evaluatedAt: NOW.toISOString(),
    });
  });

  it("reports null success rate for a completed run with only skipped steps", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ status: "completed" }),
      [makeStep({ status: "skipped", completedAt: minutesAgo(1) })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.successRatePct).toBeNull();
    expect(summary.totalSteps).toBe(1);
    expect(summary.completedSteps).toBe(0);
    expect(summary.advisorGate).toBe("none");
  });

  it("does not evaluate running steps that lack any usable timestamp", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun({ startedAt: null, createdAt: null as unknown as Date }),
      [makeStep({ startedAt: null })],
      NOW,
      THRESHOLDS,
    );
    expect(summary.stallStatus).toBe("healthy");
    expect(summary.stalledSteps).toBe(0);
  });

  it("uses default thresholds when none are given", () => {
    const summary = buildWorkflowRunHarnessSummary(
      makeRun(),
      [makeStep({ lastDispatchAcceptedAt: new Date(NOW.getTime() - DEFAULT_HARNESS_THRESHOLDS.stallMs - 1) })],
      NOW,
    );
    expect(summary.stallStatus).toBe("stalled");
  });

  it("rejects an invalid now", () => {
    expect(() => buildWorkflowRunHarnessSummary(makeRun(), [], new Date("invalid"))).toThrow(TypeError);
  });
});

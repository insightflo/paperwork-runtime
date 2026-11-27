import { describe, expect, it } from "vitest";
import {
  ESCALATE_FAILURE_COUNT,
  STALL_TIMEOUT_MS,
  STALL_WARN_MS,
  deriveAdvisorGate,
  deriveHarnessStatus,
  deriveRoute,
  deriveStallStatus,
  deriveSuccessRatePct,
} from "./workflow-harness-status.js";
import type { WorkflowRunDetailData } from "./workflow-page-types.js";

const NOW = Date.parse("2025-01-01T12:00:00Z");
const MINUTE = 60_000;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function detail(runStatus: string, stepRuns: Array<Partial<WorkflowRunDetailData["stepRuns"][number]> & { id: string; stepId: string }>): WorkflowRunDetailData {
  return {
    run: { id: "run-1", status: runStatus },
    stepRuns: stepRuns.map((step) => ({ status: "pending", ...step })),
    workflow: null,
  };
}

describe("deriveStallStatus", () => {
  it("is healthy with zero idle when the run is not in flight, regardless of step state", () => {
    for (const status of ["completed", "failed", "cancelled", "paused"]) {
      const data = detail(status, [{ id: "s1", stepId: "a", status: "running", startedAt: iso(-30 * MINUTE) }]);
      expect(deriveStallStatus(data.run, data.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 0 });
    }
  });

  it("is healthy while running steps are progressing", () => {
    const data = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: iso(-30_000) }]);
    expect(deriveStallStatus(data.run, data.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 30_000 });
  });

  it("ignores non-running steps and uses the longest-idle running step", () => {
    const data = detail(
      "running",
      [
        { id: "s1", stepId: "a", status: "completed", startedAt: iso(-60 * MINUTE), completedAt: iso(-59 * MINUTE) },
        { id: "s2", stepId: "b", status: "running", startedAt: iso(-10_000) },
        { id: "s3", stepId: "c", status: "in_progress", startedAt: iso(-20_000) },
        { id: "s4", stepId: "d", status: "pending" },
      ],
    );
    expect(deriveStallStatus(data.run, data.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 20_000 });
  });

  it("reports stalled and timed_out from the warn/timeout thresholds", () => {
    const stalled = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: iso(-STALL_WARN_MS) }]);
    expect(deriveStallStatus(stalled.run, stalled.stepRuns, NOW).stallStatus).toBe("stalled");
    expect(deriveStallStatus(stalled.run, stalled.stepRuns, NOW).idleMs).toBe(STALL_WARN_MS);

    const justUnder = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: iso(-(STALL_WARN_MS - 1)) }]);
    expect(deriveStallStatus(justUnder.run, justUnder.stepRuns, NOW).stallStatus).toBe("healthy");

    const timedOut = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: iso(-STALL_TIMEOUT_MS) }]);
    expect(deriveStallStatus(timedOut.run, timedOut.stepRuns, NOW).stallStatus).toBe("timed_out");
  });

  it("treats an accepted dispatch as progress so a rerun resets the idle clock", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "running", startedAt: iso(-30 * MINUTE), lastDispatchAcceptedAt: iso(-5_000) },
    ]);
    expect(deriveStallStatus(data.run, data.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 5_000 });
  });

  it("treats a running step with no usable timestamp or a future timestamp as zero idle", () => {
    const missing = detail("running", [{ id: "s1", stepId: "a", status: "running" }]);
    expect(deriveStallStatus(missing.run, missing.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 0 });

    const garbage = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: "not-a-date" }]);
    expect(deriveStallStatus(garbage.run, garbage.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 0 });

    const future = detail("running", [{ id: "s1", stepId: "a", status: "running", startedAt: iso(5 * MINUTE) }]);
    expect(deriveStallStatus(future.run, future.stepRuns, NOW)).toEqual({ stallStatus: "healthy", idleMs: 0 });
  });
});

describe("deriveRoute", () => {
  it("is sharp with no failures", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "completed" },
      { id: "s2", stepId: "b", status: "running" },
    ]);
    expect(deriveRoute(data.stepRuns)).toBe("sharp");
    expect(deriveRoute([])).toBe("sharp");
  });

  it("is split after a single failed step and escalate from the failure threshold", () => {
    const failed: WorkflowRunDetailData["stepRuns"] = [
      { id: "s1", stepId: "a", status: "Failed " },
      { id: "s2", stepId: "b", status: "running" },
    ];
    expect(deriveRoute(failed)).toBe("split");
    expect(ESCALATE_FAILURE_COUNT).toBe(2);
    expect(deriveRoute([...failed, { id: "s3", stepId: "c", status: "cancelled" }])).toBe("escalate");
  });
});

describe("deriveSuccessRatePct", () => {
  it("is null until a step has settled", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "pending" },
      { id: "s2", stepId: "b", status: "running" },
    ]);
    expect(deriveSuccessRatePct(data.stepRuns)).toBeNull();
    expect(deriveSuccessRatePct([])).toBeNull();
  });

  it("measures succeeded steps against settled (succeeded + failed) steps only", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "completed" },
      { id: "s2", stepId: "b", status: "done" },
      { id: "s3", stepId: "c", status: "failed" },
      { id: "s4", stepId: "d", status: "running" },
      { id: "s5", stepId: "e", status: "pending" },
    ]);
    expect(deriveSuccessRatePct(data.stepRuns)).toBeCloseTo((2 / 3) * 100, 8);
    const allGood = detail("completed", [{ id: "s1", stepId: "a", status: "succeeded" }]);
    expect(deriveSuccessRatePct(allGood.stepRuns)).toBe(100);
    const allBad = detail("failed", [{ id: "s1", stepId: "a", status: "failed" }]);
    expect(deriveSuccessRatePct(allBad.stepRuns)).toBe(0);
  });
});

describe("deriveAdvisorGate", () => {
  it("returns null with no steps or when the last step is neither running nor succeeded", () => {
    expect(deriveAdvisorGate([])).toBeNull();
    const pending = detail("running", [{ id: "s1", stepId: "a", status: "pending" }]);
    expect(deriveAdvisorGate(pending.stepRuns)).toBeNull();
  });

  it("shows the latest running step as a pending G1 gate", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "completed", stepTitle: "Plan" },
      { id: "s2", stepId: "b", status: "running", stepTitle: "Build" },
    ]);
    expect(deriveAdvisorGate(data.stepRuns)).toEqual({ gate: "g1", verdict: "pending", reason: "Build" });
  });

  it("shows a failed or errored step as a G2 challenge, preferring the error summary", () => {
    const failed = detail("running", [{ id: "s1", stepId: "a", status: "failed", stepTitle: "Build" }]);
    expect(deriveAdvisorGate(failed.stepRuns)).toEqual({ gate: "g2", verdict: "challenge", reason: "Build" });

    const rework = detail("running", [
      { id: "s1", stepId: "a", status: "running", lastDispatchErrorSummary: "rate limited", lastDispatchErrorAt: iso(-MINUTE) },
    ]);
    expect(deriveAdvisorGate(rework.stepRuns)).toEqual({ gate: "g2", verdict: "challenge", reason: "rate limited" });
  });

  it("shows the last succeeded step as a passed G3 closeout", () => {
    const data = detail("completed", [
      { id: "s1", stepId: "a", status: "completed", stepTitle: "Build" },
      { id: "s2", stepId: "b", status: "completed" },
    ]);
    expect(deriveAdvisorGate(data.stepRuns)).toEqual({ gate: "g3", verdict: "pass", reason: "b" });
  });
});

describe("deriveHarnessStatus", () => {
  it("combines every derived prop from the run detail alone", () => {
    const data = detail("running", [
      { id: "s1", stepId: "a", status: "completed" },
      { id: "s2", stepId: "b", status: "failed" },
      { id: "s3", stepId: "c", status: "running", startedAt: iso(-STALL_WARN_MS) },
    ]);
    expect(deriveHarnessStatus(data, NOW)).toEqual({
      route: "split",
      stallStatus: "stalled",
      idleMs: STALL_WARN_MS,
      advisorGate: { gate: "g2", verdict: "challenge", reason: "b" },
      successRatePct: 50,
    });
  });
});

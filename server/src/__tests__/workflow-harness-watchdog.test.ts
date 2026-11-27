import { describe, expect, it } from "vitest";
import {
  computeBackpropReliability,
  evaluateAdvisorGateRequirement,
  evaluateStepStall,
} from "../services/workflow/harness-watchdog.js";

describe("evaluateStepStall", () => {
  it("reports healthy when idle and elapsed time are below both thresholds", () => {
    expect(evaluateStepStall({
      startedAtMs: 1_000,
      lastActivityAtMs: 8_000,
      nowMs: 10_000,
      stallMs: 5_000,
      maxMs: 20_000,
    })).toEqual({
      status: "healthy",
      idleMs: 2_000,
      elapsedMs: 9_000,
    });
  });
  it("reports stalled exactly when the idle threshold is reached", () => {
    expect(evaluateStepStall({
      startedAtMs: 0,
      lastActivityAtMs: 1_000,
      nowMs: 6_000,
      stallMs: 5_000,
      maxMs: 60_000,
    })).toEqual({
      status: "stalled",
      idleMs: 5_000,
      elapsedMs: 6_000,
      reason: "idle_ms_reached_stall_ms",
    });
  });
  it("reports timed_out exactly when the total duration threshold is reached", () => {
    expect(evaluateStepStall({
      startedAtMs: 2_000,
      lastActivityAtMs: 11_500,
      nowMs: 12_000,
      stallMs: 5_000,
      maxMs: 10_000,
    })).toEqual({
      status: "timed_out",
      idleMs: 500,
      elapsedMs: 10_000,
      reason: "elapsed_ms_reached_max_ms",
    });
  });
  it("keeps dgate failure precedence by reporting stalled when stall and timeout both fire", () => {
    expect(evaluateStepStall({
      startedAtMs: 0,
      lastActivityAtMs: 0,
      nowMs: 10_000,
      stallMs: 5_000,
      maxMs: 10_000,
    })).toMatchObject({
      status: "stalled",
      idleMs: 10_000,
      elapsedMs: 10_000,
    });
  });
  it("treats non-positive thresholds as disabled like dg wrap", () => {
    expect(evaluateStepStall({
      startedAtMs: 0,
      lastActivityAtMs: 0,
      nowMs: 100_000,
      stallMs: 0,
      maxMs: -1,
    })).toEqual({
      status: "healthy",
      idleMs: 100_000,
      elapsedMs: 100_000,
    });
  });
  it("clamps clock skew in returned durations without inventing activity", () => {
    expect(evaluateStepStall({
      startedAtMs: 10_000,
      lastActivityAtMs: 12_000,
      nowMs: 8_000,
      stallMs: 1_000,
      maxMs: 1_000,
    })).toEqual({
      status: "healthy",
      idleMs: 0,
      elapsedMs: 0,
    });
  });
  it("rejects non-finite time inputs instead of silently misclassifying execution health", () => {
    expect(() => evaluateStepStall({
      startedAtMs: Number.NaN,
      lastActivityAtMs: 0,
      nowMs: 1_000,
      stallMs: 100,
      maxMs: 1_000,
    })).toThrow(TypeError);
  });
});
describe("evaluateAdvisorGateRequirement", () => {
  it("requires g1 before coder implementation during planning", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "planning",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toEqual({
      required: true,
      gate: "g1",
      reason: "before_coder_plan_gate",
    });
  });
  it("marks critical-file plans in the g1 reason without weakening the gate", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "planning",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: true,
      hasPassVerdict: false,
    }).reason).toBe("before_coder_plan_gate_critical_files");
  });
  it("does not require g2 before the second consecutive same error", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "retry",
      consecutiveSameErrors: 1,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toEqual({
      required: false,
      gate: null,
      reason: "consecutive_same_errors_below_2",
    });
  });
  it("requires g2 at the second consecutive same error before a third retry", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "retry",
      consecutiveSameErrors: 2,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toEqual({
      required: true,
      gate: "g2",
      reason: "consecutive_same_errors>=2",
    });
  });
  it("requires g2 for larger repeated-error counts as well", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "retry",
      consecutiveSameErrors: 4,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    }).gate).toBe("g2");
  });
  it("waits for an independent pass verdict before requiring g3", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "merge",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toEqual({
      required: false,
      gate: null,
      reason: "pass_verdict_required_before_merge_gate",
    });
  });
  it("requires g3 before final merge once the verifier has passed", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "merge",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: true,
    })).toEqual({
      required: true,
      gate: "g3",
      reason: "before_final_merge_gate",
    });
  });
  it("marks critical-file merges in the g3 reason", () => {
    expect(evaluateAdvisorGateRequirement({
      phase: "merge",
      consecutiveSameErrors: 0,
      touchesCriticalFiles: true,
      hasPassVerdict: true,
    }).reason).toBe("before_final_merge_gate_critical_files");
  });
  it("rejects unknown phases and malformed error counts", () => {
    expect(() => evaluateAdvisorGateRequirement({
      phase: "unknown" as never,
      consecutiveSameErrors: 0,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toThrow(TypeError);
    expect(() => evaluateAdvisorGateRequirement({
      phase: "retry",
      consecutiveSameErrors: -1,
      touchesCriticalFiles: false,
      hasPassVerdict: false,
    })).toThrow(TypeError);
  });
});
describe("computeBackpropReliability", () => {
  it("routes sharp when a pass keeps the success rate at the dgate threshold", () => {
    expect(computeBackpropReliability({
      priorSuccesses: 6,
      priorFailures: 3,
      verdictPass: true,
      stalled: false,
    })).toEqual({
      successRate: 0.7,
      nextRoute: "sharp",
    });
  });
  it("routes split when a pass still leaves reliability below the sharp threshold", () => {
    expect(computeBackpropReliability({
      priorSuccesses: 5,
      priorFailures: 4,
      verdictPass: true,
      stalled: false,
    })).toEqual({
      successRate: 0.6,
      nextRoute: "split",
    });
  });
  it("routes split after a non-pass verdict even when historical reliability remains high", () => {
    expect(computeBackpropReliability({
      priorSuccesses: 10,
      priorFailures: 0,
      verdictPass: false,
      stalled: false,
    })).toEqual({
      successRate: 10 / 11,
      nextRoute: "split",
    });
  });
  it("counts a stalled pass as a failure and escalates because execution cannot be trusted", () => {
    expect(computeBackpropReliability({
      priorSuccesses: 8,
      priorFailures: 1,
      verdictPass: true,
      stalled: true,
    })).toEqual({
      successRate: 0.8,
      nextRoute: "escalate",
    });
  });
  it("uses the current outcome in the rate, including cold-start pass and fail cases", () => {
    expect(computeBackpropReliability({
      priorSuccesses: 0,
      priorFailures: 0,
      verdictPass: true,
      stalled: false,
    })).toEqual({ successRate: 1, nextRoute: "sharp" });
    expect(computeBackpropReliability({
      priorSuccesses: 0,
      priorFailures: 0,
      verdictPass: false,
      stalled: false,
    })).toEqual({ successRate: 0, nextRoute: "split" });
  });
  it("supports fractional dgate-style weighted priors", () => {
    const result = computeBackpropReliability({
      priorSuccesses: 1.4,
      priorFailures: 0.6,
      verdictPass: true,
      stalled: false,
    });
    expect(result.successRate).toBeCloseTo(0.8);
    expect(result.nextRoute).toBe("sharp");
  });
  it("rejects negative or non-finite prior counts", () => {
    expect(() => computeBackpropReliability({
      priorSuccesses: -1,
      priorFailures: 0,
      verdictPass: true,
      stalled: false,
    })).toThrow(TypeError);
    expect(() => computeBackpropReliability({
      priorSuccesses: 0,
      priorFailures: Number.POSITIVE_INFINITY,
      verdictPass: true,
      stalled: false,
    })).toThrow(TypeError);
  });
});

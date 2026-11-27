import { describe, expect, it } from "vitest";
import {
  applyStepVerdictAttribution,
  computePosterior,
  DEFAULT_SUCCESS_RATE_PRIOR,
  HARNESS_GAMMA,
  HARNESS_PRIOR_MASS,
  HARNESS_VERDICT_FAIL_PENALTY,
  type HarnessStepVerdictAttribution,
  type HarnessSuccessRatePrior,
} from "../services/workflow/harness-attribution.js";

const GAMMA = HARNESS_GAMMA;

function prior(s: number, f: number, n: number, err: number): HarnessSuccessRatePrior {
  return { ewmaSuccess: s, ewmaFail: f, rawSamples: n, consecutiveErrors: err };
}

function attr(outcome: string, verdictPass: boolean | null): HarnessStepVerdictAttribution {
  return { runId: "run-1", stepRunId: "step-1", outcome, verdictPass, stallDetected: false, durationMs: 1_234 };
}

describe("applyStepVerdictAttribution", () => {
  it("pass update decays the EWMA and resets consecutive errors", () => {
    const before = prior(1.0, 1.0, 3, 1);
    const u = applyStepVerdictAttribution(before, attr("ok", null));
    expect(u).toEqual({
      runId: "run-1",
      stepRunId: "step-1",
      kind: "success",
      recorded: true,
      weight: 1.0,
      // Rust: s = 1.0·γ + 1.0, f = 1.0·γ
      prior: { ewmaSuccess: 1.0 * GAMMA + 1.0, ewmaFail: 1.0 * GAMMA, rawSamples: 4, consecutiveErrors: 0 },
    });
    expect(before).toEqual(prior(1.0, 1.0, 3, 1)); // input never mutated
    // verifier pass keeps the same weight; case/whitespace tolerant
    const u2 = applyStepVerdictAttribution(prior(1.0, 1.0, 3, 0), attr("completed", true));
    expect([u2.kind, u2.weight]).toEqual(["success", 1.0]);
    expect(applyStepVerdictAttribution(prior(0, 0, 0, 0), attr(" OK ", null)).kind).toBe("success");
  });

  it("fail update counts a single weighted failure sample", () => {
    const u = applyStepVerdictAttribution(prior(1.0, 0.0, 1, 1), attr("fail", null));
    expect(u.kind).toBe("failed");
    expect(u.weight).toBe(1.0);
    expect(u.prior.ewmaSuccess).toBeCloseTo(GAMMA, 12);
    expect(u.prior.ewmaFail).toBeCloseTo(1.0, 12);
    expect([u.prior.rawSamples, u.prior.consecutiveErrors]).toEqual([2, 2]);
    for (const outcome of ["failed", "error"]) {
      expect(applyStepVerdictAttribution(prior(0, 0, 0, 0), attr(outcome, null)).kind).toBe("failed");
    }
    // outcome string wins over a passing verifier
    expect(applyStepVerdictAttribution(prior(0, 0, 0, 0), attr("error", true)).weight).toBe(1.0);
  });

  it("verifier rejection applies the 2.0 double penalty", () => {
    expect(HARNESS_VERDICT_FAIL_PENALTY).toBe(2.0);
    const u = applyStepVerdictAttribution(prior(2.0, 1.0, 4, 0), attr("ok", false));
    expect(u.kind).toBe("failed");
    expect(u.weight).toBe(2.0);
    expect(u.prior.ewmaSuccess).toBeCloseTo(2.0 * GAMMA, 12);
    expect(u.prior.ewmaFail).toBeCloseTo(1.0 * GAMMA + 2.0, 12);
    expect(u.prior.consecutiveErrors).toBe(1);
    expect(applyStepVerdictAttribution(prior(0, 0, 0, 0), attr("fail", false)).weight).toBe(2.0);
    expect(applyStepVerdictAttribution(prior(0, 0, 0, 0), attr("success", false)).kind).toBe("failed");
  });

  it("rework and stall count as single failures; stall outranks outcome", () => {
    const r = applyStepVerdictAttribution(prior(1.0, 0.0, 1, 1), attr("rework", null));
    expect([r.kind, r.weight, r.prior.consecutiveErrors]).toEqual(["rework", 1.0, 2]);
    const stalled = { ...attr("ok", true), stallDetected: true };
    const s = applyStepVerdictAttribution(prior(1.0, 0.0, 1, 0), stalled);
    expect([s.kind, s.weight, s.recorded]).toEqual(["stalled", 1.0, true]);
    expect(s.prior.ewmaFail).toBeCloseTo(1.0, 12);
    expect(s.prior.consecutiveErrors).toBe(1);
  });

  it("isolates environmental outcomes and unrecognized outcomes (no-op)", () => {
    const before = prior(1.0, 1.0, 3, 2);
    for (const outcome of ["config_error", "interrupted", "rerouted", "skipped"]) {
      const u = applyStepVerdictAttribution(before, attr(outcome, false));
      expect([u.kind, u.recorded, u.weight], outcome).toEqual(["isolated", false, 0]);
      expect(u.prior, outcome).toEqual(before);
    }
    const u = applyStepVerdictAttribution(before, attr("weird", null));
    expect([u.kind, u.recorded, u.weight]).toEqual(["unrecognized", false, 0]);
    expect(u.prior).toEqual(before);
  });

  it("does not record when runId or stepRunId is missing/blank", () => {
    for (const [run, step] of [["", "s"], ["   ", "s"], ["r", ""], ["r", " "]]) {
      const u = applyStepVerdictAttribution(prior(1.0, 1.0, 1, 0), { ...attr("fail", null), runId: run, stepRunId: step });
      expect(u.recorded, `${JSON.stringify(run)}/${JSON.stringify(step)}`).toBe(false);
      expect(u.kind).toBe("failed"); // classified, but not recorded
      expect(u.prior).toEqual(prior(1.0, 1.0, 1, 0));
    }
  });

  it("matches the hand-computed Rust EWMA sequence exactly and is deterministic", () => {
    let p = { ...DEFAULT_SUCCESS_RATE_PRIOR };
    for (const [outcome, v] of [["ok", null], ["ok", null], ["fail", null], ["ok", false]] as const) {
      p = applyStepVerdictAttribution(p, attr(outcome, v)).prior;
    }
    expect(p.ewmaSuccess).toBe(GAMMA ** 2 + GAMMA ** 3);
    expect(p.ewmaFail).toBe(GAMMA + 2.0);
    expect([p.rawSamples, p.consecutiveErrors]).toEqual([4, 2]);
    const a = applyStepVerdictAttribution(DEFAULT_SUCCESS_RATE_PRIOR, attr("ok", null));
    expect(applyStepVerdictAttribution(DEFAULT_SUCCESS_RATE_PRIOR, attr("ok", null))).toEqual(a);
  });

  it("saturates counters instead of overflowing", () => {
    const u = applyStepVerdictAttribution(
      { ewmaSuccess: 0, ewmaFail: 0, rawSamples: Number.MAX_SAFE_INTEGER, consecutiveErrors: 0xffff_ffff },
      attr("fail", null),
    );
    expect([u.prior.rawSamples, u.prior.consecutiveErrors]).toEqual([Number.MAX_SAFE_INTEGER, 0xffff_ffff]);
  });
});

describe("computePosterior", () => {
  it("returns p0 for the empty prior and switches to measured at n ≥ 5", () => {
    const empty = computePosterior(DEFAULT_SUCCESS_RATE_PRIOR, 0.88);
    expect(empty.p).toBeCloseTo(0.88, 12);
    expect([empty.measured, empty.samples]).toEqual([false, 0]);
    // (M0·p0 + s) / (M0 + s + f) = (6·0.88 + 2) / (6 + 2 + 1)
    const post = computePosterior(prior(2.0, 1.0, 5, 0), 0.88);
    expect(post.p).toBeCloseTo((HARNESS_PRIOR_MASS * 0.88 + 2.0) / 9.0, 12);
    expect(post.measured).toBe(true);
    expect(computePosterior(prior(2.0, 1.0, 4, 0), 0.88).measured).toBe(false);
  });

  it("reduces the influence of p0 as samples accumulate", () => {
    const heavy = prior(90.0, 10.0, 100, 0);
    expect(computePosterior(heavy, 0.88).p).toBeCloseTo((6.0 * 0.88 + 90.0) / 106.0, 12);
    const lowP0 = computePosterior(heavy, 0.1).p;
    expect(lowP0).toBeCloseTo((6.0 * 0.1 + 90.0) / 106.0, 12);
    expect(lowP0).toBeGreaterThan(0.85);
    expect(lowP0).toBeLessThan(0.9);
  });
});

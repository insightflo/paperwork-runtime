import { describe, expect, it } from "vitest";
import {
  aggregateDevinSessionMetrics,
  isDevinFreeTierModel,
  type DevinRunMetricSample,
} from "../services/devin-session-metrics.js";

describe("devin session metrics", () => {
  it("returns zeroed metrics for empty input", () => {
    expect(aggregateDevinSessionMetrics([])).toEqual({
      totalRuns: 0,
      successRatePercent: 0,
      resumeHitRatePercent: 0,
      freshRetryCount: 0,
      freeTierRunSharePercent: 0,
      avgDurationMs: 0,
      totalTokens: 0,
    });
  });

  it("aggregates mixed free-tier and non-free-tier samples", () => {
    const samples: DevinRunMetricSample[] = [
      {
        model: "swe-2-flash-medium",
        durationMs: 1_000,
        resumedSession: true,
        succeeded: true,
        inputTokens: 100,
        outputTokens: 50,
      },
      {
        model: "swe-2-1-max",
        durationMs: 2_000,
        resumedSession: false,
        retryFreshAfterUnknownSession: true,
        succeeded: true,
        inputTokens: 200,
        outputTokens: 100,
      },
      {
        model: "swe-2-flash-high",
        durationMs: 4_000,
        resumedSession: true,
        succeeded: false,
      },
    ];

    expect(aggregateDevinSessionMetrics(samples)).toEqual({
      totalRuns: 3,
      successRatePercent: 66.7,
      resumeHitRatePercent: 66.7,
      freshRetryCount: 1,
      freeTierRunSharePercent: 66.7,
      avgDurationMs: 2_333,
      totalTokens: 450,
    });
  });

  it("detects free-tier models case-insensitively from the model prefix", () => {
    expect(isDevinFreeTierModel("swe-2-flash-medium")).toBe(true);
    expect(isDevinFreeTierModel("SWE-2-FLASH-HIGH")).toBe(true);
    expect(isDevinFreeTierModel("swe-2-1-max")).toBe(false);
    expect(isDevinFreeTierModel("prefix-swe-2-flash-medium")).toBe(false);
  });

  it("clamps negative durations and token counts to zero", () => {
    const samples: DevinRunMetricSample[] = [
      {
        model: "swe-2-flash-medium",
        durationMs: -500,
        resumedSession: false,
        succeeded: false,
        inputTokens: -100,
        outputTokens: -50,
      },
      {
        model: "swe-2-1-max",
        durationMs: 1_000,
        resumedSession: true,
        succeeded: true,
        inputTokens: 200,
        outputTokens: -20,
      },
    ];

    expect(aggregateDevinSessionMetrics(samples)).toEqual({
      totalRuns: 2,
      successRatePercent: 50,
      resumeHitRatePercent: 50,
      freshRetryCount: 0,
      freeTierRunSharePercent: 50,
      avgDurationMs: 500,
      totalTokens: 200,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  computeMedian,
  detectRunCostAnomaly,
} from "../services/heartbeat-cost-anomaly.js";

describe("computeMedian", () => {
  it("returns 0 for empty input and medians for odd and even sample counts", () => {
    expect(computeMedian([])).toBe(0);
    expect(computeMedian([0.3, 0.1, 0.2])).toBe(0.2);
    expect(computeMedian([0.4, 0.1, 0.3, 0.2])).toBe(0.25);
  });
});

describe("detectRunCostAnomaly", () => {
  it("does not flag runs with insufficient baseline samples", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 2.5,
      historicalCostsUsd: [0.5, 0.5, 0.5, 0.5],
    });

    expect(result.isAnomaly).toBe(false);
    expect(result.reason).toBe("Insufficient baseline samples");
    expect(result.baselineMedianUsd).toBe(0.5);
  });

  it("does not flag a normal run within the multiplier threshold", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 1.4,
      historicalCostsUsd: [0.5, 0.5, 0.5, 0.5, 0.5],
    });

    expect(result).toEqual({
      isAnomaly: false,
      baselineMedianUsd: 0.5,
      ratioToMedian: 2.8,
      reason: "Cost within baseline multiplier threshold",
    });
  });

  it("suppresses tiny absolute deltas even when the ratio is high", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 0.05,
      historicalCostsUsd: [0.01, 0.01, 0.01, 0.01, 0.01],
    });

    expect(result.isAnomaly).toBe(false);
    expect(result.ratioToMedian).toBe(5);
    expect(result.reason).toBe("Cost delta below minimum absolute threshold");
  });

  it("flags a true cost spike above the baseline", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 2.5,
      historicalCostsUsd: [0.5, 0.5, 0.5, 0.5, 0.5],
    });

    expect(result).toEqual({
      isAnomaly: true,
      baselineMedianUsd: 0.5,
      ratioToMedian: 5,
      reason: "Cost exceeds baseline multiplier and minimum delta",
    });
  });

  it("flags a zero-median free-tier baseline spike", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 0.5,
      historicalCostsUsd: [0, 0, 0, 0, 0],
    });

    expect(result).toEqual({
      isAnomaly: true,
      baselineMedianUsd: 0,
      ratioToMedian: Infinity,
      reason: "Cost exceeds baseline multiplier and minimum delta",
    });
  });

  it("ignores non-finite and negative historical samples", () => {
    const result = detectRunCostAnomaly({
      currentCostUsd: 2.5,
      historicalCostsUsd: [0.5, 0.5, 0.5, 0.5, 0.5, Number.NaN, Infinity, -1],
    });

    expect(result.isAnomaly).toBe(true);
    expect(result.baselineMedianUsd).toBe(0.5);
  });
});

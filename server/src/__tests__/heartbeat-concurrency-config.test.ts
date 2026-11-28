import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONCURRENCY_POLICY,
  normalizeConcurrencyPolicy,
} from "../services/heartbeat-concurrency-config.js";

describe("normalizeConcurrencyPolicy", () => {
  it("returns the default policy with no warnings for null or empty input", () => {
    for (const input of [null, undefined, {}] as const) {
      const result = normalizeConcurrencyPolicy(input);

      expect(result.config).toEqual(DEFAULT_CONCURRENCY_POLICY);
      expect(result.warnings).toEqual([]);
    }
  });

  it("passes valid custom values through with zero warnings", () => {
    const custom = {
      maxConcurrentRuns: 4,
      reserveInteractiveHeadroom: false,
      coalesceWindowMs: 2_500,
      starvationWarningMs: 900_000,
      maxDelegationDepth: 2,
      maxActiveChildren: 7,
    };

    const result = normalizeConcurrencyPolicy(custom);

    expect(result.config).toEqual(custom);
    expect(result.warnings).toEqual([]);
  });

  it("accepts exact numeric bounds without warnings", () => {
    const boundaryValues = {
      maxConcurrentRuns: 10,
      reserveInteractiveHeadroom: true,
      coalesceWindowMs: 0,
      starvationWarningMs: 3_600_000,
      maxDelegationDepth: 1,
      maxActiveChildren: 10,
    };

    const result = normalizeConcurrencyPolicy(boundaryValues);

    expect(result.config).toEqual(boundaryValues);
    expect(result.warnings).toEqual([]);
  });

  it("clamps out-of-bounds and negative values to exact bounds with warnings", () => {
    const result = normalizeConcurrencyPolicy({
      maxConcurrentRuns: 99,
      reserveInteractiveHeadroom: false,
      coalesceWindowMs: -1,
      starvationWarningMs: 3_600_001,
      maxDelegationDepth: 0,
      maxActiveChildren: -4,
    });

    expect(result.config).toEqual({
      maxConcurrentRuns: 10,
      reserveInteractiveHeadroom: false,
      coalesceWindowMs: 0,
      starvationWarningMs: 3_600_000,
      maxDelegationDepth: 1,
      maxActiveChildren: 1,
    });
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings.join("\n")).toContain("maxConcurrentRuns");
    expect(result.warnings.join("\n")).toContain("coalesceWindowMs");
    expect(result.warnings.join("\n")).toContain("starvationWarningMs");
    expect(result.warnings.join("\n")).toContain("maxDelegationDepth");
    expect(result.warnings.join("\n")).toContain("maxActiveChildren");
  });

  it("defaults NaN, infinite, and wrongly typed values with warnings", () => {
    const result = normalizeConcurrencyPolicy({
      maxConcurrentRuns: Number.NaN,
      reserveInteractiveHeadroom: "yes",
      coalesceWindowMs: Number.POSITIVE_INFINITY,
      starvationWarningMs: "600000",
      maxDelegationDepth: null,
    });

    expect(result.config).toEqual(DEFAULT_CONCURRENCY_POLICY);
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings.join("\n")).toContain("maxConcurrentRuns");
    expect(result.warnings.join("\n")).toContain("reserveInteractiveHeadroom");
    expect(result.warnings.join("\n")).toContain("coalesceWindowMs");
    expect(result.warnings.join("\n")).toContain("starvationWarningMs");
    expect(result.warnings.join("\n")).toContain("maxDelegationDepth");
  });
});

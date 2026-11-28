import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_RUNS_MAX,
  MAX_CONCURRENT_RUNS_MIN,
  clampMaxConcurrentRuns,
  heartbeatWithClampedMaxConcurrentRuns,
} from "../agent-concurrency";

describe("agent concurrency constants", () => {
  it("exposes the persisted 1..10 execution-slot bounds", () => {
    expect(MAX_CONCURRENT_RUNS_MIN).toBe(1);
    expect(MAX_CONCURRENT_RUNS_MAX).toBe(10);
  });
});

describe("clampMaxConcurrentRuns", () => {
  it("keeps every valid integer in the 1..10 range unchanged", () => {
    for (let value = MAX_CONCURRENT_RUNS_MIN; value <= MAX_CONCURRENT_RUNS_MAX; value += 1) {
      expect(clampMaxConcurrentRuns(value)).toBe(value);
    }
  });

  it("clamps values below the minimum to 1", () => {
    for (const value of [0, -1, -999]) {
      expect(clampMaxConcurrentRuns(value)).toBe(MAX_CONCURRENT_RUNS_MIN);
    }
  });

  it("clamps values above the maximum to 10", () => {
    for (const value of [11, 999]) {
      expect(clampMaxConcurrentRuns(value)).toBe(MAX_CONCURRENT_RUNS_MAX);
    }
  });

  it("floors fractional numeric input before clamping", () => {
    expect(clampMaxConcurrentRuns(1.9)).toBe(1);
    expect(clampMaxConcurrentRuns(4.5)).toBe(4);
    expect(clampMaxConcurrentRuns(9.999)).toBe(9);
    expect(clampMaxConcurrentRuns(10.9)).toBe(MAX_CONCURRENT_RUNS_MAX);
    expect(clampMaxConcurrentRuns(-0.5)).toBe(MAX_CONCURRENT_RUNS_MIN);
  });

  it("parses numeric strings through the same floor-and-clamp contract", () => {
    expect(clampMaxConcurrentRuns("1")).toBe(1);
    expect(clampMaxConcurrentRuns(" 7.8 ")).toBe(7);
    expect(clampMaxConcurrentRuns("10")).toBe(MAX_CONCURRENT_RUNS_MAX);
    expect(clampMaxConcurrentRuns("11")).toBe(MAX_CONCURRENT_RUNS_MAX);
    expect(clampMaxConcurrentRuns("-999")).toBe(MAX_CONCURRENT_RUNS_MIN);
  });

  it("falls back to 1 for non-finite numbers", () => {
    expect(clampMaxConcurrentRuns(Number.NaN)).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns(Number.POSITIVE_INFINITY)).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns(Number.NEGATIVE_INFINITY)).toBe(MAX_CONCURRENT_RUNS_MIN);
  });

  it("falls back to 1 for null, undefined, and non-numeric strings", () => {
    expect(clampMaxConcurrentRuns(null)).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns(undefined)).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns("not-a-number")).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns("Infinity")).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns("")).toBe(MAX_CONCURRENT_RUNS_MIN);
    expect(clampMaxConcurrentRuns("   ")).toBe(MAX_CONCURRENT_RUNS_MIN);
  });
});

describe("heartbeatWithClampedMaxConcurrentRuns", () => {
  it("returns a new heartbeat object and preserves sibling keys", () => {
    const nestedPolicy = { retries: 2 };
    const heartbeat = {
      enabled: true,
      intervalSec: 60,
      nestedPolicy,
      maxConcurrentRuns: 5,
    };

    const next = heartbeatWithClampedMaxConcurrentRuns(heartbeat, 999);

    expect(next).not.toBe(heartbeat);
    expect(next).toEqual({ ...heartbeat, maxConcurrentRuns: MAX_CONCURRENT_RUNS_MAX });
    expect(next.nestedPolicy).toBe(nestedPolicy);
    expect(heartbeat.maxConcurrentRuns).toBe(5);
  });

  it("uses the same invalid-input fallback when writing maxConcurrentRuns", () => {
    const next = heartbeatWithClampedMaxConcurrentRuns({ enabled: false }, Number.NaN);

    expect(next).toEqual({ enabled: false, maxConcurrentRuns: MAX_CONCURRENT_RUNS_MIN });
  });
});

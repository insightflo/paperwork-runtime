// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  clampMaxConcurrentRuns,
  heartbeatWithClampedMaxConcurrentRuns,
} from "../../lib/agent-concurrency";

describe("agent maxConcurrentRuns UI contract", () => {
  it("clamps numeric values into the 1..10 execution-slot range", () => {
    expect(clampMaxConcurrentRuns(0)).toBe(1);
    expect(clampMaxConcurrentRuns(-4)).toBe(1);
    expect(clampMaxConcurrentRuns(1)).toBe(1);
    expect(clampMaxConcurrentRuns(4.9)).toBe(4);
    expect(clampMaxConcurrentRuns(10)).toBe(10);
    expect(clampMaxConcurrentRuns(11)).toBe(10);
  });

  it("parses numeric strings and falls back to 1 for invalid or blank input", () => {
    expect(clampMaxConcurrentRuns("3")).toBe(3);
    expect(clampMaxConcurrentRuns(" 7.8 ")).toBe(7);
    expect(clampMaxConcurrentRuns("")).toBe(1);
    expect(clampMaxConcurrentRuns("   ")).toBe(1);
    expect(clampMaxConcurrentRuns("not-a-number")).toBe(1);
    expect(clampMaxConcurrentRuns(Number.NaN)).toBe(1);
    expect(clampMaxConcurrentRuns(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampMaxConcurrentRuns(undefined)).toBe(1);
    expect(clampMaxConcurrentRuns(null)).toBe(1);
  });

  it("preserves every runtimeConfig.heartbeat key while replacing only maxConcurrentRuns", () => {
    const sessionCompaction = { maxSessionRuns: 3, maxRawInputTokens: 0 };
    const heartbeat = {
      enabled: false,
      intervalSec: 300,
      wakeOnDemand: false,
      cooldownSec: 10,
      sessionCompaction,
      futureContractKey: { nested: ["keep-me"] },
      maxConcurrentRuns: 3,
    };

    const next = heartbeatWithClampedMaxConcurrentRuns(heartbeat, 11);

    expect(next).toEqual({ ...heartbeat, maxConcurrentRuns: 10 });
    expect(Object.keys(next).sort()).toEqual(Object.keys(heartbeat).sort());
    expect(next.sessionCompaction).toBe(sessionCompaction);
    expect(heartbeat.maxConcurrentRuns).toBe(3);
  });
});

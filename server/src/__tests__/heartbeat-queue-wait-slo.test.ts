import { describe, expect, it } from "vitest";
import {
  computeNearestRankPercentile,
  evaluateQueueWaitSlo,
} from "../services/heartbeat-queue-wait-slo.js";

describe("computeNearestRankPercentile", () => {
  it("returns 0 for empty input", () => {
    expect(computeNearestRankPercentile([], 50)).toBe(0);
    expect(computeNearestRankPercentile([], 95)).toBe(0);
  });

  it("computes nearest-rank percentile values", () => {
    const sortedAsc = [100, 200, 300, 400, 500];

    expect(computeNearestRankPercentile(sortedAsc, 50)).toBe(300);
    expect(computeNearestRankPercentile(sortedAsc, 95)).toBe(500);
    expect(computeNearestRankPercentile(sortedAsc, 99)).toBe(500);
  });

  it("clamps percentile input to the 0..100 range", () => {
    const sortedAsc = [100, 200, 300];

    expect(computeNearestRankPercentile(sortedAsc, -10)).toBe(100);
    expect(computeNearestRankPercentile(sortedAsc, 150)).toBe(300);
  });
});

describe("evaluateQueueWaitSlo", () => {
  it("returns every lane in deterministic order for empty input", () => {
    const reports = evaluateQueueWaitSlo([]);

    expect(reports.map((report) => report.lane)).toEqual([
      "interactive",
      "recovery",
      "workflow",
      "scheduled",
    ]);
    expect(reports).toEqual([
      {
        lane: "interactive",
        count: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        sloTargetMs: 30_000,
        breached: false,
      },
      {
        lane: "recovery",
        count: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        sloTargetMs: 60_000,
        breached: false,
      },
      {
        lane: "workflow",
        count: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        sloTargetMs: 180_000,
        breached: false,
      },
      {
        lane: "scheduled",
        count: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        sloTargetMs: 600_000,
        breached: false,
      },
    ]);
  });

  it("computes lane percentile statistics from unsorted samples", () => {
    const reports = evaluateQueueWaitSlo([
      { lane: "interactive", waitMs: 500 },
      { lane: "interactive", waitMs: 100 },
      { lane: "interactive", waitMs: 300 },
      { lane: "interactive", waitMs: 200 },
      { lane: "interactive", waitMs: 400 },
      { lane: "workflow", waitMs: 1_000 },
    ]);

    expect(reports[0]).toMatchObject({
      lane: "interactive",
      count: 5,
      p50Ms: 300,
      p95Ms: 500,
      p99Ms: 500,
      maxMs: 500,
    });
    expect(reports[2]).toMatchObject({
      lane: "workflow",
      count: 1,
      p50Ms: 1_000,
      p95Ms: 1_000,
      p99Ms: 1_000,
      maxMs: 1_000,
    });
  });

  it("marks lanes breached only when p95 exceeds the target", () => {
    const reports = evaluateQueueWaitSlo([
      { lane: "interactive", waitMs: 30_001 },
      { lane: "recovery", waitMs: 60_000 },
    ]);

    expect(reports[0]!.breached).toBe(true);
    expect(reports[1]!.breached).toBe(false);
    expect(reports[2]!.breached).toBe(false);
    expect(reports[3]!.breached).toBe(false);
  });

  it("clamps negative wait times to zero", () => {
    const reports = evaluateQueueWaitSlo([
      { lane: "interactive", waitMs: -250 },
    ]);

    expect(reports[0]).toMatchObject({
      count: 1,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      breached: false,
    });
  });

  it("uses custom target overrides for breach evaluation", () => {
    const reports = evaluateQueueWaitSlo(
      [{ lane: "scheduled", waitMs: 1_000 }],
      { scheduled: 500 },
    );

    expect(reports[3]).toMatchObject({
      lane: "scheduled",
      sloTargetMs: 500,
      p95Ms: 1_000,
      breached: true,
    });
  });
});

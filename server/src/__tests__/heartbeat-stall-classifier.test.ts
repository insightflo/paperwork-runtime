import { describe, expect, it } from "vitest";
import { assessRunStall } from "../services/heartbeat-stall-classifier.js";

const MINUTE_MS = 60_000;

describe("assessRunStall", () => {
  it("returns active when output is newer than the idle threshold", () => {
    const assessment = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 4 * MINUTE_MS,
      nowMs: 5 * MINUTE_MS,
    });

    expect(assessment).toEqual({
      verdict: "active",
      idleMs: MINUTE_MS,
      effectiveThresholdMs: 5 * MINUTE_MS,
      reason: expect.stringContaining("idle threshold"),
    });
  });

  it("returns active at the millisecond before the idle threshold boundary", () => {
    const assessment = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 0,
      nowMs: 5 * MINUTE_MS - 1,
    });

    expect(assessment.verdict).toBe("active");
    expect(assessment.idleMs).toBe(5 * MINUTE_MS - 1);
  });

  it("returns slow_tool_grace for an active tool call between the idle and tool grace thresholds", () => {
    const assessment = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 2 * MINUTE_MS,
      nowMs: 12 * MINUTE_MS,
      activeToolCall: true,
    });

    expect(assessment).toEqual({
      verdict: "slow_tool_grace",
      idleMs: 10 * MINUTE_MS,
      effectiveThresholdMs: 15 * MINUTE_MS,
      reason: expect.stringContaining("active tool call"),
    });
  });

  it("returns stalled without an active tool call at the idle threshold", () => {
    const assessment = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 0,
      nowMs: 5 * MINUTE_MS,
    });

    expect(assessment.verdict).toBe("stalled");
    expect(assessment.idleMs).toBe(5 * MINUTE_MS);
    expect(assessment.effectiveThresholdMs).toBe(5 * MINUTE_MS);
  });

  it("returns stalled for an active tool call at the tool grace threshold", () => {
    const assessment = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 0,
      nowMs: 15 * MINUTE_MS,
      activeToolCall: true,
    });

    expect(assessment.verdict).toBe("stalled");
    expect(assessment.idleMs).toBe(15 * MINUTE_MS);
    expect(assessment.effectiveThresholdMs).toBe(15 * MINUTE_MS);
  });

  it("uses the later of startedAtMs and lastOutputAtMs as the activity timestamp", () => {
    const assessment = assessRunStall({
      startedAtMs: 10 * MINUTE_MS,
      lastOutputAtMs: 0,
      nowMs: 11 * MINUTE_MS,
    });

    expect(assessment.verdict).toBe("active");
    expect(assessment.idleMs).toBe(MINUTE_MS);
  });

  it("clamps negative idle time from clock skew to zero", () => {
    const assessment = assessRunStall({
      startedAtMs: 10 * MINUTE_MS,
      lastOutputAtMs: 12 * MINUTE_MS,
      nowMs: 11 * MINUTE_MS,
    });

    expect(assessment.verdict).toBe("active");
    expect(assessment.idleMs).toBe(0);
  });

  it("honors custom idle and tool grace thresholds", () => {
    const grace = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      activeToolCall: true,
      idleThresholdMs: 1_000,
      toolGraceThresholdMs: 3_000,
    });
    const stalled = assessRunStall({
      startedAtMs: 0,
      lastOutputAtMs: 0,
      nowMs: 3_000,
      activeToolCall: true,
      idleThresholdMs: 1_000,
      toolGraceThresholdMs: 3_000,
    });

    expect(grace.verdict).toBe("slow_tool_grace");
    expect(grace.effectiveThresholdMs).toBe(3_000);
    expect(stalled.verdict).toBe("stalled");
    expect(stalled.effectiveThresholdMs).toBe(3_000);
  });
});

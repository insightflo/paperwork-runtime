import { describe, expect, it } from "vitest";
import { synthesizeFleetQueueHealth } from "../services/heartbeat-queue-health-digest.js";

const baseInput = {
  totalSlots: 10,
  totalRunning: 5,
  totalQueued: 0,
  saturatedAgents: 0,
  starvingAgents: 0,
  deadlockCycles: 0,
  coolingDownProviders: 0,
};

describe("synthesizeFleetQueueHealth", () => {
  it("reports healthy with empty signals when no condition is active", () => {
    const digest = synthesizeFleetQueueHealth(baseInput);
    expect(digest.level).toBe("healthy");
    expect(digest.signals).toEqual([]);
    expect(digest.utilizationPercent).toBe(50);
    expect(digest.headline).toContain("정상");
    expect(digest.headline).toContain("50%");
  });

  it("reports degraded when only providers are cooling down", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, coolingDownProviders: 2 });
    expect(digest.level).toBe("degraded");
    expect(digest.signals).toEqual(["프로바이더 쿨다운 2곳"]);
    expect(digest.headline).toContain("저하");
    expect(digest.headline).toContain("프로바이더 쿨다운 2곳");
  });

  it("reports degraded when agents are saturated with a queued backlog", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, saturatedAgents: 3, totalQueued: 7 });
    expect(digest.level).toBe("degraded");
    expect(digest.signals).toEqual(["슬롯 포화 3명 · 대기 7건"]);
    expect(digest.headline).toContain("저하");
  });

  it("stays healthy when agents are saturated but nothing is queued", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, saturatedAgents: 4, totalQueued: 0 });
    expect(digest.level).toBe("healthy");
    expect(digest.signals).toEqual([]);
  });

  it("reports critical when deadlock cycles exist", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, deadlockCycles: 2 });
    expect(digest.level).toBe("critical");
    expect(digest.signals).toEqual(["순환 대기 2건"]);
    expect(digest.headline).toContain("위험");
    expect(digest.headline).toContain("순환 대기 2건");
  });

  it("reports critical when agents are starving", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, starvingAgents: 4 });
    expect(digest.level).toBe("critical");
    expect(digest.signals).toEqual(["장기 대기 에이전트 4명"]);
    expect(digest.headline).toContain("위험");
  });

  it("critical takes precedence over degraded conditions", () => {
    const digest = synthesizeFleetQueueHealth({
      ...baseInput,
      deadlockCycles: 1,
      coolingDownProviders: 3,
      saturatedAgents: 2,
      totalQueued: 5,
    });
    expect(digest.level).toBe("critical");
    expect(digest.signals).toEqual([
      "순환 대기 1건",
      "프로바이더 쿨다운 3곳",
      "슬롯 포화 2명 · 대기 5건",
    ]);
  });

  it("orders every simultaneous signal by severity and folds extras in the headline", () => {
    const digest = synthesizeFleetQueueHealth({
      totalSlots: 8,
      totalRunning: 8,
      totalQueued: 6,
      saturatedAgents: 3,
      starvingAgents: 2,
      deadlockCycles: 1,
      coolingDownProviders: 1,
    });
    expect(digest.level).toBe("critical");
    expect(digest.signals).toEqual([
      "순환 대기 1건",
      "장기 대기 에이전트 2명",
      "프로바이더 쿨다운 1곳",
      "슬롯 포화 3명 · 대기 6건",
    ]);
    expect(digest.headline).toBe("큐 위험 — 순환 대기 1건 외 3개");
    expect(digest.utilizationPercent).toBe(100);
  });

  it("returns zero utilization when the fleet has no slots", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, totalSlots: 0, totalRunning: 0 });
    expect(digest.utilizationPercent).toBe(0);
    expect(digest.level).toBe("healthy");
  });

  it("caps utilization at 100 even when running exceeds slots", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, totalSlots: 10, totalRunning: 12 });
    expect(digest.utilizationPercent).toBe(100);
  });

  it("rounds utilization to the nearest integer percent", () => {
    const digest = synthesizeFleetQueueHealth({ ...baseInput, totalSlots: 3, totalRunning: 1 });
    expect(digest.utilizationPercent).toBe(33);
  });
});

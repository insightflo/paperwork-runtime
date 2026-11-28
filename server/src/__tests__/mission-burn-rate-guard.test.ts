import { describe, expect, it } from "vitest";
import { assessMissionBurnRate, type MissionBurnRateInput } from "../services/mission-burn-rate-guard.js";

function input(overrides: Partial<MissionBurnRateInput>): MissionBurnRateInput {
  return {
    missionId: "mission-1",
    spentUsd: 20,
    budgetUsd: 100,
    recentWindowSpentUsd: 2,
    recentWindowMinutes: 30,
    ...overrides,
  };
}

describe("assessMissionBurnRate", () => {
  it("returns normal for low utilization with a comfortable runway", () => {
    const result = assessMissionBurnRate(input({}));
    expect(result).toEqual({
      missionId: "mission-1",
      verdict: "normal",
      utilizationPercent: 20,
      burnUsdPerHour: 4,
      projectedRunwayMinutes: 1200,
      shouldThrottleSlots: false,
      reason: "burn rate is within normal bounds",
    });
  });

  it("returns elevated at or above 65 percent utilization without throttling slots", () => {
    const result = assessMissionBurnRate(input({ spentUsd: 65, recentWindowSpentUsd: 1, recentWindowMinutes: 60 }));
    expect(result.verdict).toBe("elevated");
    expect(result.utilizationPercent).toBe(65);
    expect(result.shouldThrottleSlots).toBe(false);
  });

  it("returns critical_throttle at or above 85 percent utilization", () => {
    const result = assessMissionBurnRate(input({ spentUsd: 85, recentWindowSpentUsd: 0, recentWindowMinutes: 0 }));
    expect(result.verdict).toBe("critical_throttle");
    expect(result.utilizationPercent).toBe(85);
    expect(result.projectedRunwayMinutes).toBeNull();
    expect(result.shouldThrottleSlots).toBe(true);
  });

  it("returns critical_throttle when the projected runway is 30 minutes or less", () => {
    const result = assessMissionBurnRate(input({ spentUsd: 70, recentWindowSpentUsd: 30, recentWindowMinutes: 30 }));
    expect(result.verdict).toBe("critical_throttle");
    expect(result.utilizationPercent).toBe(70);
    expect(result.burnUsdPerHour).toBe(60);
    expect(result.projectedRunwayMinutes).toBe(30);
    expect(result.shouldThrottleSlots).toBe(true);
  });

  it("returns budget_exhausted once spend reaches or exceeds the budget", () => {
    for (const spentUsd of [100, 120]) {
      const result = assessMissionBurnRate(input({ spentUsd }));
      expect(result.verdict).toBe("budget_exhausted");
      expect(result.projectedRunwayMinutes).toBe(0);
      expect(result.shouldThrottleSlots).toBe(true);
    }
  });

  it("treats a zero or negative budget as unbounded and never throttles", () => {
    for (const budgetUsd of [0, -10]) {
      const result = assessMissionBurnRate(input({ budgetUsd, spentUsd: 1000, recentWindowSpentUsd: 6, recentWindowMinutes: 15 }));
      expect(result).toMatchObject({
        verdict: "normal",
        utilizationPercent: 0,
        burnUsdPerHour: 24,
        projectedRunwayMinutes: null,
        shouldThrottleSlots: false,
      });
    }
  });

  it("computes burn rate and projected runway with the specified rounding", () => {
    const result = assessMissionBurnRate(input({
      spentUsd: 25,
      budgetUsd: 200,
      recentWindowSpentUsd: 3,
      recentWindowMinutes: 20,
    }));
    expect(result.utilizationPercent).toBe(12.5);
    expect(result.burnUsdPerHour).toBe(9);
    expect(result.projectedRunwayMinutes).toBe(1167);
  });

  it("rounds fractional hourly burn rates to two decimals before projecting runway", () => {
    const result = assessMissionBurnRate(input({
      spentUsd: 10,
      budgetUsd: 20,
      recentWindowSpentUsd: 1,
      recentWindowMinutes: 45,
    }));
    expect(result.burnUsdPerHour).toBe(1.33);
    expect(result.projectedRunwayMinutes).toBe(451);
  });

  it("clamps negative spend and window values to zero", () => {
    const result = assessMissionBurnRate(input({
      spentUsd: -50,
      recentWindowSpentUsd: -5,
      recentWindowMinutes: -10,
    }));
    expect(result).toMatchObject({
      verdict: "normal",
      utilizationPercent: 0,
      burnUsdPerHour: 0,
      projectedRunwayMinutes: null,
      shouldThrottleSlots: false,
    });
  });
});

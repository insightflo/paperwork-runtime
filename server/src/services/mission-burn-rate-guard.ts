export interface MissionBurnRateInput {
  missionId: string;
  spentUsd: number;
  budgetUsd: number;
  recentWindowSpentUsd: number;
  recentWindowMinutes: number;
  remainingEstimatedMinutes?: number;
}

export type BurnRateVerdict = "normal" | "elevated" | "critical_throttle" | "budget_exhausted";

export interface MissionBurnRateAssessment {
  missionId: string;
  verdict: BurnRateVerdict;
  utilizationPercent: number;
  burnUsdPerHour: number;
  projectedRunwayMinutes: number | null;
  shouldThrottleSlots: boolean;
  reason: string;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function assessment(input: MissionBurnRateInput, values: Omit<MissionBurnRateAssessment, "missionId">): MissionBurnRateAssessment {
  return { missionId: input.missionId, ...values };
}

export function assessMissionBurnRate(input: MissionBurnRateInput): MissionBurnRateAssessment {
  const spentUsd = nonNegativeFinite(input.spentUsd);
  const recentWindowSpentUsd = nonNegativeFinite(input.recentWindowSpentUsd);
  const recentWindowMinutes = nonNegativeFinite(input.recentWindowMinutes);
  const burnUsdPerHour = recentWindowMinutes > 0
    ? Math.round((recentWindowSpentUsd / recentWindowMinutes) * 60 * 100) / 100
    : 0;

  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) {
    return assessment(input, {
      verdict: "normal",
      utilizationPercent: 0,
      burnUsdPerHour,
      projectedRunwayMinutes: null,
      shouldThrottleSlots: false,
      reason: "unbounded budget",
    });
  }

  const utilizationPercent = (spentUsd / input.budgetUsd) * 100;
  const remainingUsd = Math.max(0, input.budgetUsd - spentUsd);
  const projectedRunwayMinutes = burnUsdPerHour > 0
    ? Math.round((remainingUsd / burnUsdPerHour) * 60)
    : null;

  let verdict: BurnRateVerdict = "normal";
  let reason = "burn rate is within normal bounds";
  if (spentUsd >= input.budgetUsd) {
    verdict = "budget_exhausted";
    reason = "mission budget is exhausted";
  } else if (utilizationPercent >= 85 || (projectedRunwayMinutes !== null && projectedRunwayMinutes <= 30)) {
    verdict = "critical_throttle";
    reason = utilizationPercent >= 85
      ? "budget utilization is at least 85 percent"
      : "projected runway is 30 minutes or less";
  } else if (utilizationPercent >= 65) {
    verdict = "elevated";
    reason = "budget utilization is at least 65 percent";
  }

  return assessment(input, {
    verdict,
    utilizationPercent,
    burnUsdPerHour,
    projectedRunwayMinutes,
    shouldThrottleSlots: verdict === "critical_throttle" || verdict === "budget_exhausted",
    reason,
  });
}

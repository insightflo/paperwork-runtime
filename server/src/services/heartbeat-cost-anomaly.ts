export interface CostAnomalyInput {
  currentCostUsd: number;
  historicalCostsUsd: readonly number[];
  minBaselineSamples?: number;
  multiplierThreshold?: number;
  minAbsoluteDeltaUsd?: number;
}

export interface CostAnomalyResult {
  isAnomaly: boolean;
  baselineMedianUsd: number;
  ratioToMedian: number;
  reason: string;
}

export function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function detectRunCostAnomaly(input: CostAnomalyInput): CostAnomalyResult {
  const minBaselineSamples = input.minBaselineSamples ?? 5;
  const multiplierThreshold = input.multiplierThreshold ?? 3.0;
  const minAbsoluteDeltaUsd = input.minAbsoluteDeltaUsd ?? 0.5;
  const validHistory = input.historicalCostsUsd.filter(
    (cost) => Number.isFinite(cost) && cost >= 0,
  );
  const baselineMedianUsd = computeMedian(validHistory);
  const ratioToMedian = baselineMedianUsd > 0
    ? Math.round((input.currentCostUsd / baselineMedianUsd) * 100) / 100
    : input.currentCostUsd >= minAbsoluteDeltaUsd
      ? Infinity
      : 1;
  const exceedsAbsoluteDelta = input.currentCostUsd - baselineMedianUsd >= minAbsoluteDeltaUsd;
  const exceedsMultiplier = baselineMedianUsd === 0
    ? input.currentCostUsd >= minAbsoluteDeltaUsd
    : input.currentCostUsd >= baselineMedianUsd * multiplierThreshold;
  const isAnomaly = exceedsAbsoluteDelta && exceedsMultiplier;

  if (validHistory.length < minBaselineSamples) {
    return {
      isAnomaly: false,
      baselineMedianUsd,
      ratioToMedian,
      reason: "Insufficient baseline samples",
    };
  }

  if (isAnomaly) {
    return {
      isAnomaly,
      baselineMedianUsd,
      ratioToMedian,
      reason: "Cost exceeds baseline multiplier and minimum delta",
    };
  }

  return {
    isAnomaly,
    baselineMedianUsd,
    ratioToMedian,
    reason: exceedsAbsoluteDelta
      ? "Cost within baseline multiplier threshold"
      : "Cost delta below minimum absolute threshold",
  };
}

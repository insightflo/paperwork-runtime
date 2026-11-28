export interface DevinRunMetricSample {
  model: string;
  durationMs: number;
  resumedSession: boolean;
  retryFreshAfterUnknownSession?: boolean;
  succeeded: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface DevinSessionMetricsSummary {
  totalRuns: number;
  successRatePercent: number;
  resumeHitRatePercent: number;
  freshRetryCount: number;
  freeTierRunSharePercent: number;
  avgDurationMs: number;
  totalTokens: number;
}

function emptySummary(): DevinSessionMetricsSummary {
  return {
    totalRuns: 0,
    successRatePercent: 0,
    resumeHitRatePercent: 0,
    freshRetryCount: 0,
    freeTierRunSharePercent: 0,
    avgDurationMs: 0,
    totalTokens: 0,
  };
}

function clampNonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

export function isDevinFreeTierModel(model: string): boolean {
  return model.toLowerCase().startsWith("swe-2-flash");
}

export function aggregateDevinSessionMetrics(
  samples: readonly DevinRunMetricSample[],
): DevinSessionMetricsSummary {
  const totalRuns = samples.length;
  if (totalRuns === 0) {
    return emptySummary();
  }

  let successfulRuns = 0;
  let resumedRuns = 0;
  let freshRetryCount = 0;
  let freeTierRuns = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;

  for (const sample of samples) {
    if (sample.succeeded) {
      successfulRuns += 1;
    }
    if (sample.resumedSession) {
      resumedRuns += 1;
    }
    if (sample.retryFreshAfterUnknownSession === true) {
      freshRetryCount += 1;
    }
    if (isDevinFreeTierModel(sample.model)) {
      freeTierRuns += 1;
    }

    totalDurationMs += clampNonNegative(sample.durationMs);
    totalTokens += clampNonNegative(sample.inputTokens) + clampNonNegative(sample.outputTokens);
  }

  return {
    totalRuns,
    successRatePercent: roundPercent((successfulRuns / totalRuns) * 100),
    resumeHitRatePercent: roundPercent((resumedRuns / totalRuns) * 100),
    freshRetryCount,
    freeTierRunSharePercent: roundPercent((freeTierRuns / totalRuns) * 100),
    avgDurationMs: Math.round(totalDurationMs / totalRuns),
    totalTokens,
  };
}

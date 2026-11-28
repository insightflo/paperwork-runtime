export interface MissionRunCostEntry {
  runId: string;
  adapterType: string;
  model: string;
  costUsd: number;
  freeTier?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AdapterCostBreakdown {
  adapterType: string;
  runCount: number;
  freeTierRuns: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface MissionCostLedgerSummary {
  totalRuns: number;
  freeTierRuns: number;
  paidRuns: number;
  totalCostUsd: number;
  totalTokens: number;
  byAdapter: AdapterCostBreakdown[];
}

type AdapterCostAccumulator = {
  adapterType: string;
  runCount: number;
  freeTierRuns: number;
  totalCostUsd: number;
  totalTokens: number;
};

const USD_ROUNDING_SCALE = 1_000_000;

function nonNegativeNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * USD_ROUNDING_SCALE) / USD_ROUNDING_SCALE;
}

function compareStringsAscending(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function aggregateMissionCostLedger(
  entries: readonly MissionRunCostEntry[],
): MissionCostLedgerSummary {
  const adapters = new Map<string, AdapterCostAccumulator>();
  let totalRuns = 0;
  let freeTierRuns = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;

  for (const entry of entries) {
    const costUsd = nonNegativeNumber(entry.costUsd);
    const inputTokens = nonNegativeNumber(entry.inputTokens);
    const outputTokens = nonNegativeNumber(entry.outputTokens);
    const entryTokens = inputTokens + outputTokens;
    const isFreeTier = entry.freeTier === true;

    totalRuns += 1;
    freeTierRuns += isFreeTier ? 1 : 0;
    totalCostUsd += costUsd;
    totalTokens += entryTokens;

    let adapter = adapters.get(entry.adapterType);
    if (!adapter) {
      adapter = {
        adapterType: entry.adapterType,
        runCount: 0,
        freeTierRuns: 0,
        totalCostUsd: 0,
        totalTokens: 0,
      };
      adapters.set(entry.adapterType, adapter);
    }

    adapter.runCount += 1;
    adapter.freeTierRuns += isFreeTier ? 1 : 0;
    adapter.totalCostUsd += costUsd;
    adapter.totalTokens += entryTokens;
  }

  const byAdapter = Array.from(adapters.values())
    .map((adapter) => ({
      adapterType: adapter.adapterType,
      runCount: adapter.runCount,
      freeTierRuns: adapter.freeTierRuns,
      totalCostUsd: roundUsd(adapter.totalCostUsd),
      totalTokens: adapter.totalTokens,
    }))
    .sort((left, right) => {
      if (left.totalCostUsd !== right.totalCostUsd) return right.totalCostUsd - left.totalCostUsd;
      if (left.runCount !== right.runCount) return right.runCount - left.runCount;
      return compareStringsAscending(left.adapterType, right.adapterType);
    });

  return {
    totalRuns,
    freeTierRuns,
    paidRuns: totalRuns - freeTierRuns,
    totalCostUsd: roundUsd(totalCostUsd),
    totalTokens,
    byAdapter,
  };
}

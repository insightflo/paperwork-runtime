export interface ConcurrencyOpsSnapshotInput {
  companyId: string;
  capturedAtIso: string;
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  jainFairnessIndex: number;
  sloBreachedLanes: readonly string[];
  deadlockCount: number;
  coolingDownProviders: readonly string[];
}

export interface ConcurrencyOpsSnapshot {
  companyId: string;
  capturedAtIso: string;
  utilizationPercent: number;
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  jainFairnessIndex: number;
  sloBreachedLanes: string[];
  deadlockCount: number;
  coolingDownProviders: string[];
  attentionRequired: boolean;
  summaryLine: string;
}

function clampNonNegative(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, value);
}

function clampUnitInterval(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function buildConcurrencyOpsSnapshot(
  input: ConcurrencyOpsSnapshotInput,
): ConcurrencyOpsSnapshot {
  const totalSlots = clampNonNegative(input.totalSlots);
  const totalRunning = clampNonNegative(input.totalRunning);
  const totalQueued = clampNonNegative(input.totalQueued);
  const deadlockCount = clampNonNegative(input.deadlockCount);
  const jainFairnessIndex = clampUnitInterval(input.jainFairnessIndex);
  const sloBreachedLanes = sortedUnique(input.sloBreachedLanes);
  const coolingDownProviders = sortedUnique(input.coolingDownProviders);
  const utilizationPercent = totalSlots > 0
    ? Math.min(100, Math.round((totalRunning / totalSlots) * 100))
    : 0;
  const attentionRequired = deadlockCount > 0
    || sloBreachedLanes.length > 0
    || coolingDownProviders.length > 0
    || jainFairnessIndex < 0.5;
  const statusText = attentionRequired ? "점검 필요" : "정상";

  return {
    companyId: input.companyId,
    capturedAtIso: input.capturedAtIso,
    utilizationPercent,
    totalSlots,
    totalRunning,
    totalQueued,
    jainFairnessIndex,
    sloBreachedLanes,
    deadlockCount,
    coolingDownProviders,
    attentionRequired,
    summaryLine: `슬롯 ${totalRunning}/${totalSlots} (${utilizationPercent}%) · 대기 ${totalQueued}건 · ${statusText}`,
  };
}

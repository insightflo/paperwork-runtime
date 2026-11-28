export interface QueueWaitSample {
  lane: "interactive" | "recovery" | "workflow" | "scheduled";
  waitMs: number;
}

export interface LaneWaitSloReport {
  lane: QueueWaitSample["lane"];
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  sloTargetMs: number;
  breached: boolean;
}

export const DEFAULT_LANE_WAIT_SLO_MS: Record<QueueWaitSample["lane"], number> = {
  interactive: 30_000,
  recovery: 60_000,
  workflow: 180_000,
  scheduled: 600_000,
};

const LANE_ORDER: readonly QueueWaitSample["lane"][] = [
  "interactive",
  "recovery",
  "workflow",
  "scheduled",
];

export function computeNearestRankPercentile(
  sortedAsc: readonly number[],
  p: number,
): number {
  if (sortedAsc.length === 0) return 0;

  const clampedP = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clampedP / 100) * sortedAsc.length);
  const index = Math.max(0, rank - 1);
  return sortedAsc[index] ?? 0;
}

export function evaluateQueueWaitSlo(
  samples: readonly QueueWaitSample[],
  customTargets?: Partial<Record<QueueWaitSample["lane"], number>>,
): LaneWaitSloReport[] {
  const waitsByLane: Record<QueueWaitSample["lane"], number[]> = {
    interactive: [],
    recovery: [],
    workflow: [],
    scheduled: [],
  };

  for (const sample of samples) {
    waitsByLane[sample.lane].push(Math.max(0, sample.waitMs));
  }

  return LANE_ORDER.map((lane) => {
    const waits = [...waitsByLane[lane]].sort((a, b) => a - b);
    const count = waits.length;
    const p50Ms = computeNearestRankPercentile(waits, 50);
    const p95Ms = computeNearestRankPercentile(waits, 95);
    const p99Ms = computeNearestRankPercentile(waits, 99);
    const maxMs = count === 0 ? 0 : waits[count - 1] ?? 0;
    const sloTargetMs = customTargets?.[lane] ?? DEFAULT_LANE_WAIT_SLO_MS[lane];

    return {
      lane,
      count,
      p50Ms,
      p95Ms,
      p99Ms,
      maxMs,
      sloTargetMs,
      breached: count > 0 && p95Ms > sloTargetMs,
    };
  });
}

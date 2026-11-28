export type PreemptionLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface RunningSlotCandidate {
  runId: string;
  lane: PreemptionLane;
  startedAtMs: number;
  inCriticalSection?: boolean;
  alreadyYieldRequested?: boolean;
}

export interface PreemptionPlanResult {
  shouldPreempt: boolean;
  targetRunId: string | null;
  reason: string;
}

const DEFAULT_MIN_AGE_FOR_PREEMPTION_MS = 15_000;

function noPreemption(reason: string): PreemptionPlanResult {
  return { shouldPreempt: false, targetRunId: null, reason };
}

export function planCooperativePreemption(input: {
  incomingLane: PreemptionLane;
  running: readonly RunningSlotCandidate[];
  maxSlots: number;
  nowMs: number;
  minAgeForPreemptionMs?: number;
}): PreemptionPlanResult {
  const slotLimit = Math.max(1, input.maxSlots);
  if (input.running.length < slotLimit) {
    return noPreemption("Free slot available");
  }

  if (input.incomingLane !== "interactive") {
    return noPreemption("Incoming lane is not interactive");
  }

  const minAgeForPreemptionMs = input.minAgeForPreemptionMs ?? DEFAULT_MIN_AGE_FOR_PREEMPTION_MS;
  let target: RunningSlotCandidate | null = null;

  for (const candidate of input.running) {
    if (candidate.lane !== "scheduled") continue;
    if (candidate.inCriticalSection || candidate.alreadyYieldRequested) continue;
    if (input.nowMs - candidate.startedAtMs < minAgeForPreemptionMs) continue;

    if (
      target === null
      || candidate.startedAtMs > target.startedAtMs
      || (candidate.startedAtMs === target.startedAtMs && candidate.runId < target.runId)
    ) {
      target = candidate;
    }
  }

  if (target === null) {
    return noPreemption("No eligible scheduled run available");
  }

  return {
    shouldPreempt: true,
    targetRunId: target.runId,
    reason: "Selected youngest eligible scheduled run",
  };
}

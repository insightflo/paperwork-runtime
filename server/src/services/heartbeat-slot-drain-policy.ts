export interface SlotRebalanceInput {
  maxConcurrentRuns: number;
  runningRunIds: readonly string[];
  queuedRunIds: readonly string[];
  draining?: boolean;
}

export interface SlotRebalanceDecision {
  effectiveMaxSlots: number;
  inFlightCount: number;
  overCapacityCount: number;
  admitCount: number;
  runIdsToAdmit: string[];
  mode: "admit" | "at_capacity" | "draining_excess" | "paused_drain";
}

export function evaluateSlotRebalance(input: SlotRebalanceInput): SlotRebalanceDecision {
  const effectiveMaxSlots = Math.max(1, Math.floor(input.maxConcurrentRuns || 1));
  const inFlightCount = input.runningRunIds.length;
  const overCapacityCount = Math.max(0, inFlightCount - effectiveMaxSlots);

  if (input.draining === true) {
    return {
      effectiveMaxSlots,
      inFlightCount,
      overCapacityCount,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "paused_drain",
    };
  }

  if (inFlightCount > effectiveMaxSlots) {
    return {
      effectiveMaxSlots,
      inFlightCount,
      overCapacityCount,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "draining_excess",
    };
  }

  if (inFlightCount === effectiveMaxSlots) {
    return {
      effectiveMaxSlots,
      inFlightCount,
      overCapacityCount: 0,
      admitCount: 0,
      runIdsToAdmit: [],
      mode: "at_capacity",
    };
  }

  const admitCount = Math.min(effectiveMaxSlots - inFlightCount, input.queuedRunIds.length);

  return {
    effectiveMaxSlots,
    inFlightCount,
    overCapacityCount: 0,
    admitCount,
    runIdsToAdmit: input.queuedRunIds.slice(0, admitCount),
    mode: "admit",
  };
}

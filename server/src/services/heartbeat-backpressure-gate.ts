export type BackpressureLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface BackpressureInput {
  lane: BackpressureLane;
  currentQueuedCount: number;
  maxSlots: number;
  scheduledHighWaterMultiplier?: number;
  workflowHighWaterMultiplier?: number;
}

export interface BackpressureDecision {
  admit: boolean;
  reason:
    | "ok"
    | "always_admit_priority_lane"
    | "scheduled_backpressure_shed"
    | "workflow_backpressure_shed";
  highWaterMark: number;
}

const DEFAULT_SCHEDULED_HIGH_WATER_MULTIPLIER = 4;
const DEFAULT_WORKFLOW_HIGH_WATER_MULTIPLIER = 8;

export function evaluateQueueBackpressure(input: BackpressureInput): BackpressureDecision {
  if (input.lane === "interactive" || input.lane === "recovery") {
    return {
      admit: true,
      reason: "always_admit_priority_lane",
      highWaterMark: Infinity,
    };
  }

  const safeSlots = Math.max(1, Math.floor(input.maxSlots || 1));

  if (input.lane === "scheduled") {
    const highWaterMark =
      safeSlots * (input.scheduledHighWaterMultiplier ?? DEFAULT_SCHEDULED_HIGH_WATER_MULTIPLIER);

    if (input.currentQueuedCount >= highWaterMark) {
      return {
        admit: false,
        reason: "scheduled_backpressure_shed",
        highWaterMark,
      };
    }

    return { admit: true, reason: "ok", highWaterMark };
  }

  const highWaterMark =
    safeSlots * (input.workflowHighWaterMultiplier ?? DEFAULT_WORKFLOW_HIGH_WATER_MULTIPLIER);

  if (input.currentQueuedCount >= highWaterMark) {
    return {
      admit: false,
      reason: "workflow_backpressure_shed",
      highWaterMark,
    };
  }

  return { admit: true, reason: "ok", highWaterMark };
}

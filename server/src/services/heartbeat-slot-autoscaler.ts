export interface SlotAutoscaleInput {
  currentSlots: number;
  runningCount: number;
  queuedCount: number;
  burnThrottleActive?: boolean;
  providerCoolingDown?: boolean;
  minSlots?: number;
  maxSlots?: number;
}

export type SlotAutoscaleAction = "scale_up" | "scale_down" | "hold";

export interface SlotAutoscaleDecision {
  action: SlotAutoscaleAction;
  targetSlots: number;
  delta: number;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decision(
  action: SlotAutoscaleAction,
  currentSlots: number,
  targetSlots: number,
  reason: string,
): SlotAutoscaleDecision {
  return {
    action,
    targetSlots,
    delta: action === "hold" ? 0 : targetSlots - currentSlots,
    reason,
  };
}

export function evaluateSlotAutoscale(input: SlotAutoscaleInput): SlotAutoscaleDecision {
  const minSlots = input.minSlots ?? 1;
  const maxSlots = input.maxSlots ?? 10;
  const currentSlots = clamp(input.currentSlots, minSlots, maxSlots);
  const constrained = input.burnThrottleActive === true || input.providerCoolingDown === true;

  if (constrained) {
    if (currentSlots > minSlots) {
      return decision(
        "scale_down",
        currentSlots,
        minSlots,
        "burn throttle or provider cooldown active",
      );
    }
    return decision(
      "hold",
      currentSlots,
      currentSlots,
      "burn throttle or provider cooldown active; already at minimum slots",
    );
  }

  if (input.queuedCount >= currentSlots && currentSlots < maxSlots) {
    const increment = Math.max(1, Math.min(2, Math.ceil(input.queuedCount / 2)));
    return decision(
      "scale_up",
      currentSlots,
      Math.min(maxSlots, currentSlots + increment),
      "queue pressure meets or exceeds current slots",
    );
  }

  if (
    input.queuedCount === 0 &&
    input.runningCount < Math.floor(currentSlots / 2) &&
    currentSlots > minSlots
  ) {
    return decision(
      "scale_down",
      currentSlots,
      Math.max(minSlots, currentSlots - 1),
      "queue empty and running count below half of current slots",
    );
  }

  return decision("hold", currentSlots, currentSlots, "slot count is steady");
}

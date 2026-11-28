export interface AgentQueuePressureInput {
  agentId: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  oldestQueuedWaitMs: number;
  providerCoolingDown?: boolean;
}

export type RemediationActionKind =
  | "none"
  | "provider_cooldown_wait"
  | "promote_aged_run"
  | "recommend_slot_increase";

export interface QueueRemediationRecommendation {
  agentId: string;
  action: RemediationActionKind;
  suggestedSlots?: number;
  reason: string;
}

const DEFAULT_STARVATION_THRESHOLD_MS = 600_000;
const DEFAULT_MAX_RECOMMENDED_SLOTS = 10;

export function evaluateQueueRemediation(
  input: AgentQueuePressureInput,
  opts: { starvationThresholdMs?: number; maxRecommendedSlots?: number } = {},
): QueueRemediationRecommendation {
  const starvationThresholdMs = opts.starvationThresholdMs ?? DEFAULT_STARVATION_THRESHOLD_MS;
  const maxRecommendedSlots = opts.maxRecommendedSlots ?? DEFAULT_MAX_RECOMMENDED_SLOTS;
  const { agentId } = input;

  if (input.queuedCount <= 0) {
    return { agentId, action: "none", reason: "No queued runs" };
  }

  if (input.providerCoolingDown === true) {
    return {
      agentId,
      action: "provider_cooldown_wait",
      reason: "Provider cooldown active; waiting before dispatch",
    };
  }

  const isStarving = input.oldestQueuedWaitMs >= starvationThresholdMs;
  const isSaturated = input.runningCount >= Math.max(1, input.maxConcurrentRuns);

  if (isStarving && isSaturated) {
    if (input.maxConcurrentRuns < maxRecommendedSlots) {
      const suggestedSlots = Math.min(
        maxRecommendedSlots,
        Math.max(2, input.maxConcurrentRuns * 2),
      );
      return {
        agentId,
        action: "recommend_slot_increase",
        suggestedSlots,
        reason: `Oldest queued run waited ${input.oldestQueuedWaitMs}ms while all ${input.maxConcurrentRuns} slots are occupied; increase capacity to ${suggestedSlots} slots`,
      };
    }

    return {
      agentId,
      action: "promote_aged_run",
      reason: `Oldest queued run waited ${input.oldestQueuedWaitMs}ms and slots are already at the ${maxRecommendedSlots}-slot recommendation cap; promote the aged run`,
    };
  }

  if (isStarving) {
    return {
      agentId,
      action: "promote_aged_run",
      reason: `Oldest queued run waited ${input.oldestQueuedWaitMs}ms; promote the aged run`,
    };
  }

  return { agentId, action: "none", reason: "Queue within healthy wait bounds" };
}

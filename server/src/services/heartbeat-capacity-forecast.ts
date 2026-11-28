export interface QueueDrainForecastInput {
  queuedCount: number;
  runningCount: number;
  currentSlots: number;
  avgRunDurationMs: number;
  maxSlotCap?: number;
}

export interface QueueDrainForecastResult {
  currentSlots: number;
  estimatedDrainMs: number;
  suggestedSlots: number;
  suggestedDrainMs: number;
  speedupRatio: number;
}

function clampFinite(value: number, minimum: number) {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

function drainMs(workCount: number, slots: number, avgRunDurationMs: number) {
  const waves = Math.ceil(workCount / slots);
  return waves * avgRunDurationMs;
}

export function forecastQueueDrain(input: QueueDrainForecastInput): QueueDrainForecastResult {
  const currentSlots = clampFinite(input.currentSlots, 1);
  const queuedCount = clampFinite(input.queuedCount, 0);
  const runningCount = clampFinite(input.runningCount, 0);
  const avgRunDurationMs = clampFinite(input.avgRunDurationMs, 1_000);
  const maxSlotCap = clampFinite(input.maxSlotCap ?? 10, 1);

  if (queuedCount === 0) {
    return {
      currentSlots,
      estimatedDrainMs: 0,
      suggestedSlots: currentSlots,
      suggestedDrainMs: 0,
      speedupRatio: 1,
    };
  }

  const workCount = queuedCount + runningCount;
  const estimatedDrainMs = drainMs(workCount, currentSlots, avgRunDurationMs);
  const suggestedSlots = Math.min(
    maxSlotCap,
    Math.max(currentSlots, Math.min(workCount, currentSlots * 2)),
  );
  const suggestedDrainMs = drainMs(workCount, suggestedSlots, avgRunDurationMs);
  const speedupRatio = suggestedDrainMs > 0
    ? Math.round((estimatedDrainMs / suggestedDrainMs) * 100) / 100
    : 1;

  return {
    currentSlots,
    estimatedDrainMs,
    suggestedSlots,
    suggestedDrainMs,
    speedupRatio,
  };
}

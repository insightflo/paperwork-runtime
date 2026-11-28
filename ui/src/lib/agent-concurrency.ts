export const MAX_CONCURRENT_RUNS_MIN = 1;
export const MAX_CONCURRENT_RUNS_MAX = 10;

/** Parse a UI/runtime concurrency value into the persisted 1..10 slot contract. */
export function clampMaxConcurrentRuns(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return MAX_CONCURRENT_RUNS_MIN;
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  const parsed = Math.floor(numeric);
  if (!Number.isFinite(parsed)) return MAX_CONCURRENT_RUNS_MIN;
  return Math.min(MAX_CONCURRENT_RUNS_MAX, Math.max(MAX_CONCURRENT_RUNS_MIN, parsed));
}

/** Return a new heartbeat object so sibling runtimeConfig.heartbeat keys are never dropped. */
export function heartbeatWithClampedMaxConcurrentRuns(
  heartbeat: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  return {
    ...heartbeat,
    maxConcurrentRuns: clampMaxConcurrentRuns(value),
  };
}

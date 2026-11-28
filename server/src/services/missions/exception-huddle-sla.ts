import {
  EXCEPTION_HUDDLE_TIMEOUT_MS,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";

export interface ExceptionHuddleSlaSnapshot {
  elapsedMs: number;
  remainingBudgetMs: number;
  isBreached: boolean;
  urgencyLevel: "normal" | "warning" | "critical" | "settled";
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeMs(endMs: number | null, startMs: number | null): number {
  if (endMs === null || startMs === null) return 0;
  return Math.max(0, endMs - startMs);
}

export function computeExceptionHuddleSla(
  huddle: ExceptionHuddleMetadata,
  now: Date = new Date(),
): ExceptionHuddleSlaSnapshot {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid huddle SLA time");
  const timeoutAtMs = parseTime(huddle.timeoutAt);
  const decidedAtMs = parseTime(huddle.decidedAt);
  const openedAtMs = timeoutAtMs === null ? null : timeoutAtMs - EXCEPTION_HUDDLE_TIMEOUT_MS;
  const elapsedEndMs = huddle.status === "decided" && decidedAtMs !== null && openedAtMs !== null
    ? decidedAtMs
    : nowMs;
  const elapsedMs = nonNegativeMs(elapsedEndMs, openedAtMs);
  const remainingBudgetMs = huddle.status === "open" && timeoutAtMs !== null
    ? Math.max(0, timeoutAtMs - nowMs)
    : 0;
  const isBreached = huddle.status === "timed_out"
    || (huddle.status === "open" && timeoutAtMs !== null && nowMs >= timeoutAtMs)
    || (huddle.status === "decided" && decidedAtMs !== null && timeoutAtMs !== null && decidedAtMs > timeoutAtMs);

  let urgencyLevel: ExceptionHuddleSlaSnapshot["urgencyLevel"] = "normal";
  if (huddle.status === "decided" || huddle.status === "cancelled") {
    urgencyLevel = "settled";
  } else if (huddle.status === "timed_out" || remainingBudgetMs <= 60_000) {
    urgencyLevel = "critical";
  } else if (remainingBudgetMs <= 120_000) {
    urgencyLevel = "warning";
  }

  return { elapsedMs, remainingBudgetMs, isBreached, urgencyLevel };
}

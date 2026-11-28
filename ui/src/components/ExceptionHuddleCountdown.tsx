import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const CRITICAL_THRESHOLD_MS = 60_000;
const WARNING_THRESHOLD_MS = 120_000;

type HuddleCountdownUrgency = "normal" | "warning" | "critical";

export interface ExceptionHuddleCountdownProps {
  timeoutAt: string;
  status: "open" | "timed_out" | "decided" | "cancelled";
  nowMs?: number;
  className?: string;
}

export function formatHuddleRemainingMs(remainingMs: number): string {
  const clampedMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  const totalSeconds = Math.floor(clampedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function urgencyClass(urgency: HuddleCountdownUrgency): string {
  if (urgency === "critical") {
    return "critical border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-400/35 dark:bg-red-500/12 dark:text-red-300";
  }
  if (urgency === "warning") {
    return "warning border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]";
  }
  return "normal border-blue-600/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]";
}

export function ExceptionHuddleCountdown({
  timeoutAt,
  status,
  nowMs,
  className,
}: ExceptionHuddleCountdownProps) {
  const shouldTick = nowMs === undefined && status === "open";
  const [liveNowMs, setLiveNowMs] = useState(() => nowMs ?? Date.now());

  useEffect(() => {
    if (!shouldTick) return;
    const tick = () => setLiveNowMs(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [shouldTick]);

  if (status === "decided" || status === "cancelled") return null;

  const effectiveNowMs = nowMs ?? liveNowMs;
  const timeoutMs = Date.parse(timeoutAt);
  const remainingMs = Number.isFinite(timeoutMs) && Number.isFinite(effectiveNowMs) ? timeoutMs - effectiveNowMs : 0;
  const isTimedOut = status === "timed_out" || remainingMs <= 0;
  const formattedRemaining = isTimedOut ? "0:00" : formatHuddleRemainingMs(remainingMs);
  const urgency: HuddleCountdownUrgency = isTimedOut || remainingMs <= CRITICAL_THRESHOLD_MS
    ? "critical"
    : remainingMs <= WARNING_THRESHOLD_MS
      ? "warning"
      : "normal";

  return (
    <Badge
      variant="outline"
      role="timer"
      aria-label={isTimedOut ? "Huddle timed out" : `Huddle time remaining ${formattedRemaining}`}
      className={cn("px-2 py-1 font-mono text-[11px] font-semibold tabular-nums", urgencyClass(urgency), className)}
    >
      {isTimedOut ? "0:00 · Timeout" : formattedRemaining}
    </Badge>
  );
}

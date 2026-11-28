import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ExceptionHuddleSlaUrgency = "normal" | "warning" | "critical" | "settled";

export interface ExceptionHuddleSlaIndicatorProps {
  urgencyLevel: ExceptionHuddleSlaUrgency;
  isBreached: boolean;
  elapsedMs: number;
  remainingBudgetMs: number;
  className?: string;
}

const URGENCY_LABEL: Record<ExceptionHuddleSlaUrgency, string> = {
  normal: "정상",
  warning: "주의",
  critical: "긴급",
  settled: "완료",
};

const URGENCY_CLASS: Record<ExceptionHuddleSlaUrgency, string> = {
  normal: "border-blue-600/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]",
  warning: "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]",
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200",
  settled: "border-lime-600/30 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]",
};

export function formatDurationShort(ms: number): string {
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const totalSeconds = Math.max(0, Math.floor(safeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function ExceptionHuddleSlaIndicator({
  urgencyLevel,
  isBreached,
  elapsedMs,
  remainingBudgetMs,
  className,
}: ExceptionHuddleSlaIndicatorProps) {
  const isSettled = urgencyLevel === "settled";
  const duration = formatDurationShort(isSettled ? elapsedMs : remainingBudgetMs);
  const timingText = isSettled ? `소요 ${duration}` : `남은 시간 ${duration}`;
  const englishTimingText = isSettled ? `elapsed time ${duration}` : `remaining budget ${duration}`;
  const ariaLabel = [
    `Exception huddle SLA: ${URGENCY_LABEL[urgencyLevel]} (${urgencyLevel})`,
    isBreached ? "SLA breached (SLA 초과)" : null,
    `${englishTimingText} (${timingText})`,
  ].filter((part): part is string => part !== null).join("; ");

  return (
    <Badge
      variant="outline"
      role="status"
      aria-label={ariaLabel}
      data-urgency-level={urgencyLevel}
      className={cn(
        "gap-1.5 px-2.5 py-1 font-mono text-[11px] font-semibold normal-case tracking-wide tabular-nums",
        URGENCY_CLASS[urgencyLevel],
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span>{URGENCY_LABEL[urgencyLevel]}</span>
      {isBreached ? <span className="font-bold">SLA 초과</span> : null}
      <span className="opacity-90">{timingText}</span>
    </Badge>
  );
}

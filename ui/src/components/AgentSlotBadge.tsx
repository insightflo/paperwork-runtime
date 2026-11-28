import { cn } from "@/lib/utils";

export interface AgentSlotBadgeProps {
  runningCount: number;
  maxConcurrentRuns: number;
  queuedCount?: number;
  starving?: boolean;
  className?: string;
}

type SlotUtilizationTone = "idle" | "active" | "saturated" | "starving";

export function getSlotUtilizationTone(
  runningCount: number,
  maxConcurrentRuns: number,
  starving?: boolean,
): SlotUtilizationTone {
  if (starving) return "starving";
  if (runningCount <= 0) return "idle";
  if (runningCount >= Math.max(1, maxConcurrentRuns)) return "saturated";
  return "active";
}

const TONE_CLASSES: Record<SlotUtilizationTone, string> = {
  idle: "border-[var(--pw-token-border-strong)] bg-[var(--pw-token-bg-surface-raised)] text-[var(--pw-token-text-muted)]",
  active: "border-[var(--pw-token-success)] bg-[var(--pw-token-success-soft)] text-[var(--pw-token-success-text)]",
  saturated: "border-[var(--pw-token-warning)] bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
  starving: "border-[var(--pw-token-danger)] bg-[var(--pw-token-danger-soft)] text-[var(--pw-token-danger-text)]",
};

export function AgentSlotBadge({
  runningCount,
  maxConcurrentRuns,
  queuedCount = 0,
  starving,
  className,
}: AgentSlotBadgeProps) {
  const safeMax = Math.max(1, maxConcurrentRuns);
  const tone = getSlotUtilizationTone(runningCount, maxConcurrentRuns, starving);
  const ariaLabel = `실행 슬롯 ${runningCount}/${safeMax}, 대기 ${queuedCount}건`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold leading-4 tabular-nums",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span>
        슬롯 {runningCount}/{safeMax}
      </span>
      {queuedCount > 0 && <span>+대기 {queuedCount}</span>}
    </span>
  );
}

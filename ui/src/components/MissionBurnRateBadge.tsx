import { cn } from "@/lib/utils";

export type BurnRateVerdict = "normal" | "elevated" | "critical_throttle" | "budget_exhausted";

export interface MissionBurnRateBadgeProps {
  verdict: BurnRateVerdict;
  utilizationPercent: number;
  burnUsdPerHour: number;
  projectedRunwayMinutes?: number | null;
  className?: string;
}

const VERDICT_LABELS: Record<BurnRateVerdict, string> = {
  normal: "예산 정상",
  elevated: "소진 주의",
  critical_throttle: "스로틀 권고",
  budget_exhausted: "예산 소진",
};

const VERDICT_TONES: Record<BurnRateVerdict, { badge: string; dot: string }> = {
  normal: {
    badge: "border-[var(--pw-lime)] bg-[var(--pw-lime-soft)] text-[var(--pw-emerald)]",
    dot: "bg-[var(--pw-lime)]",
  },
  elevated: {
    badge: "border-[var(--pw-amber)] bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]",
    dot: "bg-[var(--pw-amber)]",
  },
  critical_throttle: {
    badge: "border-[var(--pw-crimson)] bg-[var(--pw-crimson-soft)] text-[var(--pw-crimson)]",
    dot: "bg-[var(--pw-crimson)]",
  },
  budget_exhausted: {
    badge: "border-destructive bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
};

export function formatBurnRateVerdictLabel(verdict: BurnRateVerdict): string {
  return VERDICT_LABELS[verdict];
}

function clampUtilizationPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatBurnUsdPerHour(value: number): string {
  return `$${value.toFixed(2)}`;
}

function isAlertVerdict(verdict: BurnRateVerdict): boolean {
  return verdict === "critical_throttle" || verdict === "budget_exhausted";
}

export function MissionBurnRateBadge({
  verdict,
  utilizationPercent,
  burnUsdPerHour,
  projectedRunwayMinutes,
  className,
}: MissionBurnRateBadgeProps) {
  const label = formatBurnRateVerdictLabel(verdict);
  const utilizationText = `${clampUtilizationPercent(utilizationPercent)}%`;
  const burnText = formatBurnUsdPerHour(burnUsdPerHour);
  const hasRunway = projectedRunwayMinutes !== null && projectedRunwayMinutes !== undefined;
  const runwayText = hasRunway ? `잔여 ${projectedRunwayMinutes}분` : null;
  const ariaLabel = [
    `미션 예산 소진 상태: ${label}`,
    `사용률 ${utilizationText}`,
    `시간당 ${burnText}`,
    runwayText ? `예상 ${runwayText}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span
      role={isAlertVerdict(verdict) ? "alert" : "status"}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap tabular-nums shadow-xs",
        VERDICT_TONES[verdict].badge,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("inline-block size-1.5 rounded-full", VERDICT_TONES[verdict].dot)}
      />
      <span>{label}</span>
      <span>{utilizationText}</span>
      <span className="font-medium">{burnText}/h</span>
      {runwayText ? <span className="font-medium">{runwayText}</span> : null}
    </span>
  );
}

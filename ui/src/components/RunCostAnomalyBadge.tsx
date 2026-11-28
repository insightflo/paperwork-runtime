import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RunCostAnomalyBadgeProps {
  isAnomaly: boolean;
  ratioToMedian: number;
  baselineMedianUsd: number;
  currentCostUsd: number;
  className?: string;
}

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "측정 불가";
  return USD_FORMATTER.format(value);
}

export function formatCostAnomalyRatio(ratioToMedian: number): string {
  if (!Number.isFinite(ratioToMedian)) return "신규 고비용";
  return `${ratioToMedian.toFixed(1)}x`;
}

export function RunCostAnomalyBadge({
  isAnomaly,
  ratioToMedian,
  baselineMedianUsd,
  currentCostUsd,
  className,
}: RunCostAnomalyBadgeProps) {
  if (!isAnomaly) return null;

  const ratioLabel = formatCostAnomalyRatio(ratioToMedian);
  const ariaLabel = `비용 급증: 현재 비용 ${formatUsd(currentCostUsd)}, 기준 중앙값 ${formatUsd(baselineMedianUsd)}, 비율 ${ratioLabel}`;

  return (
    <span
      role="alert"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 whitespace-nowrap",
        "border-[var(--pw-token-warning)] bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
        className,
      )}
    >
      <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
      <span className="tabular-nums">비용 급증 {ratioLabel}</span>
    </span>
  );
}

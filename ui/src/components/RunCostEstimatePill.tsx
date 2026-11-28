import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface RunCostEstimatePillProps {
  costUsd: number | null | undefined;
  freeTier?: boolean;
  model?: string;
  className?: string;
}

export function formatEstimatedCostLabel(
  costUsd: number | null | undefined,
  freeTier?: boolean,
): string {
  if (freeTier === true) return "무료 티어 ($0)";
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return "비용 미집계";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

export function RunCostEstimatePill({
  costUsd,
  freeTier,
  model,
  className,
}: RunCostEstimatePillProps) {
  const costLabel = formatEstimatedCostLabel(costUsd, freeTier);
  const ariaLabel = `예상 실행 비용: ${costLabel}${model ? `, 모델: ${model}` : ""}`;

  return (
    <Badge
      variant="outline"
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "gap-1.5 bg-muted/60 px-2.5 py-1 text-[11px] font-medium leading-4 text-muted-foreground tabular-nums",
        className,
      )}
    >
      <span>예상 비용</span>
      <span className="font-semibold text-foreground">{costLabel}</span>
    </Badge>
  );
}

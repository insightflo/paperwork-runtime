export type SlotAutoscaleAction = "scale_up" | "scale_down" | "hold";

export interface SlotAutoscaleRecommendationView {
  action: SlotAutoscaleAction;
  currentSlots: number;
  targetSlots: number;
  delta: number;
  reason: string;
}

export function formatAutoscaleActionLabel(action: SlotAutoscaleAction): string {
  switch (action) {
    case "scale_up":
      return "슬롯 증설 권장";
    case "scale_down":
      return "슬롯 축소 권장";
    case "hold":
      return "현재 슬롯 유지";
  }
}

const ACTION_TONE_CLASS: Record<SlotAutoscaleAction, string> = {
  scale_up: "border-primary/30 bg-primary/10 text-primary",
  scale_down: "border-destructive/30 bg-destructive/10 text-destructive",
  hold: "border-border bg-muted text-muted-foreground",
};

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export function SlotAutoscaleCard({
  recommendation,
  onApplyTargetSlots,
}: {
  recommendation: SlotAutoscaleRecommendationView | null | undefined;
  onApplyTargetSlots?: (targetSlots: number) => void;
}) {
  if (!recommendation) return null;

  const canApply = recommendation.action !== "hold" && typeof onApplyTargetSlots === "function";
  const handleApply = () => {
    if (onApplyTargetSlots) onApplyTargetSlots(recommendation.targetSlots);
  };

  return (
    <section
      role="region"
      aria-label="슬롯 자동 조정 권고"
      data-testid="slot-autoscale-card"
      className="tactile-card w-full max-w-sm rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold ${ACTION_TONE_CLASS[recommendation.action]}`}
        >
          {formatAutoscaleActionLabel(recommendation.action)}
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {recommendation.currentSlots} → {recommendation.targetSlots}
        </span>
      </div>

      <p className="mt-2 text-sm leading-5 text-muted-foreground">{recommendation.reason}</p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          조정 폭{" "}
          <span className="font-mono font-medium tabular-nums text-foreground">
            {formatDelta(recommendation.delta)}
          </span>
        </span>
        {canApply ? (
          <button
            type="button"
            onClick={handleApply}
            className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            목표 슬롯 적용
          </button>
        ) : null}
      </div>
    </section>
  );
}

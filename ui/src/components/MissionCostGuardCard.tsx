export interface MissionCostGuardView {
  missionTitle: string;
  spentUsd: number;
  budgetUsd: number;
  utilizationPercent: number;
  burnUsdPerHour: number;
  projectedRunwayMinutes: number | null;
  shouldThrottleSlots: boolean;
  reason: string;
}

interface MissionCostGuardCardProps {
  view: MissionCostGuardView | null | undefined;
  onThrottleMission?: () => void;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

function formatRunwayMinutes(value: number): number {
  return Math.max(0, Math.round(value));
}

export function MissionCostGuardCard({ view, onThrottleMission }: MissionCostGuardCardProps) {
  if (!view) return null;

  const shouldThrottle = view.shouldThrottleSlots;
  const runwayMinutes = view.projectedRunwayMinutes === null ? null : formatRunwayMinutes(view.projectedRunwayMinutes);
  const cardTone = shouldThrottle
    ? "border-destructive/40 bg-destructive/10"
    : "border-border bg-card";
  const badgeTone = shouldThrottle
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-border bg-muted text-muted-foreground";

  return (
    <section
      role={shouldThrottle ? "alert" : "region"}
      aria-label={`${view.missionTitle} 예산 가드`}
      data-testid="mission-cost-guard-card"
      className={`rounded-xl border p-3 text-card-foreground shadow-sm tabular-nums ${cardTone}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground">미션 비용 가드</p>
          <h3 className="mt-1 truncate text-sm font-semibold text-foreground">{view.missionTitle}</h3>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeTone}`}>
          {shouldThrottle ? "슬롯 제한 필요" : "정상 범위"}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
          <dt className="text-muted-foreground">사용 / 예산</dt>
          <dd className="mt-1 font-mono text-sm font-semibold text-foreground">
            {formatUsd(view.spentUsd)} / {formatUsd(view.budgetUsd)}
          </dd>
        </div>
        <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
          <dt className="text-muted-foreground">예산 사용률</dt>
          <dd className="mt-1 font-mono text-sm font-semibold text-foreground">
            {percentFormatter.format(view.utilizationPercent)}%
          </dd>
        </div>
        <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
          <dt className="text-muted-foreground">시간당 소진</dt>
          <dd className="mt-1 font-mono text-sm font-semibold text-foreground">
            {formatUsd(view.burnUsdPerHour)}/시간
          </dd>
        </div>
        {runwayMinutes !== null ? (
          <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
            <dt className="text-muted-foreground">예상 잔여 시간</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground">잔여 {runwayMinutes}분</dd>
          </div>
        ) : null}
      </dl>

      <p className="mt-3 rounded-lg border border-border/70 bg-background/70 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">사유</span> {view.reason}
      </p>

      {shouldThrottle && onThrottleMission ? (
        <button
          type="button"
          onClick={onThrottleMission}
          className="mt-3 inline-flex h-8 w-full items-center justify-center rounded-md bg-destructive px-3 text-xs font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          슬롯 제한 적용
        </button>
      ) : null}
    </section>
  );
}

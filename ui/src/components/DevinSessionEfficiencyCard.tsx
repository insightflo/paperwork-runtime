export interface DevinSessionMetricsView {
  totalRuns: number;
  successRatePercent: number;
  resumeHitRatePercent: number;
  freshRetryCount: number;
  freeTierRunSharePercent: number;
  avgDurationMs: number;
  totalTokens: number;
}

interface DevinSessionEfficiencyCardProps {
  metrics: DevinSessionMetricsView | null | undefined;
}

const METRIC_ITEM_CLASS =
  "rounded-lg border border-border/70 bg-background/70 px-2.5 py-2 text-xs font-medium text-foreground tabular-nums";

export function DevinSessionEfficiencyCard({ metrics }: DevinSessionEfficiencyCardProps) {
  if (!metrics || metrics.totalRuns <= 0) return null;

  const averageDurationSeconds = Math.round(metrics.avgDurationMs / 1000);
  const items = [
    { key: "total-runs", text: `총 실행 ${metrics.totalRuns}건` },
    { key: "success-rate", text: `성공률 ${metrics.successRatePercent}%` },
    { key: "resume-hit-rate", text: `세션 재개율 ${metrics.resumeHitRatePercent}%` },
    { key: "free-tier-share", text: `무료 티어 비중 ${metrics.freeTierRunSharePercent}%` },
    { key: "average-duration", text: `평균 소요 ${averageDurationSeconds}초` },
  ] as const;

  return (
    <section
      role="region"
      aria-label="Devin 세션 효율 요약"
      data-testid="devin-session-efficiency-card"
      className="rounded-xl border border-border bg-card p-3 text-card-foreground shadow-sm tabular-nums"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground">devin_local</p>
          <h3 className="mt-1 truncate text-sm font-semibold text-foreground">Devin 세션 효율</h3>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          실행 요약
        </span>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-2">
        {items.map((item) => (
          <li key={item.key} className={METRIC_ITEM_CLASS}>
            {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface LaneWaitSloRow {
  lane: "interactive" | "recovery" | "workflow" | "scheduled";
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  sloTargetMs: number;
  breached: boolean;
}

const LANE_LABELS: Record<LaneWaitSloRow["lane"], string> = {
  interactive: "대화형",
  recovery: "복구",
  workflow: "워크플로",
  scheduled: "예약",
};

export function formatQueueLaneLabel(lane: LaneWaitSloRow["lane"]): string {
  return LANE_LABELS[lane];
}

export function formatLatencyMs(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safeMs < 1_000) return "<1초";

  const totalSeconds = Math.floor(safeMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}초`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
}

function LatencyMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-[4.25rem] flex-col text-right tabular-nums">
      <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-semibold text-card-foreground">{value}</span>
    </span>
  );
}

function SloStatusBadge({ breached }: { breached: boolean }) {
  const label = breached ? "SLO 초과" : "정상";
  const toneClass = breached
    ? "border-destructive/35 bg-destructive/10 text-destructive"
    : "border-[var(--pw-lime)]/35 bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]";

  return (
    <span
      aria-label={`SLO 상태: ${label}`}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums ${toneClass}`}
    >
      {label}
    </span>
  );
}

export function QueueWaitSloCard({ rows }: { rows: readonly LaneWaitSloRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section
      role="region"
      aria-label="레인별 대기 시간 SLO"
      data-testid="queue-wait-slo-card"
      className="tactile-card overflow-hidden rounded-[12px] border-border bg-card text-card-foreground tabular-nums"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold text-card-foreground">레인 대기 시간</h3>
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          p50 / p95 vs SLO
        </span>
      </header>

      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.lane} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <div className="min-w-[7rem] flex-1">
              <span className="block truncate text-sm font-semibold text-card-foreground">
                {formatQueueLaneLabel(row.lane)}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                샘플 {row.count}건
              </span>
            </div>

            <div className="flex items-center gap-3">
              <LatencyMetric label="p50" value={formatLatencyMs(row.p50Ms)} />
              <LatencyMetric label="p95" value={formatLatencyMs(row.p95Ms)} />
              <LatencyMetric label="목표" value={formatLatencyMs(row.sloTargetMs)} />
            </div>

            <SloStatusBadge breached={row.breached} />
          </li>
        ))}
      </ul>
    </section>
  );
}

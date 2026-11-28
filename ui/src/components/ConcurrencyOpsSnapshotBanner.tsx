import { cn } from "@/lib/utils";

export interface ConcurrencyOpsSnapshotView {
  utilizationPercent: number;
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  attentionRequired: boolean;
  summaryLine: string;
  sloBreachedLanes?: readonly string[];
  coolingDownProviders?: readonly string[];
}

export interface ConcurrencyOpsSnapshotBannerProps {
  snapshot: ConcurrencyOpsSnapshotView | null | undefined;
  onOpenDetails?: () => void;
  className?: string;
}

const STATE_CLASS = {
  attention:
    "border-[var(--pw-token-warning)] bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
  steady:
    "border-[var(--pw-token-success)] bg-[var(--pw-token-success-soft)] text-[var(--pw-token-success-text)]",
} as const;

function formatUtilization(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function ConcurrencyOpsSnapshotBanner({
  snapshot,
  onOpenDetails,
  className,
}: ConcurrencyOpsSnapshotBannerProps) {
  if (!snapshot) return null;

  const attention = snapshot.attentionRequired;
  const sloBreachedLanes = snapshot.sloBreachedLanes ?? [];
  const coolingDownProviders = snapshot.coolingDownProviders ?? [];

  return (
    <section
      role={attention ? "alert" : "status"}
      data-testid="concurrency-ops-snapshot-banner"
      className={cn(
        "tactile-card flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm text-foreground tabular-nums",
        className,
      )}
    >
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Fleet concurrency
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={snapshot.summaryLine}>
        {snapshot.summaryLine}
      </span>
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
          attention ? STATE_CLASS.attention : STATE_CLASS.steady,
        )}
      >
        {attention ? "Attention required" : "Within SLO"}
      </span>
      <span className="inline-flex shrink-0 items-baseline gap-1 rounded-md border border-border bg-accent/60 px-2 py-0.5 font-semibold text-foreground tabular-nums">
        <span>{formatUtilization(snapshot.utilizationPercent)}</span>
        <span className="text-[11px] font-medium text-muted-foreground">utilized</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {snapshot.totalRunning} running · {snapshot.totalQueued} queued · {snapshot.totalSlots} slots
      </span>
      {sloBreachedLanes.length > 0 ? (
        <span className="max-w-full truncate rounded-md bg-[var(--pw-token-warning-soft)] px-2 py-0.5 text-xs text-[var(--pw-token-warning-text)]">
          SLO: {sloBreachedLanes.join(", ")}
        </span>
      ) : null}
      {coolingDownProviders.length > 0 ? (
        <span className="max-w-full truncate rounded-md bg-[var(--pw-token-info-soft)] px-2 py-0.5 text-xs text-[var(--pw-token-info-text)]">
          Cooling down: {coolingDownProviders.join(", ")}
        </span>
      ) : null}
      {onOpenDetails ? (
        <button
          type="button"
          onClick={onOpenDetails}
          className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Details
        </button>
      ) : null}
    </section>
  );
}

import { cn } from "@/lib/utils";

export interface ConcurrencyAlertFeedItem {
  dedupKey: string;
  severity: "warning" | "critical";
  title: string;
  body: string;
  deepLink: string;
  occurredAtIso: string;
}

export interface ConcurrencyAlertFeedProps {
  alerts: readonly ConcurrencyAlertFeedItem[];
  maxVisible?: number;
  onOpenLink?: (deepLink: string) => void;
  className?: string;
}

const severityPresentation: Record<
  ConcurrencyAlertFeedItem["severity"],
  { label: string; className: string }
> = {
  warning: {
    label: "주의",
    className:
      "border-[var(--pw-token-warning)] bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
  },
  critical: {
    label: "긴급",
    className:
      "border-[var(--pw-token-danger)] bg-[var(--pw-token-danger-soft)] text-[var(--pw-token-danger-text)]",
  },
};

function dedupeAlerts(alerts: readonly ConcurrencyAlertFeedItem[]): ConcurrencyAlertFeedItem[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    if (seen.has(alert.dedupKey)) return false;
    seen.add(alert.dedupKey);
    return true;
  });
}

export function ConcurrencyAlertFeed({
  alerts,
  maxVisible = 5,
  onOpenLink,
  className,
}: ConcurrencyAlertFeedProps) {
  if (alerts.length === 0) return null;

  const dedupedAlerts = dedupeAlerts(alerts);
  const visibleAlerts = dedupedAlerts.slice(0, Math.max(0, maxVisible));
  const hiddenCount = dedupedAlerts.length - visibleAlerts.length;

  return (
    <section
      role="region"
      aria-label="동시성 및 예산 경보 목록"
      data-testid="concurrency-alert-feed"
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <ul className="m-0 list-none divide-y divide-border p-0">
        {visibleAlerts.map((alert) => {
          const severity = severityPresentation[alert.severity];
          return (
            <li key={alert.dedupKey} className="flex items-start gap-3 px-3 py-3">
              <span
                className={cn(
                  "mt-0.5 inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
                  severity.className,
                )}
              >
                {severity.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
                  <time dateTime={alert.occurredAtIso} className="text-xs text-muted-foreground">
                    {new Date(alert.occurredAtIso).toLocaleString("ko-KR")}
                  </time>
                </div>
                <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
                  {alert.body}
                </p>
              </div>
              {onOpenLink ? (
                <button
                  type="button"
                  aria-label={`${alert.title} 상세 열기`}
                  onClick={() => onOpenLink(alert.deepLink)}
                  className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  열기
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <div className="border-t border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          +{hiddenCount}건 더 있음
        </div>
      ) : null}
    </section>
  );
}

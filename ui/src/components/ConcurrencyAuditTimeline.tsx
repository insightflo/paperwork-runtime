import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";

export type ConcurrencyAuditKind =
  | "slot_admitted"
  | "capacity_deferred"
  | "lease_renewed"
  | "provider_throttled"
  | "issue_serialized"
  | "deadlock_break_recommended";

export interface ConcurrencyAuditItem {
  id: string;
  timestampIso: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  kind: ConcurrencyAuditKind;
  slotSnapshot: {
    running: number;
    maxSlots: number;
    queued: number;
  };
  reason: string;
}

const CONCURRENCY_AUDIT_KIND_LABELS: Record<ConcurrencyAuditKind, string> = {
  slot_admitted: "슬롯 배정",
  capacity_deferred: "슬롯 대기",
  lease_renewed: "리스 갱신",
  provider_throttled: "프로바이더 제한",
  issue_serialized: "이슈 직렬화",
  deadlock_break_recommended: "순환 대기 해제 권고",
};

const CONCURRENCY_AUDIT_KIND_CLASSES: Record<ConcurrencyAuditKind, string> = {
  slot_admitted: "border-primary/25 bg-primary/10 text-primary",
  capacity_deferred: "border-accent bg-accent/70 text-accent-foreground",
  lease_renewed: "border-secondary bg-secondary text-secondary-foreground",
  provider_throttled: "border-destructive/25 bg-destructive/10 text-destructive",
  issue_serialized: "border-border bg-muted text-muted-foreground",
  deadlock_break_recommended: "border-destructive/25 bg-destructive/10 text-destructive",
};

export function formatConcurrencyAuditKind(kind: ConcurrencyAuditKind): string {
  return CONCURRENCY_AUDIT_KIND_LABELS[kind];
}

export function ConcurrencyAuditTimeline({
  events,
  maxItems = 10,
  onInspectRun,
}: {
  events: readonly ConcurrencyAuditItem[];
  maxItems?: number;
  onInspectRun?: (runId: string) => void;
}) {
  if (events.length === 0) return null;

  const visibleEvents = events.slice(0, Math.max(0, maxItems));
  const hiddenCount = events.length - visibleEvents.length;

  return (
    <section
      role="region"
      aria-label="동시 실행 감사 기록"
      data-testid="concurrency-audit-timeline"
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">동시 실행 감사</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {visibleEvents.length}/{events.length}건
        </p>
      </header>

      <ol className="divide-y divide-border">
        {visibleEvents.map((event) => (
          <li key={event.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("font-medium", CONCURRENCY_AUDIT_KIND_CLASSES[event.kind])}>
                {formatConcurrencyAuditKind(event.kind)}
              </Badge>
              <time dateTime={event.timestampIso} className="text-xs text-muted-foreground tabular-nums">
                {formatDateTime(event.timestampIso)}
              </time>
              <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums">
                {event.slotSnapshot.running}/{event.slotSnapshot.maxSlots} · 대기 {event.slotSnapshot.queued}
              </span>
            </div>

            <p className="mt-2 text-sm leading-5 text-foreground">{event.reason}</p>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                에이전트 <span className="font-mono">{event.agentId}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                런 <span className="font-mono">{event.runId}</span>
              </span>
              {event.issueId ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    이슈 <span className="font-mono">{event.issueId}</span>
                  </span>
                </>
              ) : null}
              {onInspectRun ? (
                <Button type="button" variant="ghost" size="xs" className="ml-auto px-1" onClick={() => onInspectRun(event.runId)}>
                  실행 검토
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {hiddenCount > 0 ? (
        <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          +{hiddenCount}건 더 있음
        </footer>
      ) : null}
    </section>
  );
}

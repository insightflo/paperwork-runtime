import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";

export interface ExceptionHuddleAuditTimelineItem {
  id: string;
  threadId: string | null;
  decisionKind: string | null;
  decidedByAgentId: string | null;
  createdAt: string;
  summary?: string | null;
}

export interface ExceptionHuddleAuditTimelineProps {
  entries: readonly ExceptionHuddleAuditTimelineItem[];
  onOpenThread?: (threadId: string) => void;
  className?: string;
}

const DECISION_KIND_LABELS: Record<string, string> = {
  retry_with_guidance: "재시도 (가이드 포함)",
  accept_with_waiver: "면책 승인",
  replan_remaining: "잔여 단계 재계획",
  escalate: "상위 에스컬레이션",
};

function decisionKindLabel(decisionKind: string | null) {
  if (!decisionKind) return "결정 없음";
  return DECISION_KIND_LABELS[decisionKind] ?? decisionKind;
}

function decisionBadgeClass(decisionKind: string | null) {
  if (decisionKind === "retry_with_guidance") return "border-blue-600/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]";
  if (decisionKind === "accept_with_waiver") return "border-lime-600/30 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]";
  if (decisionKind === "replan_remaining") return "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]";
  if (decisionKind === "escalate") return "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-400/35 dark:bg-red-500/12 dark:text-red-300";
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-300";
}

function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function chronologicalEntries(entries: readonly ExceptionHuddleAuditTimelineItem[]) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => timestampMs(left.entry.createdAt) - timestampMs(right.entry.createdAt) || left.index - right.index)
    .map(({ entry }) => entry);
}

export function ExceptionHuddleAuditTimeline({
  entries,
  onOpenThread,
  className,
}: ExceptionHuddleAuditTimelineProps) {
  const orderedEntries = chronologicalEntries(entries);

  return (
    <section aria-label="Exception huddle audit timeline" className={cn("tactile-card rounded-[12px] border border-border/80 bg-card/90 p-4 text-card-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]", className)}>
      <header className="border-b border-border/70 pb-3 dark:border-white/[0.07]">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:text-[#8f9db3]">Structured exception huddle</p>
        <h2 className="mt-1 text-lg font-semibold tracking-[-0.01em]">Audit timeline</h2>
      </header>

      {orderedEntries.length === 0 ? (
        <p role="status" className="mt-4 rounded-[10px] border border-dashed border-border/70 bg-background/60 px-3 py-4 text-sm text-muted-foreground dark:border-white/[0.09] dark:bg-[#07090d]/60 dark:text-[#9aa7bd]">
          No exception huddle audit entries yet.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {orderedEntries.map((entry) => {
            const threadId = entry.threadId;
            return (
              <li key={entry.id} className="flex gap-3">
                <span aria-hidden="true" className="mt-5 h-2 w-2 shrink-0 rounded-full bg-blue-500 shadow-[0_0_7px_rgba(37,99,235,0.35)] dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.7)]" />
                <div className="min-w-0 flex-1 rounded-[10px] border border-border/70 bg-background/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.08] dark:bg-[#07090d]/80 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("px-2 py-0.5 text-[11px] font-semibold", decisionBadgeClass(entry.decisionKind))}>
                          {decisionKindLabel(entry.decisionKind)}
                        </Badge>
                        {entry.decisionKind ? <code className="text-[11px] text-muted-foreground dark:text-[#8f9db3]">{entry.decisionKind}</code> : null}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground dark:text-[#8f9db3]">
                        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                        {entry.decidedByAgentId ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Decided by <span className="font-mono">{entry.decidedByAgentId}</span></span>
                          </>
                        ) : null}
                      </div>

                      {entry.summary ? (
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90 dark:text-[#d7dee9]">{entry.summary}</p>
                      ) : null}
                    </div>

                    {onOpenThread && threadId ? (
                      <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={() => onOpenThread(threadId)}>
                        Open thread
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface TimedOutHuddleAlertItem {
  threadId: string;
  channelId: string;
  title: string;
  round: number;
  maxRounds: number;
}

export interface ExceptionHuddleTimeoutBannerProps {
  items: readonly TimedOutHuddleAlertItem[];
  onOpenHuddle?: (item: TimedOutHuddleAlertItem) => void;
  onDismiss?: () => void;
  className?: string;
}

export function ExceptionHuddleTimeoutBanner({
  items,
  onOpenHuddle,
  onDismiss,
  className,
}: ExceptionHuddleTimeoutBannerProps) {
  if (items.length === 0) return null;

  const first = items[0];
  if (!first) return null;

  const countLabel = items.length === 1
    ? "1 timed-out huddle requires Chair decision"
    : `${items.length} timed-out huddles require Chair decision`;

  return (
    <section
      role="alert"
      aria-live="assertive"
      aria-label="Timed-out exception huddles"
      className={cn(
        "tactile-card rounded-[12px] border border-amber-600/35 bg-amber-500/[0.08] p-4 text-card-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/[0.08] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-800 dark:text-[#f59e0b]">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>Exception huddle timed out</span>
          </div>
          <p className="mt-2 text-sm font-semibold text-amber-950 dark:text-amber-100">{countLabel}</p>
          <p className="mt-1 break-words text-sm leading-relaxed text-amber-950/85 dark:text-amber-100/80">
            <span className="font-medium text-foreground dark:text-[#eef2f8]">{first.title}</span>{" "}
            <span className="font-mono text-xs tabular-nums text-muted-foreground dark:text-[#9aa7bd]">R{first.round}/{first.maxRounds}</span>
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-auto min-h-9 whitespace-normal py-2 text-left"
            onClick={() => onOpenHuddle?.(first)}
          >
            의장 결정 열기 / Open Chair Decision
          </Button>
          {onDismiss ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

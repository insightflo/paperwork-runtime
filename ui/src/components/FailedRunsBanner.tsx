import { AlertTriangle } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";

export interface FailedRunAlertItem {
  runId: string;
  agentId: string;
  agentName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  title?: string | null;
  status: "failed" | "timed_out";
  finishedAt?: string | null;
}

export interface FailedRunsBannerProps {
  runs: readonly FailedRunAlertItem[];
  onOpenRun?: (run: FailedRunAlertItem) => void;
  className?: string;
}

const STATUS_LABELS: Record<FailedRunAlertItem["status"], string> = {
  failed: "failed",
  timed_out: "timed out",
};

function finishedAtTime(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function runTitle(run: FailedRunAlertItem): string {
  return nonEmpty(run.title) ?? nonEmpty(run.issueIdentifier) ?? `Run ${run.runId.slice(0, 8)}`;
}

function agentLabel(run: FailedRunAlertItem): string {
  return nonEmpty(run.agentName) ?? run.agentId;
}

function finishedLabel(run: FailedRunAlertItem): string | null {
  if (!run.finishedAt || finishedAtTime(run.finishedAt) === 0) return null;
  return relativeTime(run.finishedAt);
}

export function FailedRunsBanner({ runs, onOpenRun, className }: FailedRunsBannerProps) {
  if (runs.length === 0) return null;

  const visibleRuns = [...runs]
    .sort((a, b) => finishedAtTime(b.finishedAt) - finishedAtTime(a.finishedAt))
    .slice(0, 3);
  const overflowCount = runs.length - visibleRuns.length;

  return (
    <div
      role="alert"
      className={cn(
        "tactile-card rounded-[12px] border border-red-500/35 bg-red-500/[0.06] px-3 py-2 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-red-400/35 dark:bg-[#130e16] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {runs.length} failed or timed-out run{runs.length === 1 ? "" : "s"}
        </span>
        {overflowCount > 0 ? (
          <span className="text-xs font-medium tabular-nums text-red-700/80 dark:text-red-300/80">
            +{overflowCount} more
          </span>
        ) : null}
      </div>

      <ul className="mt-2 flex flex-wrap items-center gap-1.5">
        {visibleRuns.map((run) => {
          const title = runTitle(run);
          const finished = finishedLabel(run);
          return (
            <li key={run.runId} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenRun?.(run)}
                title={`Open run ${run.runId}`}
                className="flex h-8 max-w-full items-center gap-1.5 rounded-md border border-red-500/25 bg-white/85 px-2 text-xs text-inherit shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] transition-colors hover:border-red-500/50 hover:bg-white dark:border-red-400/25 dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-red-400/50 dark:hover:bg-[#0b0f18]"
              >
                <span className="shrink-0 font-mono font-semibold uppercase tracking-[0.08em] text-red-700 dark:text-red-300">
                  {STATUS_LABELS[run.status]}
                </span>
                <span className="max-w-[16rem] truncate font-medium" title={title}>
                  {title}
                </span>
                <span className="max-w-[10rem] truncate text-muted-foreground">
                  {agentLabel(run)}
                </span>
                {run.issueIdentifier ? (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {run.issueIdentifier}
                  </span>
                ) : null}
                {finished ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-red-700/70 dark:text-red-300/70">
                    {finished}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

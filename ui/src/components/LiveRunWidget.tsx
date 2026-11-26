import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { ExternalLink, Square } from "lucide-react";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import type { TranscriptEntry } from "../adapters/types";

interface LiveRunWidgetProps {
  issueId: string;
  companyId?: string | null;
}

const META_CHIP_CLASS =
  "inline-flex items-center rounded-md border border-slate-200/90 bg-slate-50/90 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] transition-[border-color,color,background-color] duration-150 dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#9aa7bd] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]";

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function isRunActive(status: string): boolean {
  return status === "queued" || status === "running";
}

function formatElapsed(startIso: string | null | undefined, endIso: string | null | undefined, nowMs: number): string | null {
  if (!startIso) return null;
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return null;
  const targetMs = endIso ? new Date(endIso).getTime() : nowMs;
  const sec = Math.max(0, Math.round((targetMs - startMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function summarizeLiveSteps(entries: readonly TranscriptEntry[]) {
  let tools = 0;
  let thinking = 0;
  let errors = 0;
  for (const entry of entries) {
    if (entry.kind === "tool_call") tools += 1;
    else if (entry.kind === "thinking") thinking += 1;
    else if (entry.kind === "stderr" || ((entry.kind === "tool_result" || entry.kind === "result") && entry.isError)) {
      errors += 1;
    }
  }
  return { tools, thinking, errors };
}

export function LiveRunWidget({ issueId, companyId }: LiveRunWidgetProps) {
  const queryClient = useQueryClient();
  const [cancellingRunIds, setCancellingRunIds] = useState(new Set<string>());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const runs = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) deduped.set(run.id, run);
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        issueId,
      });
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns]);

  const hasActiveRuns = useMemo(() => runs.some((run) => isRunActive(run.status)), [runs]);
  useEffect(() => {
    if (!hasActiveRuns) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({ runs, companyId });

  const handleCancelRun = async (runId: string) => {
    setCancellingRunIds((prev) => new Set(prev).add(runId));
    try {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    } finally {
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  if (runs.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/90 bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_28px_-12px_rgba(0,0,0,0.72)]">
      <div className="border-b border-slate-200/80 bg-slate-50/85 px-4 py-3 dark:border-white/[0.065] dark:bg-[#090d14]/90">
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-600 dark:text-[#aab6c9]">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              hasActiveRuns
                ? "bg-lime-500 shadow-[0_0_8px_rgba(132,204,22,0.55)] motion-safe:animate-pulse dark:bg-[#a3e635] dark:shadow-[0_0_9px_rgba(163,230,53,0.75)]"
                : "bg-slate-400 dark:bg-[#627089]",
            )}
          />
          <span>Live Runs</span>
          {hasActiveRuns && (
            <span className="rounded-full border border-lime-500/30 bg-lime-500/10 px-1.5 py-px font-mono text-[9.5px] font-semibold tracking-normal text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]">
              LIVE
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
          Streamed with the same transcript UI used on the full run detail page.
        </div>
      </div>

      <div className="divide-y divide-slate-200/75 dark:divide-white/[0.065]">
        {runs.map((run) => {
          const isActive = isRunActive(run.status);
          const transcript = transcriptByRun.get(run.id) ?? [];
          const elapsed = formatElapsed(run.startedAt, run.finishedAt, nowMs);
          const stepCounts = summarizeLiveSteps(transcript);
          const hasSteps = stepCounts.tools > 0 || stepCounts.thinking > 0 || stepCounts.errors > 0;
          return (
            <section key={run.id} className="px-4 py-3">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link to={`/agents/${run.agentId}`} className="inline-flex transition-colors hover:text-blue-700 dark:hover:text-[#60a5fa]">
                    <Identity name={run.agentName} size="sm" />
                  </Link>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-[#8b97ad]">
                    <Link
                      to={`/agents/${run.agentId}/runs/${run.id}`}
                      className={cn(
                        META_CHIP_CLASS,
                        "text-blue-700 hover:border-blue-400/50 hover:bg-blue-500/10 hover:text-blue-800 dark:text-[#60a5fa] dark:hover:border-[#60a5fa]/45 dark:hover:bg-[#60a5fa]/12 dark:hover:text-[#bfdbfe]",
                      )}
                    >
                      {run.id.slice(0, 8)}
                    </Link>
                    <StatusBadge status={run.status} />
                    <span
                      data-provider={run.adapterType}
                      className={cn(META_CHIP_CLASS, "gap-1 px-2 py-0.5")}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: "var(--openbot-provider-current)" }}
                      />
                      <span>{run.adapterType}</span>
                    </span>
                    {elapsed && (
                      <span className={cn(
                        "font-mono text-[11px] font-semibold tabular-nums",
                        isActive ? "text-lime-700 dark:text-[#a3e635]" : "text-blue-700 dark:text-[#60a5fa]",
                      )}>
                        {elapsed}
                      </span>
                    )}
                    <span className="tabular-nums">{formatDateTime(run.startedAt ?? run.createdAt)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isActive && (
                    <button
                      type="button"
                      onClick={() => handleCancelRun(run.id)}
                      disabled={cancellingRunIds.has(run.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-[border-color,background-color,color,transform,opacity] duration-150 hover:border-rose-500/50 hover:bg-rose-500/15 active:scale-[0.96] disabled:opacity-50 dark:border-[#fb7185]/30 dark:bg-[#fb7185]/10 dark:text-[#fb7185] dark:hover:border-[#fb7185]/50 dark:hover:bg-[#fb7185]/15"
                    >
                      <Square className="h-2.5 w-2.5" fill="currentColor" />
                      {cancellingRunIds.has(run.id) ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.id}`}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-slate-50/90 px-2.5 py-1 text-[11px] font-semibold text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] transition-[border-color,background-color,color,transform] duration-150 hover:border-blue-400/50 hover:bg-blue-500/10 hover:text-blue-800 active:scale-[0.96] dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] dark:hover:border-[#60a5fa]/45 dark:hover:bg-[#60a5fa]/12 dark:hover:text-[#bfdbfe]"
                  >
                    Open run
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>

              {hasSteps && (
                <div className="mb-2 inline-flex flex-wrap items-center gap-2 rounded-md border border-slate-200/90 bg-slate-50/90 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#8b97ad] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
                  <span>{stepCounts.tools} tools</span>
                  <span aria-hidden="true">·</span>
                  <span>{stepCounts.thinking} thoughts</span>
                  {stepCounts.errors > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-rose-600 dark:text-[#fb7185]">{stepCounts.errors} errors</span>
                    </>
                  )}
                </div>
              )}

              <div className="max-h-[320px] overflow-y-auto rounded-lg border border-slate-200/80 bg-slate-50/70 p-2 shadow-[inset_0_1px_1px_rgba(15,23,42,0.045)] dark:border-white/[0.065] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                <RunTranscriptView
                  entries={transcript}
                  density="compact"
                  limit={8}
                  streaming={isActive}
                  collapseStdout
                  emptyMessage={hasOutputForRun(run.id) ? "Waiting for transcript parsing..." : "Waiting for run output..."}
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

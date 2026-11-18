import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
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
    <div className="overflow-hidden rounded-xl border border-cyan-500/25 bg-background/80 shadow-[0_18px_50px_rgba(6,182,212,0.08)]">
      <div className="border-b border-border/60 bg-cyan-500/[0.04] px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          Live Runs
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Streamed with the same transcript UI used on the full run detail page.
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {runs.map((run) => {
          const isActive = isRunActive(run.status);
          const transcript = transcriptByRun.get(run.id) ?? [];
          const elapsed = formatElapsed(run.startedAt, run.finishedAt, nowMs);
          const stepCounts = summarizeLiveSteps(transcript);
          const hasSteps = stepCounts.tools > 0 || stepCounts.thinking > 0 || stepCounts.errors > 0;
          return (
            <section key={run.id} className="px-4 py-4">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link to={`/agents/${run.agentId}`} className="inline-flex hover:underline">
                    <Identity name={run.agentName} size="sm" />
                  </Link>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Link
                      to={`/agents/${run.agentId}/runs/${run.id}`}
                      className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-1 font-mono hover:border-cyan-500/30 hover:text-foreground"
                    >
                      {run.id.slice(0, 8)}
                    </Link>
                    <StatusBadge status={run.status} />
                    <span
                      data-provider={run.adapterType}
                      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                      style={{ borderColor: "var(--openbot-border-strong)", color: "var(--openbot-text-secondary)" }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: "var(--openbot-provider-current)" }}
                      />
                      <span>{run.adapterType}</span>
                    </span>
                    {elapsed && (
                      <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--openbot-accent-text)" }}>
                        {elapsed}
                      </span>
                    )}
                    <span>{formatDateTime(run.startedAt ?? run.createdAt)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isActive && (
                    <button
                      onClick={() => handleCancelRun(run.id)}
                      disabled={cancellingRunIds.has(run.id)}
                      className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/[0.12] dark:text-red-300 disabled:opacity-50"
                    >
                      <Square className="h-2.5 w-2.5" fill="currentColor" />
                      {cancellingRunIds.has(run.id) ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.id}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-cyan-700 transition-colors hover:border-cyan-500/30 hover:text-cyan-600 dark:text-cyan-300"
                  >
                    Open run
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>

              {hasSteps && (
                <div
                  className="mb-2 inline-flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 font-mono text-[11px]"
                  style={{
                    borderColor: "var(--openbot-border)",
                    backgroundColor: "var(--openbot-bg-surface)",
                    color: "var(--openbot-text-muted)",
                  }}
                >
                  <span>{stepCounts.tools} tools</span>
                  <span>·</span>
                  <span>{stepCounts.thinking} thoughts</span>
                  {stepCounts.errors > 0 && (
                    <>
                      <span>·</span>
                      <span style={{ color: "var(--openbot-danger-text)" }}>{stepCounts.errors} errors</span>
                    </>
                  )}
                </div>
              )}

              <div className="max-h-[320px] overflow-y-auto pr-1">
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

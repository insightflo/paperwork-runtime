import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import type { HeartbeatRun, HeartbeatRunCursor, HeartbeatRunSummary } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import { relativeTime, formatTokens } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../StatusBadge";
import { ScrollToBottom } from "../ScrollToBottom";
import { ErrorReferenceChip } from "../ErrorReferenceChip";
import { TraceWaterfall } from "../TraceWaterfall";
import { AgentRunsTab } from "./AgentRunsTab";
import { LogViewer } from "./LogViewer";
import { RunSessionAndIssues } from "./RunSessionAndIssues";
import { runMetrics } from "../../pages/agent-detail-view-helpers";
import { asNonEmptyString, asRecord, redactRunOutputText } from "../../pages/agent-detail-redaction";

const RUN_DETAIL_PANEL_CLASS =
  "tactile-card overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]";
const EYEBROW_CLASS = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-muted-foreground";

export function RunsTab(props: {
  initialRuns: HeartbeatRunSummary[];
  nextCursor: HeartbeatRunCursor | null;
  companyId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  adapterType: string;
}) {
  return (
    <AgentRunsTab
      {...props}
      renderRunDetail={(run) => (
        <RunDetail run={run} agentRouteId={props.agentRouteId} adapterType={props.adapterType} />
      )}
    />
  );
}

function RunDetail({
  run: initialRun,
  agentRouteId,
  adapterType,
}: {
  run: HeartbeatRun | HeartbeatRunSummary;
  agentRouteId: string;
  adapterType: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: hydratedRun } = useQuery({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => heartbeatsApi.get(initialRun.id),
    enabled: Boolean(initialRun.id),
  });
  const run = (hydratedRun ?? initialRun) as HeartbeatRun;
  const metrics = runMetrics(run);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
    },
  });

  const canResumeLostRun = run.errorCode === "process_lost" && run.status === "failed";
  const resumePayload = useMemo(() => {
    const payload: Record<string, unknown> = { resumeFromRunId: run.id };
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    const commentId = asNonEmptyString(context.wakeCommentId) ?? asNonEmptyString(context.commentId);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    if (commentId) payload.commentId = commentId;
    return payload;
  }, [run.contextSnapshot, run.id]);

  const resumeRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(
        run.agentId,
        { source: "on_demand", triggerDetail: "manual", reason: "resume_process_lost_run", payload: resumePayload },
        run.companyId,
      );
      if (!("id" in result)) throw new Error("Resume request was skipped because the agent is not currently invokable.");
      return result;
    },
    onSuccess: (resumedRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${resumedRun.id}`);
    },
  });

  const canRetryRun = run.status === "failed" || run.status === "timed_out";
  const retryPayload = useMemo(() => {
    const payload: Record<string, unknown> = {};
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    return payload;
  }, [run.contextSnapshot]);

  const retryRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(
        run.agentId,
        { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", payload: retryPayload },
        run.companyId,
      );
      if (!("id" in result)) throw new Error("Retry was skipped because the agent is not currently invokable.");
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      if (newRun.agentId !== run.agentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, newRun.agentId) });
      }
      navigate(`/agents/${newRun.agentId}/runs/${newRun.id}`);
    },
  });

  const isRunning = run.status === "running" && !!run.startedAt && !run.finishedAt;
  const [elapsedSec, setElapsedSec] = useState<number>(() =>
    run.startedAt ? Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)) : 0,
  );

  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const startMs = new Date(run.startedAt).getTime();
    setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = setInterval(() => setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000))), 1000);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const durationSec =
    run.startedAt && run.finishedAt
      ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
      : null;
  const displayDurationSec = durationSec ?? (isRunning ? elapsedSec : null);
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;
  const hasNonZeroExit = run.exitCode !== null && run.exitCode !== 0;

  return (
    <div className="space-y-4 min-w-0 tabular-nums">
      <div className={RUN_DETAIL_PANEL_CLASS}>
        <div className="flex flex-col sm:flex-row">
          <div className="flex-1 p-4 space-y-3">
            <div className="space-y-2">
              <div className={EYEBROW_CLASS}>실행 / Execution</div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} />
                {(run.status === "running" || run.status === "queued") && (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive text-xs h-6 px-2" onClick={() => cancelRun.mutate()} disabled={cancelRun.isPending}>
                    {cancelRun.isPending ? "Cancelling…" : "Cancel"}
                  </Button>
                )}
                {canResumeLostRun && (
                  <Button variant="ghost" size="sm" className="text-xs h-6 px-2" onClick={() => resumeRun.mutate()} disabled={resumeRun.isPending}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    {resumeRun.isPending ? "Resuming…" : "Resume"}
                  </Button>
                )}
                {canRetryRun && !canResumeLostRun && (
                  <Button variant="ghost" size="sm" className="text-xs h-6 px-2" onClick={() => retryRun.mutate()} disabled={retryRun.isPending}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    {retryRun.isPending ? "Retrying…" : "Retry"}
                  </Button>
                )}
              </div>
            </div>
            {resumeRun.isError && <ErrorReferenceChip error={resumeRun.error} fallback="Failed to resume run" />}
            {retryRun.isError && <ErrorReferenceChip error={retryRun.error} fallback="Failed to retry run" />}
            {startTime && (
              <div className="space-y-1.5">
                <div className={EYEBROW_CLASS}>실행 시간 / Timing</div>
                <div className="text-sm font-mono text-slate-800 dark:text-foreground/90">
                  {startTime}
                  {endTime && <span className="text-slate-400 dark:text-muted-foreground/80"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-slate-500 dark:text-muted-foreground">
                    Duration: {displayDurationSec >= 60 ? `${Math.floor(displayDurationSec / 60)}m ${displayDurationSec % 60}s` : `${displayDurationSec}s`}
                  </div>
                )}
              </div>
            )}
            {run.error && <ErrorReferenceChip error={run.error} code={run.errorCode} allowDiagnosticExpand />}
            {hasNonZeroExit && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
          </div>

          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-slate-200/80 dark:border-white/[0.07] p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div className="col-span-2">
                <div className={EYEBROW_CLASS}>실행 사용량 / Usage</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono text-slate-900 dark:text-foreground">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono text-slate-900 dark:text-foreground">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono text-slate-900 dark:text-foreground">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono text-slate-900 dark:text-foreground">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        <RunSessionAndIssues run={run} adapterType={adapterType} />
      </div>

      {run.stderrExcerpt && (
        <div className="tactile-card rounded-xl border border-red-200/80 bg-red-50/70 p-3 space-y-2 dark:border-red-400/20 dark:bg-red-500/[0.07]">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-red-700 dark:text-red-300">stderr</span>
          <pre className="rounded-lg border border-red-200/80 bg-white/70 p-3 text-xs font-mono text-red-700 dark:border-red-400/20 dark:bg-muted/30 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
            {redactRunOutputText(run.stderrExcerpt, true)}
          </pre>
        </div>
      )}

      {run.stdoutExcerpt && !run.logRef && (
        <div className="tactile-card rounded-xl border border-slate-200/90 bg-white p-3 space-y-2 dark:border-white/[0.08] dark:bg-card">
          <span className={EYEBROW_CLASS}>stdout</span>
          <pre className="rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 text-xs font-mono text-foreground dark:border-white/[0.07] dark:bg-muted/30 dark:text-foreground/90 overflow-x-auto whitespace-pre-wrap">
            {redactRunOutputText(run.stdoutExcerpt, true)}
          </pre>
        </div>
      )}

      <TraceWaterfall run={run} adapterType={adapterType} />
      <LogViewer run={run} adapterType={adapterType} />
      <ScrollToBottom />
    </div>
  );
}

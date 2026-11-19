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
    <div className="space-y-4 min-w-0">
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          <div className="flex-1 p-4 space-y-3">
            <div className="flex items-center gap-2">
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
            {resumeRun.isError && <ErrorReferenceChip error={resumeRun.error} fallback="Failed to resume run" />}
            {retryRun.isError && <ErrorReferenceChip error={retryRun.error} fallback="Failed to retry run" />}
            {startTime && (
              <div className="space-y-0.5">
                <div className="text-sm font-mono">
                  {startTime}
                  {endTime && <span className="text-muted-foreground"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-muted-foreground">
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
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div>
                <div className="text-xs text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        <RunSessionAndIssues run={run} adapterType={adapterType} />
      </div>

      {run.stderrExcerpt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
            {redactRunOutputText(run.stderrExcerpt, true)}
          </pre>
        </div>
      )}

      {run.stdoutExcerpt && !run.logRef && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
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

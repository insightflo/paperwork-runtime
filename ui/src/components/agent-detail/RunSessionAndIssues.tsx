import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi, type ClaudeLoginResult } from "../../api/agents";
import { activityApi } from "../../api/activity";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { CopyText } from "../CopyText";
import { StatusBadge } from "../StatusBadge";
import { ErrorReferenceChip } from "../ErrorReferenceChip";
import { QueuePanel } from "../QueuePanel";
import { AgentStepsDisclosure, SubagentDock, type AgentStep, type SubagentEntry } from "../SubagentDockAndSteps";

function extractRunSteps(run: HeartbeatRun): AgentStep[] {
  const raw = (run.contextSnapshot as { steps?: unknown[] } | null)?.steps
    ?? (run.resultJson as { steps?: unknown[] } | null)?.steps
    ?? [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s, i) => ({
      id: String(s.id ?? `step-${i}`),
      kind: (["model", "tool", "waiting", "handoff"].includes(String(s.kind)) ? s.kind : "tool") as AgentStep["kind"],
      label: String(s.label ?? s.name ?? s.kind ?? `step ${i + 1}`),
      durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
      failed: s.failed === true || s.status === "failed",
    }));
}

export function RunSessionAndIssues({ run, adapterType }: { run: HeartbeatRun; adapterType: string }) {
  const queryClient = useQueryClient();
  const [sessionOpen, setSessionOpen] = useState(false);
  const [claudeLoginResult, setClaudeLoginResult] = useState<ClaudeLoginResult | null>(null);

  useEffect(() => {
    setClaudeLoginResult(null);
  }, [run.id]);

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });
  const touchedIssueIds = useMemo(
    () => Array.from(new Set((touchedIssues ?? []).map((issue) => issue.issueId))),
    [touchedIssues],
  );

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(run.companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(run.companyId),
    enabled: run.status === "running",
    refetchInterval: run.status === "running" ? 5_000 : false,
  });
  const subagents = useMemo<SubagentEntry[]>(
    () => (liveRuns ?? [])
      .filter((r) => r.id !== run.id)
      .map((r) => ({
        runId: r.id,
        agentId: r.agentId,
        agentName: r.agentName,
        status: r.status === "running" ? "running" : "waiting",
        startedAt: r.startedAt,
      })),
    [liveRuns, run.id],
  );
  const runSteps = useMemo(() => extractRunSteps(run), [run]);
  const pendingModel = (run.contextSnapshot as { pendingModel?: unknown } | null)?.pendingModel;
  const pendingModelLabel = typeof pendingModel === "string" && pendingModel ? pendingModel : null;

  const clearSessionsForTouchedIssues = useMutation({
    mutationFn: async () => {
      if (touchedIssueIds.length === 0) return 0;
      await Promise.all(touchedIssueIds.map((issueId) => agentsApi.resetSession(run.agentId, issueId, run.companyId)));
      return touchedIssueIds.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    },
  });

  const runClaudeLogin = useMutation({
    mutationFn: () => agentsApi.loginWithClaude(run.agentId, run.companyId),
    onSuccess: (data) => setClaudeLoginResult(data),
  });

  const hasSession = Boolean(run.sessionIdBefore || run.sessionIdAfter);
  const sessionChanged = Boolean(run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore !== run.sessionIdAfter);

  return (
    <>
      {run.errorCode === "claude_auth_required" && adapterType === "claude_local" && (
        <div className="border-t border-border px-4 py-3 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => runClaudeLogin.mutate()}
            disabled={runClaudeLogin.isPending}
          >
            {runClaudeLogin.isPending ? "Running claude login..." : "Login to Claude Code"}
          </Button>
          {runClaudeLogin.isError && <ErrorReferenceChip error={runClaudeLogin.error} fallback="Failed to run Claude login" />}
          {claudeLoginResult?.loginUrl && (
            <p className="text-xs">
              Login URL:
              <a
                href={claudeLoginResult.loginUrl}
                className="underline underline-offset-2 ml-1 break-all"
                style={{ color: "var(--openbot-accent-text)" }}
                target="_blank"
                rel="noreferrer"
              >
                {claudeLoginResult.loginUrl}
              </a>
            </p>
          )}
          {claudeLoginResult?.stdout && (
            <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
              {claudeLoginResult.stdout}
            </pre>
          )}
          {claudeLoginResult?.stderr && (
            <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
              {claudeLoginResult.stderr}
            </pre>
          )}
        </div>
      )}

      {hasSession && (
        <div className="border-t border-border">
          <button
            className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSessionOpen((v) => !v)}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", sessionOpen && "rotate-90")} />
            Session
            {sessionChanged && <span style={{ color: "var(--openbot-warning-text)" }} className="ml-1">(changed)</span>}
          </button>
          {sessionOpen && (
            <div className="px-4 pb-3 space-y-1 text-xs">
              {run.sessionIdBefore && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-12">{sessionChanged ? "Before" : "ID"}</span>
                  <CopyText text={run.sessionIdBefore} className="font-mono" />
                </div>
              )}
              {sessionChanged && run.sessionIdAfter && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-12">After</span>
                  <CopyText text={run.sessionIdAfter} className="font-mono" />
                </div>
              )}
              {touchedIssueIds.length > 0 && (
                <div className="pt-1">
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                    disabled={clearSessionsForTouchedIssues.isPending}
                    onClick={() => {
                      const count = touchedIssueIds.length;
                      if (window.confirm(`Clear session for ${count} work item${count === 1 ? "" : "s"} touched by this run?`)) {
                        clearSessionsForTouchedIssues.mutate();
                      }
                    }}
                  >
                    {clearSessionsForTouchedIssues.isPending ? "clearing session..." : "clear session for these work items"}
                  </button>
                  {clearSessionsForTouchedIssues.isError && (
                    <ErrorReferenceChip error={clearSessionsForTouchedIssues.error} className="mt-1" fallback="Failed to clear sessions" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(subagents.length > 0 || runSteps.length > 0 || run.status === "running") && (
        <div className="border-t border-border px-4 py-3 space-y-2">
          {subagents.length > 0 && <SubagentDock entries={subagents} />}
          {runSteps.length > 0 && <AgentStepsDisclosure steps={runSteps} />}
          {run.status === "running" && (
            <QueuePanel companyId={run.companyId} agentId={run.agentId} pendingModel={pendingModelLabel} />
          )}
        </div>
      )}

      {touchedIssues && touchedIssues.length > 0 && (
        <div className="border-t border-border p-4 space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Work Touched ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/issues/${issue.identifier ?? issue.issueId}`}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={issue.status} />
                  <span className="truncate">{issue.title}</span>
                </div>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

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

const PANEL =
  "tactile-card rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.7)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const LOG_SURFACE =
  "rounded-md border border-slate-200/80 bg-white font-mono text-xs dark:border-white/[0.07] dark:bg-[#07090d]";
const SECTION_WRAP = "border-t border-slate-200/80 px-3 py-3 dark:border-white/[0.07]";
const EYEBROW = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const LABEL = "text-slate-500 dark:text-[#8b97ad]";
const VALUE = "text-slate-900 dark:text-[#edf2fb]";
const STATUS_PILL =
  "rounded-full border border-slate-200/90 bg-slate-50 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 tabular-nums dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]";

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
        <div className={SECTION_WRAP}>
          <div className={cn(PANEL, "space-y-3 p-3 tabular-nums")}>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 pb-2 dark:border-white/[0.07]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]" />
              <span className={EYEBROW}>Execution access</span>
              <span className={cn(STATUS_PILL, "ml-auto")}>Sign-in required</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => runClaudeLogin.mutate()}
                disabled={runClaudeLogin.isPending}
              >
                {runClaudeLogin.isPending ? "Preparing sign-in..." : "Sign in to Claude Code"}
              </Button>
              <span className={cn("text-[11px]", LABEL)}>Local Claude Code authentication is required.</span>
            </div>
            {runClaudeLogin.isError && <ErrorReferenceChip error={runClaudeLogin.error} fallback="Failed to run Claude login" />}
            {claudeLoginResult?.loginUrl && (
              <div className={cn(INSET, "space-y-1.5 p-2.5")}>
                <span className={EYEBROW}>Sign-in link</span>
                <a
                  href={claudeLoginResult.loginUrl}
                  className="block break-all font-mono text-[11px] underline underline-offset-2"
                  style={{ color: "var(--openbot-accent-text)" }}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {claudeLoginResult.loginUrl}
                </a>
              </div>
            )}
            {claudeLoginResult?.stdout && (
              <div className="space-y-1">
                <span className={EYEBROW}>Execution output</span>
                <pre className={cn(LOG_SURFACE, "overflow-x-auto whitespace-pre-wrap p-3 text-slate-800 dark:text-[#dbe4f0]")}>
                  {claudeLoginResult.stdout}
                </pre>
              </div>
            )}
            {claudeLoginResult?.stderr && (
              <div className="space-y-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">Execution error output</span>
                <pre className={cn(LOG_SURFACE, "overflow-x-auto whitespace-pre-wrap border-rose-500/20 p-3 text-rose-700 dark:border-rose-400/20 dark:text-rose-300")}>
                  {claudeLoginResult.stderr}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {hasSession && (
        <div className={SECTION_WRAP}>
          <div className={cn(PANEL, "overflow-hidden tabular-nums")}>
            <button
              type="button"
              aria-expanded={sessionOpen}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.04]"
              onClick={() => setSessionOpen((v) => !v)}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform dark:text-[#627089]", sessionOpen && "rotate-90")} />
              <span className={EYEBROW}>Execution session</span>
              {sessionChanged && <span className={STATUS_PILL}>updated</span>}
            </button>
            {sessionOpen && (
              <div className="space-y-2 border-t border-slate-200/80 px-3 py-3 dark:border-white/[0.07]">
                {run.sessionIdBefore && (
                  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className={cn("font-semibold uppercase tracking-[0.1em]", LABEL)}>{sessionChanged ? "Before" : "ID"}</span>
                    <CopyText text={run.sessionIdBefore} className={cn("break-all font-mono tabular-nums", VALUE)} />
                  </div>
                )}
                {sessionChanged && run.sessionIdAfter && (
                  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className={cn("font-semibold uppercase tracking-[0.1em]", LABEL)}>After</span>
                    <CopyText text={run.sessionIdAfter} className={cn("break-all font-mono tabular-nums", VALUE)} />
                  </div>
                )}
                {touchedIssueIds.length > 0 && (
                  <div className={cn(INSET, "flex flex-wrap items-center gap-2 px-2.5 py-2")}>
                    <span className={cn("text-[11px]", LABEL)}>{touchedIssueIds.length} linked work item{touchedIssueIds.length === 1 ? "" : "s"}</span>
                    <button
                      type="button"
                      className="ml-auto text-[11px] font-medium text-blue-700 underline underline-offset-2 transition-colors hover:text-blue-600 disabled:opacity-60 dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
                      disabled={clearSessionsForTouchedIssues.isPending}
                      onClick={() => {
                        const count = touchedIssueIds.length;
                        if (window.confirm(`Reset execution session for ${count} work item${count === 1 ? "" : "s"} touched by this run?`)) {
                          clearSessionsForTouchedIssues.mutate();
                        }
                      }}
                    >
                      {clearSessionsForTouchedIssues.isPending ? "Resetting linked sessions..." : "Reset linked sessions"}
                    </button>
                    {clearSessionsForTouchedIssues.isError && (
                      <ErrorReferenceChip error={clearSessionsForTouchedIssues.error} className="mt-1" fallback="Failed to clear sessions" />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {(subagents.length > 0 || runSteps.length > 0 || run.status === "running") && (
        <div className={SECTION_WRAP}>
          <div className={cn(PANEL, "space-y-2.5 p-3 tabular-nums")}>
            <div className="flex items-center gap-2 border-b border-slate-200/80 pb-2 dark:border-white/[0.07]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(96,165,250,0.45)] dark:bg-[#60a5fa]" />
              <span className={EYEBROW}>Execution orchestration</span>
            </div>
            {subagents.length > 0 && <SubagentDock entries={subagents} />}
            {runSteps.length > 0 && <AgentStepsDisclosure steps={runSteps} />}
            {run.status === "running" && (
              <QueuePanel companyId={run.companyId} agentId={run.agentId} pendingModel={pendingModelLabel} />
            )}
          </div>
        </div>
      )}

      {touchedIssues && touchedIssues.length > 0 && (
        <div className={SECTION_WRAP}>
          <div className={cn(PANEL, "overflow-hidden tabular-nums")}>
            <div className="flex items-center gap-2 border-b border-slate-200/80 px-3 py-2.5 dark:border-white/[0.07]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.45)] dark:bg-[#a3e635]" />
              <span className={EYEBROW}>Execution impact</span>
              <span className={cn(STATUS_PILL, "ml-auto")}>{touchedIssues.length}</span>
            </div>
            <div className="divide-y divide-slate-200/80 dark:divide-white/[0.07]">
              {touchedIssues.map((issue) => (
                <Link
                  key={issue.issueId}
                  to={`/issues/${issue.identifier ?? issue.issueId}`}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-xs text-slate-700 no-underline transition-colors hover:bg-slate-50 dark:text-[#dbe4f0] dark:hover:bg-white/[0.04]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusBadge status={issue.status} />
                    <span className="truncate">{issue.title}</span>
                  </div>
                  <span className="ml-2 shrink-0 font-mono text-[11px] text-slate-500 tabular-nums dark:text-[#8b97ad]">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

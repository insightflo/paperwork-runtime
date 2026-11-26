import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import type { TranscriptEntry } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

interface ActiveAgentsPanelProps {
  companyId: string;
}

export function ActiveAgentsPanel({ companyId }: ActiveAgentsPanelProps) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, MIN_DASHBOARD_RUNS),
  });

  const runs = liveRuns ?? [];
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(companyId, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs,
    companyId,
    maxChunksPerRun: 120,
  });

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(101,163,13,0.35)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.55)]" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground dark:text-[#8f9db3]">
          Agents
        </h3>
      </div>
      {runs.length === 0 ? (
        <div className="tactile-card rounded-xl border border-border/80 p-4 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
          <p className="text-sm text-muted-foreground dark:text-[#9aa7bd]">No recent agent runs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {runs.map((run) => (
            <AgentRunCard
              key={run.id}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? []}
              hasOutput={hasOutputForRun(run.id)}
              isActive={isRunActive(run)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRunCard({
  run,
  issue,
  transcript,
  hasOutput,
  isActive,
}: {
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
}) {
  return (
    <div className={cn(
      "tactile-card flex h-[320px] flex-col overflow-hidden rounded-xl border tabular-nums transition-[border-color,background-color,box-shadow] duration-150",
      "dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8]",
      isActive
        ? "border-lime-500/30 bg-lime-500/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_16px_40px_rgba(101,163,13,0.10)] dark:border-[#a3e635]/30 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_16px_40px_-20px_rgba(163,230,53,0.25)]"
        : "border-border bg-background/70 dark:border-white/[0.08] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]",
    )}>
      <div className="border-b border-border/60 px-3 py-3 dark:border-white/[0.07]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span aria-hidden className="pw-live-dot mt-0.5" />
              ) : (
                <span aria-hidden className="mt-0.5 inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground/35 dark:bg-[#627089]" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground dark:text-[#8f9db3]">
              <span className={cn(isActive && "font-semibold text-lime-700 dark:text-[#a3e635]")}>
                {isActive ? "Live now" : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}
              </span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-blue-500/40 hover:text-blue-600 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#8f9db3] dark:hover:border-[#60a5fa]/45 dark:hover:text-[#60a5fa]"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs dark:border-white/[0.07] dark:bg-[#090c12]/80">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive
                  ? "text-lime-700 dark:text-[#a3e635]"
                  : "text-muted-foreground hover:text-foreground dark:text-[#9aa7bd] dark:hover:text-[#60a5fa]",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 dark:bg-[#090c12]/45">
        <RunTranscriptView
          entries={transcript}
          density="compact"
          limit={5}
          streaming={isActive}
          collapseStdout
          thinkingClassName="!text-[10px] !leading-4"
          emptyMessage={hasOutput ? "Waiting for transcript parsing..." : isActive ? "Waiting for output..." : "No transcript captured."}
        />
      </div>
    </div>
  );
}

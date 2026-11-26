import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { missionsApi } from "../api/missions";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { cn } from "../lib/utils";
import { ChevronRight, ListTree, PlayCircle } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

interface MissionIssueTreeProps {
  missionId: string;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

interface IssueNodeProps {
  issue: Issue;
  allIssues: Issue[];
  liveRunsByIssueId: Map<string, LiveRunForIssue[]>;
  depth: number;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

function createdAtTime(issue: Issue) {
  return new Date(issue.createdAt).getTime();
}

function compareIssueCreatedAt(a: Issue, b: Issue) {
  const aTime = createdAtTime(a);
  const bTime = createdAtTime(b);
  if (aTime !== bTime) return aTime - bTime;
  return (a.identifier ?? a.title).localeCompare(b.identifier ?? b.title);
}

function RunIndicator({ runs }: { runs: LiveRunForIssue[] }) {
  if (runs.length === 0) return null;

  const primaryRun = runs[0];
  const extraCount = runs.length - 1;
  const runStatus = primaryRun.status === "queued" ? "queued" : "running";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
        runStatus === "running"
          ? "border-blue-600/25 bg-blue-50 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]"
          : "border-amber-600/25 bg-amber-50 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
      )}
      title={`Run ${runStatus}${primaryRun.agentName ? ` by ${primaryRun.agentName}` : ""}${
        primaryRun.id ? ` (${primaryRun.id.slice(0, 8)})` : ""
      }`}
    >
      <PlayCircle className="h-3 w-3" />
      <span>Run {runStatus}</span>
      {extraCount > 0 && <span>+{extraCount}</span>}
    </span>
  );
}

function IssueNode({ issue, allIssues, liveRunsByIssueId, depth, selectedIssueId, onSelectIssue }: IssueNodeProps) {
  const children = allIssues.filter((i) => i.parentId === issue.id);
  const hasChildren = children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedIssueId === issue.id;
  const liveRuns = liveRunsByIssueId.get(issue.id) ?? [];

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors",
          isSelected
            ? "bg-accent/60 dark:bg-[#151d2b] shadow-[inset_2px_0_0_#2563eb] dark:shadow-[inset_2px_0_0_#60a5fa]"
            : "hover:bg-slate-50 dark:hover:bg-[#111826]",
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse child issues" : "Expand child issues"}
            className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-[#627089] dark:hover:bg-[#151d2b] dark:hover:text-[#b6c2d6] dark:focus-visible:ring-[#60a5fa]/35"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelectIssue?.(issue.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:focus-visible:ring-[#60a5fa]/35"
        >
          <StatusIcon status={issue.status} className="shrink-0" />
          <PriorityIcon priority={issue.priority} className="shrink-0" />
          <span className="flex-1 truncate text-slate-800 dark:text-[#eef2f8]">{issue.title}</span>
          <RunIndicator runs={liveRuns} />
          {issue.identifier && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
              {issue.identifier}
            </span>
          )}
        </button>
      </div>

      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <IssueNode
              key={child.id}
              issue={child}
              allIssues={allIssues}
              liveRunsByIssueId={liveRunsByIssueId}
              depth={depth + 1}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function MissionIssueTree({ missionId, selectedIssueId, onSelectIssue }: MissionIssueTreeProps) {
  const { selectedCompanyId } = useCompany();

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.issues(missionId),
    queryFn: () => missionsApi.listIssues(missionId),
    enabled: !!selectedCompanyId && !!missionId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.liveRuns(selectedCompanyId) : ["live-runs", "__no-company__"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!missionId,
    refetchInterval: 3000,
  });

  const liveRunsByIssueId = useMemo(() => {
    const map = new Map<string, LiveRunForIssue[]>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId) continue;
      if (run.status !== "running" && run.status !== "queued") continue;
      const existing = map.get(run.issueId);
      if (existing) {
        existing.push(run);
      } else {
        map.set(run.issueId, [run]);
      }
    }
    return map;
  }, [liveRuns]);

  const roots = useMemo(() => {
    if (!issues) return [];
    const issueIds = new Set(issues.map((i) => i.id));
    return issues
      .filter((i) => !i.parentId || !issueIds.has(i.parentId))
      .sort(compareIssueCreatedAt);
  }, [issues]);

  useEffect(() => {
    if (!issues || issues.length === 0 || !onSelectIssue) return;
    if (selectedIssueId && issues.some((issue) => issue.id === selectedIssueId)) return;
    onSelectIssue(roots[0]?.id ?? issues[0].id);
  }, [issues, onSelectIssue, roots, selectedIssueId]);

  if (!selectedCompanyId) return null;

  if (isLoading) {
    return (
      <div className="space-y-1 py-2">
        {[12, 20, 28].map((leftPadding) => (
          <div
            key={`mission-issue-skeleton-${leftPadding}`}
            className="h-7 animate-pulse rounded-md bg-slate-100 dark:bg-[#111826]"
            style={{ marginLeft: `${leftPadding}px`, width: `calc(100% - ${leftPadding + 12}px)` }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive px-3 py-2">
        {error instanceof Error ? error.message : "Failed to load work items"}
      </p>
    );
  }

  if (!issues || issues.length === 0) {
    return (
      <div className="tactile-card flex flex-col items-center justify-center rounded-[12px] border-dashed border-slate-200/90 bg-white/80 px-6 py-10 text-center tabular-nums dark:border-white/[0.1] dark:bg-none dark:bg-[#0e131d]">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-slate-200/90 bg-slate-50 dark:border-white/[0.09] dark:bg-[#090c12]">
          <ListTree className="h-5 w-5 text-slate-400 dark:text-[#60a5fa]" />
        </div>
        <p className="text-sm font-medium text-slate-700 dark:text-[#eef2f8]">No work items linked to this mission.</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-[#8f9db3]">
          Work items will appear here once they are associated with this mission.
        </p>
      </div>
    );
  }

  return (
    <div className="tactile-card overflow-hidden rounded-[12px] border-slate-200/90 bg-white/95 py-1 tabular-nums dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
      {roots.map((issue) => (
        <IssueNode
          key={issue.id}
          issue={issue}
          allIssues={issues}
          liveRunsByIssueId={liveRunsByIssueId}
          depth={0}
          selectedIssueId={selectedIssueId}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}

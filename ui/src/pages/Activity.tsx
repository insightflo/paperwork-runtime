import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { agentsApi } from "../api/agents";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { OperatorDecisionActivity } from "../components/OperatorDecisionActivity";
import { Input } from "@/components/ui/input";
import { History, Search } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, ActivityEvent } from "@paperclipai/shared";

export type ActivityCategory = "all" | "agent" | "mission" | "decision" | "worktree";

const ACTIVITY_PAGE_SIZE = 50;

const CATEGORY_PILLS: { id: ActivityCategory; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "agent", label: "에이전트" },
  { id: "mission", label: "미션" },
  { id: "decision", label: "결정" },
  { id: "worktree", label: "워크트리" },
];

export function categorizeActivityEvent(event: ActivityEvent): Exclude<ActivityCategory, "all"> | null {
  const hay = `${event.entityType} ${event.action}`.toLowerCase();
  if (hay.includes("operator_decision") || hay.includes("decision")) return "decision";
  if (hay.includes("worktree") || hay.includes("workspace")) return "worktree";
  if (hay.includes("mission") || hay.includes("goal")) return "mission";
  if (hay.includes("agent") || hay.includes("heartbeat") || hay.includes("run")) return "agent";
  return null;
}

export interface ActivityDiffBadge {
  from: string;
  to: string;
}

/** Derive a compact "변경 전 → 변경 후" badge from event.details when a from/to pair exists. */
export function extractActivityDiff(details: Record<string, unknown> | null): ActivityDiffBadge | null {
  if (!details) return null;
  const pairs: [string, string][] = [
    ["before", "after"],
    ["from", "to"],
    ["previousStatus", "status"],
  ];
  for (const [fromKey, toKey] of pairs) {
    const from = details[fromKey];
    const to = details[toKey];
    if (from != null && to != null && String(from) !== String(to)) {
      return { from: String(from).slice(0, 40), to: String(to).slice(0, 40) };
    }
  }
  return null;
}

function DiffBadge({ diff }: { diff: ActivityDiffBadge }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono" title="변경 전 → 변경 후">
      <span style={{ color: "var(--openbot-diff-before-text)", backgroundColor: "var(--openbot-diff-before-bg)" }} className="rounded px-1">
        {diff.from}
      </span>
      <span className="text-muted-foreground">→</span>
      <span style={{ color: "var(--openbot-diff-after-text)", backgroundColor: "var(--openbot-diff-after-bg)" }} className="rounded px-1">
        {diff.to}
      </span>
    </span>
  );
}

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), "paged", ACTIVITY_PAGE_SIZE] as const,
    queryFn: ({ pageParam }) =>
      api.get<ActivityEvent[]>(
        `/companies/${selectedCompanyId!}/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=${pageParam}`,
      ),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === ACTIVITY_PAGE_SIZE ? pages.length * ACTIVITY_PAGE_SIZE : undefined,
    placeholderData: keepPreviousData,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const activityEvents = useMemo(() => data?.pages.flat() ?? [], [data]);

  const filtered = useMemo(() => {
    let events = activityEvents;
    if (category !== "all") {
      events = events.filter((e) => categorizeActivityEvent(e) === category);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      events = events.filter((e) =>
        `${e.action} ${e.entityType} ${e.actorId} ${e.agentId ?? ""} ${JSON.stringify(e.details ?? {})}`
          .toLowerCase()
          .includes(q),
      );
    }
    return events;
  }, [activityEvents, category, searchQuery]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-md border border-border/80 bg-card/60 p-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex self-start rounded-md bg-muted/50 p-0.5">
          {CATEGORY_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              onClick={() => setCategory(pill.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                category === pill.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {pill.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="활동 검색…"
            className="h-8 pl-7 text-xs"
            aria-label="활동 검색"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered.length === 0 && (
        <EmptyState icon={History} message={searchQuery || category !== "all" ? "조건에 맞는 활동이 없습니다." : "No activity yet."} />
      )}

      {filtered.length > 0 && (
        <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/80 bg-card/60">
          {filtered.map((event) => {
            const diff = extractActivityDiff(event.details);
            const row = event.action.startsWith("operator_decision.") ? (
              <OperatorDecisionActivity key={event.id} event={event} />
            ) : (
              <ActivityRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            );
            return diff ? (
              <div key={event.id} className="relative">
                {row}
                <div className="px-3 pb-1.5 -mt-1">
                  <DiffBadge diff={diff} />
                </div>
              </div>
            ) : row;
          })}
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/70 disabled:opacity-50"
          >
            {isFetchingNextPage ? "불러오는 중…" : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}

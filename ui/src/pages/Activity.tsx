import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { CompactPagination, PAGE_SIZE, PAGE_WINDOW_KEY, pageOffset, splitFetchedPage, usePageNumber, useScrollToTopOnPageChange } from "../components/CompactPagination";
import { OperatorDecisionActivity } from "../components/OperatorDecisionActivity";
import { History, Search } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, ActivityEvent } from "@paperclipai/shared";

export type ActivityCategory = "all" | "agent" | "mission" | "decision" | "worktree";

function fetchActivityPage(companyId: string, offset: number) {
  return api.get<ActivityEvent[]>(`/companies/${companyId}/activity?limit=${PAGE_SIZE + 1}&offset=${offset}`);
}
const activityPageKey = (companyId: string, page: number) => [...queryKeys.activity(companyId), PAGE_WINDOW_KEY, PAGE_SIZE, page] as const;
/** A freshly prefetched next page is not re-requested when the user simply returns to the previous page. */
const NEXT_PAGE_PREFETCH_STALE_MS = 30_000;

/* ── Cockpit strip + toolbar vocabulary ──
 * Categories carry a micro status dot so the 1-row strip, the 40px tab group and the
 * DiffBadge pills below all speak the same emerald/amber/crimson/cobalt language. */
const CATEGORY_PILLS: { id: ActivityCategory; label: string; dot: string }[] = [
  { id: "all", label: "전체", dot: "bg-blue-500 dark:bg-[#60a5fa]" },
  { id: "agent", label: "에이전트", dot: "bg-lime-500 dark:bg-[#a3e635]" },
  { id: "mission", label: "미션", dot: "bg-blue-500 dark:bg-[#60a5fa]" },
  { id: "decision", label: "결정", dot: "bg-amber-500 dark:bg-[#f59e0b]" },
  { id: "worktree", label: "워크트리", dot: "bg-slate-400 dark:bg-[#8b97ad]" },
];

const TAB_CLASS =
  "h-7 cursor-pointer rounded-md px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-[#60a5fa]/30 aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-[inset_0_-2px_0_#65a30d,0_1px_2px_rgba(15,23,42,0.08)] dark:aria-pressed:bg-[#141c2b] dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_-2px_0_#a3e635,inset_0_1px_0_rgba(255,255,255,0.08)] text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]";
const STRIP_CELL_CLASS =
  "cockpit-cell min-w-[5.5rem] flex-1 cursor-pointer justify-center transition-colors hover:bg-slate-50 hover:text-slate-950 dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]";
const STRIP_CELL_ACTIVE_CLASS = "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_#65a30d] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#a3e635]";
const STRIP_CLASS = "cockpit-strip tactile-card h-8 w-full gap-0 overflow-x-auto rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const TOOLBAR_CLASS = "cockpit-toolbar tactile-card h-10 w-full overflow-x-auto rounded-[12px] border-slate-200/90 bg-white/95 px-2 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const FEED_CLASS = "tactile-card space-y-1 overflow-hidden rounded-[12px] border-slate-200/90 bg-slate-50/75 p-1 transition-opacity dark:border-white/[0.08] dark:bg-none dark:bg-[#090c12]";
const ROW_CARD_CLASS = "tactile-card tactile-card-interactive overflow-hidden rounded-[8px] border-slate-200/80 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] [&_article]:px-3 [&_article]:py-1.5";

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
      <span className="text-slate-500 dark:text-[#8b97ad]">→</span>
      <span style={{ color: "var(--openbot-diff-after-text)", backgroundColor: "var(--openbot-diff-after-bg)" }} className="rounded px-1">
        {diff.to}
      </span>
    </span>
  );
}

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // Explicit server-backed paging: page resets to 1 whenever the company or a filter changes.
  const [page, setPage] = usePageNumber(`${selectedCompanyId ?? ""}|${category}|${searchQuery.trim()}`);
  const listRef = useRef<HTMLDivElement>(null);
  useScrollToTopOnPageChange(page, listRef);

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: activityPageKey(selectedCompanyId!, page),
    queryFn: () => fetchActivityPage(selectedCompanyId!, pageOffset(page)),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });
  const { items: activityEvents, hasMore } = useMemo(() => splitFetchedPage(data), [data]);

  // Rows can vanish between pages (live updates); never strand the user on an empty trailing page.
  useEffect(() => {
    if (data && !isPlaceholderData && activityEvents.length === 0 && page > 1) setPage(page - 1);
  }, [data, isPlaceholderData, activityEvents.length, page, setPage]);

  // Prefetch the next page so Prev/Next feels instant.
  useEffect(() => {
    if (!selectedCompanyId || !hasMore || isPlaceholderData) return;
    const next = page + 1;
    void queryClient.prefetchQuery({
      queryKey: activityPageKey(selectedCompanyId, next),
      queryFn: () => fetchActivityPage(selectedCompanyId, pageOffset(next)),
      staleTime: NEXT_PAGE_PREFETCH_STALE_MS,
    });
  }, [queryClient, selectedCompanyId, hasMore, isPlaceholderData, page]);
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

  const categoryCounts = useMemo(() => {
    // Counts describe the current server page (PAGE_SIZE rows), not the whole log.
    const counts: Record<ActivityCategory, number> = { all: 0, agent: 0, mission: 0, decision: 0, worktree: 0 };
    for (const event of activityEvents) {
      counts.all += 1;
      const key = categorizeActivityEvent(event);
      if (key) counts[key] += 1;
    }
    return counts;
  }, [activityEvents]);

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
  const filterActive = category !== "all" || searchQuery.trim() !== "";

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 5-cell cockpit strip: event totals per category double as filter shortcuts */}
      <div className={STRIP_CLASS} role="group" aria-label="활동 유형별 건수" title="현재 페이지 기준 건수">
        {CATEGORY_PILLS.map((pill) => {
          const active = category === pill.id;
          return (
            <button
              key={pill.id}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(pill.id)}
              className={cn(STRIP_CELL_CLASS, active && STRIP_CELL_ACTIVE_CLASS)}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${pill.dot}`} />
              <span className="truncate uppercase tracking-wide">{pill.label}</span>
              <b className="ml-1 font-semibold text-slate-950 dark:text-[#edf2fb]">{data ? categoryCounts[pill.id] : "—"}</b>
            </button>
          );
        })}
        <div className={cn(STRIP_CELL_CLASS, "cursor-default")}>
          <span className="truncate uppercase tracking-wide">표시</span>
          <b className="ml-1 text-blue-600 dark:text-[#60a5fa]">{filtered.length}</b>
        </div>
      </div>

      {/* Tight 40px toolbar: category tabs + local search */}
      <div className={TOOLBAR_CLASS}>
        <div role="group" aria-label="활동 유형 필터" className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-slate-100 dark:bg-[#090c12] p-0.5">
          {CATEGORY_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              aria-pressed={category === pill.id}
              onClick={() => setCategory(pill.id)}
              className={TAB_CLASS}
            >
              {pill.label}
              <span className={cn("ml-1 font-mono text-[10px] tabular-nums", category === pill.id ? "text-blue-600 dark:text-[#60a5fa]" : "text-slate-500 dark:text-[#8b97ad]")}>
                {data ? categoryCounts[pill.id] : "—"}
              </span>
            </button>
          ))}
        </div>

        <div className="relative ml-2 min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-[#8b97ad]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="활동 검색…"
            aria-label="활동 검색"
            className="h-7 w-full rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-slate-100 dark:bg-[#090c12] pl-7 pr-2 text-xs text-slate-900 dark:text-[#edf2fb] outline-none placeholder:text-slate-400 dark:placeholder:text-[#8b97ad] focus:border-blue-500 dark:focus:border-[#60a5fa] focus:ring-2 focus:ring-blue-500/20 dark:focus:ring-[#60a5fa]/25"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <CompactPagination page={page} count={filtered.length} hasMore={hasMore} loading={isFetching} onPageChange={setPage} className="rounded-[12px] border-slate-200/90 bg-slate-50/95 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] [&_button]:text-slate-600 dark:[&_button]:text-[#cbd5e1] [&_button:hover]:bg-white dark:[&_button:hover]:bg-[#141b29] [&_span]:text-slate-600 dark:[&_span]:text-[#8b97ad] [&_b]:text-slate-950 dark:[&_b]:text-[#edf2fb] [&_svg]:text-blue-600 dark:[&_svg]:text-[#60a5fa]" />

      {filtered.length === 0 && !isFetching && (
        <EmptyState icon={History} message={filterActive ? "이 페이지에 조건에 맞는 활동이 없습니다." : "No activity yet."} />
      )}

      {filtered.length > 0 && (
        <div
          ref={listRef}
          aria-busy={isFetching}
          className={cn(FEED_CLASS, isFetching && "opacity-70")}
        >
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
            return (
              <div key={event.id} className={ROW_CARD_CLASS}>
                {row}
                {diff && <div className="px-3 pb-1.5 -mt-1"><DiffBadge diff={diff} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import {
  ISSUES_PREFETCH_STALE_MS,
  ISSUES_TOOLBAR_CLASS,
  IssuesPagination,
  hasIssuePageMore,
  issuePageQueryFilters,
  issuePageRequestFilters,
  issueWindowRows,
  prefetchIssuePage,
  useIssuePaging,
} from "../components/IssuesListChrome";
import { CircleDot, Lock } from "lucide-react";

/* ── Cockpit telemetry strip ──
 * One row, four columns. Each cell is both a count and a status-group filter
 * shortcut. `cancelled` is intentionally not surfaced. Dot colors follow the
 * Paperwork telemetry palette (slate / cobalt via --pw-cobalt / amber / calm sage emerald). */
type StatusGroup = "open" | "in_progress" | "blocked" | "completed";

const STATUS_GROUPS: {
  key: StatusGroup;
  label: string;
  statuses: string[];
  dot: string;
  activeAccent: string;
}[] = [
  {
    key: "open",
    label: "Open",
    statuses: ["todo", "backlog"],
    dot: "bg-slate-400 dark:bg-[#8b97ad]",
    activeAccent: "shadow-[inset_0_-2px_0_#64748b] dark:shadow-[inset_0_-2px_0_#8b97ad]",
  },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: ["in_progress", "in_review"],
    dot: "bg-blue-500 dark:bg-[var(--pw-cobalt)] shadow-[0_0_6px_rgba(96,165,250,0.45)]",
    activeAccent: "shadow-[inset_0_-2px_0_var(--pw-cobalt)]",
  },
  {
    key: "blocked",
    label: "Blocked",
    statuses: ["blocked"],
    dot: "bg-amber-500 dark:bg-[#f59e0b] shadow-[0_0_6px_rgba(245,158,11,0.45)]",
    activeAccent: "shadow-[inset_0_-2px_0_#d97706] dark:shadow-[inset_0_-2px_0_#f59e0b]",
  },
  {
    key: "completed",
    label: "Completed",
    statuses: ["done"],
    dot: "bg-emerald-700 dark:bg-emerald-300",
    activeAccent: "shadow-[inset_0_-2px_0_var(--color-emerald-700)] dark:shadow-[inset_0_-2px_0_var(--color-emerald-300)]",
  },
];

/* Server-side status window per tab. Each status group maps to its own server status
 * list (the API accepts a comma-separated set), so a tab's pages are that tab's rows.
 * Archived rows are requested only after an explicit Completed press. */
const statusFilterFor = (group: StatusGroup | null) =>
  group ? STATUS_GROUPS.find((g) => g.key === group)!.statuses.join(",") : ACTIVE_ISSUE_STATUS_FILTER;

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)));
}

/** `j`/`k` step over the visible rows; clamps at both ends and enters from the first/last row. */
function stepSelection(paths: string[], current: string | null, delta: 1 | -1): string | null {
  if (paths.length === 0) return null;
  const index = current ? paths.indexOf(current) : -1;
  if (index === -1) return delta === 1 ? paths[0] : paths[paths.length - 1];
  return paths[Math.min(paths.length - 1, Math.max(0, index + delta))] ?? null;
}

export function Issues() {
  const { selectedCompanyId, canWrite = true, currentRole } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const [activeGroup, setActiveGroup] = useState<StatusGroup | null>(null);
  const [searchActive, setSearchActive] = useState(initialSearch.trim().length > 0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Client-side filters (Filter popover) narrow rows inside IssuesList; while any is active the
  // list leaves paging mode and shows the whole filtered payload, exactly as before.
  const [clientFilterCount, setClientFilterCount] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = useCallback((search: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmedSearch = search.trim();
      // Server-side search bypasses the list prop, so strip shortcuts step aside while it is active.
      setSearchActive(trimmedSearch.length > 0);
      setActiveGroup(null);
      const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
      if (currentSearch === trimmedSearch) return;

      const url = new URL(window.location.href);
      if (trimmedSearch) {
        url.searchParams.set("q", trimmedSearch);
      } else {
        url.searchParams.delete("q");
      }

      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }, 300);
  }, []);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Work",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Work" }]);
  }, [setBreadcrumbs]);

  const statusFilter = statusFilterFor(activeGroup);
  // Server-backed paging only without search or client filters; both bypass the paged `issues` prop.
  const paged = !searchActive && clientFilterCount === 0;
  const paging = useIssuePaging({
    resetKey: `${selectedCompanyId ?? ""}|${activeGroup ?? "all"}|${searchActive}|${clientFilterCount > 0}`,
    scrollTarget: pageRef,
  });
  const { data: issues, isLoading, isFetching, error, isPlaceholderData } = useQuery({
    queryKey: queryKeys.issues.list(
      selectedCompanyId!,
      paged ? issuePageQueryFilters(statusFilter, paging.page) : { status: statusFilter },
    ),
    queryFn: () => issuesApi.list(
      selectedCompanyId!,
      paged ? issuePageRequestFilters(statusFilter, paging.page) : { status: statusFilter },
    ),
    enabled: !!selectedCompanyId && !searchActive, // search results bypass this prop
    placeholderData: keepPreviousData,
    // A prefetched page must not re-fetch the moment Next lands on it; mutations still invalidate.
    staleTime: paged ? ISSUES_PREFETCH_STALE_MS : 0,
  });
  // Keeps the Open / In Progress / Blocked counts correct while Completed shows archived rows.
  const { data: activeIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId,
  });
  // The Completed count needs the whole archived payload; the list itself stays paged.
  const { data: doneIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: statusFilterFor("completed") }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: statusFilterFor("completed") }),
    enabled: !!selectedCompanyId && activeGroup === "completed",
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      // Prefix match covers every status tab and page window of this company's list.
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  // Archived rows exist in cache only once the Completed tab has loaded them.
  const archivedIssues = activeGroup === "completed" ? doneIssues : undefined;
  const groupCounts = useMemo(() => {
    const counts: Record<StatusGroup, number> = { open: 0, in_progress: 0, blocked: 0, completed: 0 };
    for (const issue of [...(activeIssues ?? []), ...(archivedIssues ?? [])]) {
      const group = STATUS_GROUPS.find((g) => g.statuses.includes(issue.status));
      if (group) counts[group.key] += 1;
    }
    return counts;
  }, [activeIssues, archivedIssues]);
  const groupCount = (group: StatusGroup) => {
    const loaded = group === "completed" ? archivedIssues : activeIssues;
    return loaded ? groupCounts[group] : "—";
  };

  const hasMore = paged && hasIssuePageMore(issues);
  const visibleIssues = useMemo(() => {
    // keepPreviousData hands us the previous tab/page's rows while the next loads; show those untouched.
    if (isPlaceholderData || !paged) return issues ?? [];
    return issueWindowRows(issues);
  }, [issues, paged, isPlaceholderData]);
  const listBusy = isFetching && !isLoading;

  const prefetchNext = useCallback(() => {
    if (!selectedCompanyId || !hasMore) return;
    void prefetchIssuePage(queryClient, selectedCompanyId, statusFilter, paging.page + 1);
  }, [queryClient, selectedCompanyId, statusFilter, hasMore, paging.page]);
  // Warm the next page once the current one settles; hover/focus on Next re-checks it cheaply.
  useEffect(() => {
    if (!isLoading && !isFetching) prefetchNext();
  }, [isLoading, isFetching, prefetchNext]);
  useEffect(() => {
    setSelectedPath(null);
  }, [paging.page]);

  const visibleRowPaths = useCallback(() => {
    const root = listRef.current;
    if (!root) return [] as string[];
    return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href^='/issues/']"))
      .map((row) => row.getAttribute("href") ?? "")
      .filter(Boolean);
  }, []);

  // Paint the j/k selection onto the rows owned by IssuesList (it does not know about this highlight).
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLAnchorElement>("a[href^='/issues/']").forEach((row) => {
      if (selectedPath && row.getAttribute("href") === selectedPath) {
        row.setAttribute("data-pw-selected", "true");
        row.scrollIntoView({ block: "nearest" });
      } else {
        row.removeAttribute("data-pw-selected");
      }
    });
  }, [selectedPath, visibleIssues]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) {
        if (event.key === "Escape") {
          const searchInput = listRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search work"]');
          if (searchInput && event.target === searchInput) {
            searchInput.blur();
          }
        }
        return;
      }
      if (event.key === "/") {
        const searchInput = listRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search work"]');
        if (searchInput) {
          event.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
        return;
      }
      if (event.key === "Enter" && selectedPath) {
        event.preventDefault();
        const selectedLink = listRef.current?.querySelector<HTMLAnchorElement>('a[data-pw-selected="true"]');
        if (selectedLink) {
          selectedLink.click();
        } else {
          navigate(selectedPath, { state: issueLinkState });
        }
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const paths = visibleRowPaths();
      if (paths.length === 0) return;
      event.preventDefault();
      setSelectedPath((current) => stepSelection(paths, current, event.key === "j" ? 1 : -1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleRowPaths, selectedPath, navigate, issueLinkState]);

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view work." />;
  }

  return (
    <div ref={pageRef} className="scroll-mt-16 space-y-3 tabular-nums">
      {/* 1-row 4-column Combo 1 tactile telemetry strip: counts double as status-group shortcuts */}
      <div
        className="grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)] sm:grid-cols-4"
        role="group"
        aria-label="Work items by status"
      >
        {STATUS_GROUPS.map((group) => {
          const active = activeGroup === group.key;
          const isLivePulse = group.key === "in_progress" && liveIssueIds.size > 0;
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={active}
              disabled={searchActive}
              title={searchActive ? "Clear the search to filter by status" : group.key === "completed" && !archivedIssues ? "Load done work items" : `Show ${group.label.toLowerCase()} work items`}
              onClick={() => setActiveGroup(active ? null : group.key)}
              className={`flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 px-3 text-xs transition-colors disabled:cursor-default disabled:opacity-60 ${
                active
                  ? `bg-slate-100/90 text-slate-950 dark:bg-[#151d2b] dark:text-[#edf2fb] ${group.activeAccent}`
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"
              }`}
            >
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${group.dot} ${isLivePulse ? "animate-pulse" : ""}`}
              />
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.12em]">{group.label}</span>
              <b className="ml-0.5 font-mono text-xs font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">
                {groupCount(group.key)}
              </b>
              {isLivePulse && (
                <span className="hidden items-center gap-1 rounded-full border border-emerald-700/30 bg-emerald-700/10 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-300/10 dark:text-emerald-300 md:inline-flex">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-700 animate-pulse dark:bg-emerald-300" />
                  {liveIssueIds.size} live
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!canWrite && (
        <div
          role="status"
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#fde68a]"
        >
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>
            Read-only{currentRole ? ` (${currentRole})` : ""} · Member, admin, or owner role required to create or update work items
          </span>
        </div>
      )}

      <div
        ref={listRef}
        data-readonly-work={!canWrite ? "true" : undefined}
        onClickCapture={(event) => {
          if (canWrite) return;
          const button = (event.target as HTMLElement | null)?.closest("button");
          if (!button) return;
          const text = (button.textContent ?? "").trim();
          const isNewWorkBtn = text.includes("New Work") || (text === "" && button.querySelector("svg.lucide-plus"));
          if (isNewWorkBtn) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        className={`${ISSUES_TOOLBAR_CLASS} overflow-hidden rounded-xl border border-slate-200/90 bg-white/95 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-opacity dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] ${listBusy ? "opacity-60" : ""} ${!canWrite ? "[&>div>div:first-child>div:first-child>button:first-child]:cursor-not-allowed [&>div>div:first-child>div:first-child>button:first-child]:opacity-50" : ""}`}
        aria-busy={listBusy}
      >
        <IssuesList
          issues={visibleIssues}
          isLoading={isLoading}
          error={error as Error | null}
          agents={agents}
          projects={projects}
          liveIssueIds={liveIssueIds}
          viewStateKey="paperclip:issues-view"
          issueLinkState={issueLinkState}
          initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
          initialSearch={initialSearch}
          onSearchChange={handleSearchChange}
          onFiltersChange={setClientFilterCount}
          onUpdateIssue={(id, data) => {
            if (!canWrite) return;
            updateIssue.mutate({ id, data });
          }}
        />
      </div>
      {paged && (visibleIssues.length > 0 || paging.page > 1) && (
        <div className="rounded-xl border border-slate-200/90 bg-slate-50/90 px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-background dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <IssuesPagination
            page={paging.page}
            rowCount={visibleIssues.length}
            hasMore={hasMore}
            isFetching={isFetching}
            onPrev={paging.goToPrev}
            onNext={paging.goToNext}
            onPrefetchNext={prefetchNext}
          />
        </div>
      )}
    </div>
  );
}

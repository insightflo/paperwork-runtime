import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
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
import { CircleDot } from "lucide-react";

/* ── Cockpit telemetry strip ──
 * One row, four columns. Each cell is both a count and a status-group filter
 * shortcut. `cancelled` is intentionally not surfaced. Dot colors mirror the
 * approved cockpit palette (--pw-cobalt / --pw-amber / --pw-emerald). */
type StatusGroup = "open" | "in_progress" | "blocked" | "completed";

const STATUS_GROUPS: { key: StatusGroup; label: string; statuses: string[]; dot: string }[] = [
  { key: "open", label: "Open", statuses: ["todo", "backlog"], dot: "bg-[#8b97ad]" },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress", "in_review"], dot: "bg-[#5f8dff]" },
  { key: "blocked", label: "Blocked", statuses: ["blocked"], dot: "bg-[#fbbf24]" },
  { key: "completed", label: "Completed", statuses: ["done"], dot: "bg-[#34d399]" },
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
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
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
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key !== "j" && event.key !== "k") return;
      const paths = visibleRowPaths();
      if (paths.length === 0) return;
      event.preventDefault();
      setSelectedPath((current) => stepSelection(paths, current, event.key === "j" ? 1 : -1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleRowPaths]);

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view work." />;
  }

  return (
    <div ref={pageRef} className="scroll-mt-16 space-y-2 tabular-nums">
      {/* 1-row 4-column cockpit strip: counts double as status-group shortcuts */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Work items by status">
        {STATUS_GROUPS.map((group) => {
          const active = activeGroup === group.key;
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={active}
              disabled={searchActive}
              title={searchActive ? "Clear the search to filter by status" : group.key === "completed" && !archivedIssues ? "Load done work items" : `Show ${group.label.toLowerCase()} work items`}
              onClick={() => setActiveGroup(active ? null : group.key)}
              className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors disabled:cursor-default disabled:opacity-60 ${
                active
                  ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]"
                  : "hover:bg-[#151b28] hover:text-[#e6edf7]"
              }`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.dot}`} />
              <span className="truncate uppercase tracking-wide">{group.label}</span>
              <b className="ml-1">{groupCount(group.key)}</b>
            </button>
          );
        })}
      </div>

      <div
        ref={listRef}
        className={`${ISSUES_TOOLBAR_CLASS} transition-opacity ${listBusy ? "opacity-60" : ""}`}
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
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        />
      </div>
      {paged && (visibleIssues.length > 0 || paging.page > 1) && (
        <IssuesPagination
          page={paging.page}
          rowCount={visibleIssues.length}
          hasMore={hasMore}
          isFetching={isFetching}
          onPrev={paging.goToPrev}
          onNext={paging.goToNext}
          onPrefetchNext={prefetchNext}
        />
      )}
    </div>
  );
}

import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
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

/* ── Restyle hooks for the IssuesList chrome ──
 * The component contract is unchanged; the page-owned wrapper restyles its
 * toolbar and rows. Tailwind only emits candidates that appear verbatim in
 * source, so every selector is spelled out here rather than composed. */
const TOOLBAR_CLASS = [
  // 40px single-row cockpit toolbar
  "[&>div>div:first-child]:h-auto",
  "[&>div>div:first-child]:sm:h-10",
  "[&>div>div:first-child]:rounded-md",
  "[&>div>div:first-child]:border",
  "[&>div>div:first-child]:border-[#242d3f]",
  "[&>div>div:first-child]:bg-[#111622]",
  "[&>div>div:first-child]:py-0",
  "[&>div>div:first-child]:pl-2",
  "[&>div>div:first-child]:pr-1.5",
  // Deep-cobalt "+ New" CTA
  "[&>div>div:first-child>div:first-child>button:first-child]:h-7",
  "[&>div>div:first-child>div:first-child>button:first-child]:rounded-md",
  "[&>div>div:first-child>div:first-child>button:first-child]:border-[#5f8dff]/50",
  "[&>div>div:first-child>div:first-child>button:first-child]:bg-[#2563eb]",
  "[&>div>div:first-child>div:first-child>button:first-child]:font-semibold",
  "[&>div>div:first-child>div:first-child>button:first-child]:text-[#f8fafc]",
  "[&>div>div:first-child>div:first-child>button:first-child]:shadow-[inset_0_0_0_1px_rgba(95,141,255,0.45)]",
  "[&>div>div:first-child>div:first-child>button:first-child]:hover:bg-[#1d4ed8]",
  // Search field
  "[&>div>div:first-child>div:first-child_input]:h-7",
  "[&>div>div:first-child>div:first-child_input]:rounded-md",
  "[&>div>div:first-child>div:first-child_input]:border-[#242d3f]",
  "[&>div>div:first-child>div:first-child_input]:bg-[#0b0e14]",
  "[&>div>div:first-child>div:first-child_input]:text-[#e6edf7]",
  "[&>div>div:first-child>div:first-child_input]:placeholder:text-[#8b97ad]",
  "[&>div>div:first-child>div:first-child_input]:focus-visible:border-[#5f8dff]",
  "[&>div>div:first-child>div:first-child_input]:focus-visible:ring-[#5f8dff]/40",
  // View-mode toggle (list / board) styled as status tabs
  "[&>div>div:first-child>div:last-child>div:first-child]:rounded-md",
  "[&>div>div:first-child>div:last-child>div:first-child]:border-[#242d3f]",
  "[&>div>div:first-child>div:last-child>div:first-child]:bg-[#0b0e14]",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:h-6",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:w-7",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:p-0",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:text-[#8b97ad]",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:hover:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:bg-[#151b28]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:shadow-[inset_0_0_0_1px_#242d3f]",
  // Filter / Sort / Group
  "[&>div>div:first-child>div:last-child>button]:h-7",
  "[&>div>div:first-child>div:last-child>button]:rounded-md",
  "[&>div>div:first-child>div:last-child>button]:text-xs",
  "[&>div>div:first-child>div:last-child>button]:text-[#8b97ad]",
  "[&>div>div:first-child>div:last-child>button]:hover:bg-[#151b28]",
  "[&>div>div:first-child>div:last-child>button]:hover:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>button.text-blue-600]:text-[#5f8dff]",
  // Group headers
  "[&_button[data-state]]:text-[11px]",
  "[&_button[data-state]]:uppercase",
  "[&_button[data-state]]:tracking-[0.08em]",
  "[&_button[data-state]]:text-[#8b97ad]",
  // High-density rows with crisp hairlines
  "[&_[data-state=open]>a[href^='/issues']]:border-[#242d3f]",
  "[&_[data-state=open]>a[href^='/issues']]:sm:py-1.5",
  // j/k selection highlight
  "[&_[data-state=open]>a[data-pw-selected=true]]:bg-[#151b28]",
  "[&_[data-state=open]>a[data-pw-selected=true]]:shadow-[inset_2px_0_0_#5f8dff]",
].join(" ");

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

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  const groupCounts = useMemo(() => {
    const counts: Record<StatusGroup, number> = { open: 0, in_progress: 0, blocked: 0, completed: 0 };
    for (const issue of issues ?? []) {
      const group = STATUS_GROUPS.find((g) => g.statuses.includes(issue.status));
      if (group) counts[group.key] += 1;
    }
    return counts;
  }, [issues]);

  const activeStatuses = STATUS_GROUPS.find((g) => g.key === activeGroup)?.statuses;
  const visibleIssues = useMemo(() => {
    if (!activeStatuses) return issues ?? [];
    return (issues ?? []).filter((issue) => activeStatuses.includes(issue.status));
  }, [issues, activeStatuses]);

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
    <div className="space-y-2 tabular-nums">
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
              title={searchActive ? "Clear the search to filter by status" : `Show ${group.label.toLowerCase()} work items`}
              onClick={() => setActiveGroup(active ? null : group.key)}
              className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors disabled:cursor-default disabled:opacity-60 ${
                active
                  ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]"
                  : "hover:bg-[#151b28] hover:text-[#e6edf7]"
              }`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.dot}`} />
              <span className="truncate uppercase tracking-wide">{group.label}</span>
              <b className="ml-1">{issues ? groupCounts[group.key] : "—"}</b>
            </button>
          );
        })}
      </div>

      <div
        ref={listRef}
        className={TOOLBAR_CLASS}
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
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        />
      </div>
    </div>
  );
}

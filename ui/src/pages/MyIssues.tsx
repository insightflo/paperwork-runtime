import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";
import { ListTodo, Search } from "lucide-react";

/* ── Cockpit summary strip ──
 * Same 1-row / 4-cell shape as the Work page. The 4th cell is the active total
 * because completed/cancelled items never enter the My Work queue. */
type StatusGroup = "open" | "in_progress" | "blocked" | "active";

const STATUS_GROUPS: { key: StatusGroup; label: string; statuses: string[]; dot: string }[] = [
  { key: "open", label: "Open", statuses: ["todo", "backlog"], dot: "bg-slate-400 dark:bg-[#8b97ad]" },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress", "in_review"], dot: "bg-blue-600 dark:bg-[#60a5fa]" },
  { key: "blocked", label: "Blocked", statuses: ["blocked"], dot: "bg-amber-600 dark:bg-[#f59e0b]" },
  { key: "active", label: "Active", statuses: [], dot: "bg-lime-600 dark:bg-[#a3e635]" },
];

const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors text-slate-600 hover:text-slate-900 aria-pressed:bg-blue-600/10 aria-pressed:text-slate-900 aria-pressed:shadow-[inset_0_0_0_1px_rgba(37,99,235,0.28)] dark:text-[#8b97ad] dark:hover:text-[#edf2fb] dark:aria-pressed:bg-[#60a5fa]/12 dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.36)]";
const ROW_CLASS = "h-9 border-slate-200/90 px-3 py-0 transition-colors hover:bg-slate-50 dark:border-white/[0.065] dark:hover:bg-[#141b29]";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeGroup, setActiveGroup] = useState<StatusGroup>("active");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "My Work" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId,
  });

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = useMemo(
    () => (issues ?? []).filter((i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)),
    [issues],
  );

  const groupCounts = useMemo(() => {
    const counts: Record<StatusGroup, number> = { open: 0, in_progress: 0, blocked: 0, active: myIssues.length };
    for (const issue of myIssues) {
      const group = STATUS_GROUPS.find((g) => g.statuses.includes(issue.status));
      if (group) counts[group.key] += 1;
    }
    return counts;
  }, [myIssues]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleIssues = useMemo(() => {
    const statuses = STATUS_GROUPS.find((g) => g.key === activeGroup)?.statuses ?? [];
    return myIssues.filter((issue) => {
      const inGroup = statuses.length === 0 || statuses.includes(issue.status);
      const matchesSearch =
        normalizedSearch.length === 0 ||
        issue.title.toLowerCase().includes(normalizedSearch) ||
        (issue.identifier ?? issue.id).toLowerCase().includes(normalizedSearch);
      return inGroup && matchesSearch;
    });
  }, [myIssues, activeGroup, normalizedSearch]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your work." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-3 tabular-nums">
      {/* 1-row 4-column cockpit summary strip */}
      <div className="cockpit-strip tactile-card w-full gap-0 border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]" role="group" aria-label="My work items by status">
        {STATUS_GROUPS.map((group) => {
          const active = activeGroup === group.key;
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={active}
              onClick={() => setActiveGroup(group.key)}
              className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors ${
                active
                  ? "bg-blue-600/10 text-slate-900 shadow-[inset_0_-1px_0_#2563eb] dark:bg-[#151d2c] dark:text-[#edf2fb] dark:shadow-[inset_0_-1px_0_#60a5fa]"
                  : "hover:bg-slate-100/80 hover:text-slate-900 dark:hover:bg-[#151d2c] dark:hover:text-[#edf2fb]"
              }`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.dot}`} />
              <span className="truncate uppercase tracking-wide">{group.label}</span>
              <b className="ml-1 font-mono">{groupCounts[group.key]}</b>
            </button>
          );
        })}
      </div>

      {/* Tight 40px filter toolbar: status tabs + local search, count pinned right */}
      <div className="cockpit-toolbar tactile-card h-10 rounded-[12px] border-slate-200/90 bg-white/95 px-2 dark:border-white/[0.08] dark:bg-[#0e131d]">
        <div
          role="group"
          aria-label="Filter my work by status"
          className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 bg-slate-50 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]"
        >
          {STATUS_GROUPS.map((group) => (
            <button
              key={group.key}
              type="button"
              aria-pressed={activeGroup === group.key}
              onClick={() => setActiveGroup(group.key)}
              className={TAB_CLASS}
            >
              {group.label}
            </button>
          ))}
        </div>

        <div className="relative ml-2 min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#8b97ad]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my work..."
            aria-label="Search my work"
            className="h-7 w-full rounded-md border border-slate-200/90 bg-white pl-7 pr-2 text-xs text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25"
          />
        </div>

        <span aria-live="polite" aria-atomic="true" className="ml-auto shrink-0 text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
          {visibleIssues.length}
          {normalizedSearch || activeGroup !== "active" ? ` of ${myIssues.length}` : ""} shown
        </span>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No work items assigned to you." />
      )}

      {myIssues.length > 0 && visibleIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No work items match the current filters or search." />
      )}

      {visibleIssues.length > 0 && (
        <div className="tactile-card overflow-hidden rounded-[12px] border-slate-200/90 bg-white/95 tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d]">
          {visibleIssues.map((issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issue.title}
              to={`/issues/${issue.identifier ?? issue.id}`}
              className={ROW_CLASS}
              leading={
                <>
                  <PriorityIcon priority={issue.priority} />
                  <StatusIcon status={issue.status} />
                </>
              }
              trailing={
                <span className="text-xs text-slate-500 tabular-nums dark:text-[#8b97ad]">
                  {formatDate(issue.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

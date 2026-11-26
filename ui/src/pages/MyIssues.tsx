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
  { key: "open", label: "Open", statuses: ["todo", "backlog"], dot: "bg-[#8b97ad]" },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress", "in_review"], dot: "bg-[#5f8dff]" },
  { key: "blocked", label: "Blocked", statuses: ["blocked"], dot: "bg-[#fbbf24]" },
  { key: "active", label: "Active", statuses: [], dot: "bg-[#34d399]" },
];

const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-[#151b28] aria-pressed:text-[#e6edf7] aria-pressed:shadow-[inset_0_0_0_1px_#242d3f] text-[#8b97ad] hover:text-[#e6edf7]";
const ROW_CLASS = "h-9 border-[#242d3f] px-3 py-0 hover:bg-[#1a2131]";

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
    <div className="space-y-2 tabular-nums">
      {/* 1-row 4-column cockpit summary strip */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="My work items by status">
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
                  ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]"
                  : "hover:bg-[#151b28] hover:text-[#e6edf7]"
              }`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.dot}`} />
              <span className="truncate uppercase tracking-wide">{group.label}</span>
              <b className="ml-1">{groupCounts[group.key]}</b>
            </button>
          );
        })}
      </div>

      {/* Tight 40px filter toolbar: status tabs + local search, count pinned right */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div
          role="group"
          aria-label="Filter my work by status"
          className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5"
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
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8b97ad]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my work..."
            aria-label="Search my work"
            className="h-7 w-full rounded-md border border-[#242d3f] bg-[#0b0e14] pl-7 pr-2 text-xs text-[#e6edf7] outline-none placeholder:text-[#8b97ad] focus:border-[#5f8dff] focus:ring-[#5f8dff]/40"
          />
        </div>

        <span className="ml-auto shrink-0 text-[11px] uppercase tracking-[0.16em] text-[#8b97ad]">
          {visibleIssues.length}
          {normalizedSearch || activeGroup !== "active" ? ` of ${myIssues.length}` : ""} shown
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No work items assigned to you." />
      )}

      {myIssues.length > 0 && visibleIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No work items match the current filters or search." />
      )}

      {visibleIssues.length > 0 && (
        <div className="overflow-hidden rounded-md border border-[#242d3f] bg-[#151b28] tabular-nums">
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
                <span className="text-xs text-[#8b97ad] tabular-nums">
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

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PROJECT_STATUSES, type ProjectStatus } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Link } from "@/lib/router";
import { formatDate, projectUrl, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus, Search } from "lucide-react";

type StatusTab = "all" | ProjectStatus;

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: "all", label: "All" },
  ...PROJECT_STATUSES
    .filter((status) => status !== "cancelled")
    .map((status) => ({ value: status, label: status.replace("_", " ") })),
];

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const CONTROL =
  "h-7 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] outline-none focus:border-[#5f8dff] placeholder:text-[#5c6a84]";
const SEGMENT_ACTIVE = "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_0_0_1px_#242d3f]";
const SEGMENT_IDLE = "text-[#8b97ad] hover:text-[#e6edf7]";
/** Explicit column tracks: color + name/description (flexes, truncates) | target | updated | status pill (never wraps). */
const ROW_TRACKS =
  "grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_max-content]";
const LIST_FRAME = "divide-y divide-[#242d3f] border-[#242d3f] bg-[#111622]";

interface StripCellProps {
  label: string;
  value: number;
  active: boolean;
  dot: string;
  title: string;
  onClick: () => void;
}

/** One cell of the 1-row cockpit strip: micro status dot · label · bold tabular count. Doubles as a filter shortcut. */
function StripCell({ label, value, active, dot, title, onClick }: StripCellProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        "cockpit-cell min-w-0 flex-1 justify-center transition-colors",
        active ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]" : "hover:bg-[#151b28] hover:text-[#e6edf7]",
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="ml-1">{value}</b>
    </button>
  );
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const [tab, setTab] = useState<StatusTab>("all");
  const [pausedOnly, setPausedOnly] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Work Contexts" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, 0])) as Record<ProjectStatus, number>;
    let paused = 0;
    for (const project of projects) {
      byStatus[project.status] += 1;
      if (project.pausedAt) paused += 1;
    }
    return { ...byStatus, paused };
  }, [projects]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (tab !== "all" && project.status !== tab) return false;
      if (pausedOnly && !project.pausedAt) return false;
      if (q === "") return true;
      return `${project.name} ${project.description ?? ""}`.toLowerCase().includes(q);
    });
  }, [projects, tab, pausedOnly, query]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view work contexts." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selectTab = (next: StatusTab) => {
    setTab((current) => (current === next ? "all" : next));
    if (next !== "all") setPausedOnly(false);
  };

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: counts double as status-filter shortcuts */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Work contexts by status">
        <StripCell
          label="Total"
          value={projects.length}
          active={tab === "all" && !pausedOnly}
          dot="bg-[#5f8dff]"
          title="Show all work contexts"
          onClick={() => { setTab("all"); setPausedOnly(false); }}
        />
        {STATUS_TABS.flatMap((item) => item.value === "all" ? [] : [item.value]).map((status) => (
          <StripCell
            key={status}
            label={status.replace("_", " ")}
            value={counts[status]}
            active={tab === status && !pausedOnly}
            dot={status === "in_progress" ? "bg-[#34d399]" : status === "completed" ? "bg-[#8b97ad]" : "bg-[#fbbf24]"}
            title={`Show ${status.replace("_", " ")} work contexts`}
            onClick={() => selectTab(status)}
          />
        ))}
        <StripCell
          label="Paused"
          value={counts.paused}
          active={pausedOnly}
          dot={counts.paused > 0 ? "bg-[#f87171]" : "bg-[#4a5670]"}
          title="Show work contexts paused by budget hard stop"
          onClick={() => setPausedOnly((current) => !current)}
        />
      </div>

      {/* Tight single-row 40px toolbar: status tabs · search · count · primary action. */}
      <div className="cockpit-toolbar h-10 w-full rounded-md border border-[#242d3f] bg-[#111622] pl-1.5 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden">
          {isMobile ? (
            <select
              aria-label="Filter work contexts by status"
              value={pausedOnly ? "paused" : tab}
              onChange={(e) => (e.target.value === "paused" ? setPausedOnly(true) : selectTab(e.target.value as StatusTab))}
              className={cn(CONTROL, "shrink-0")}
            >
              {STATUS_TABS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
              <option value="paused">Paused</option>
            </select>
          ) : (
            <div role="group" aria-label="Filter work contexts by status" className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
              {STATUS_TABS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={!pausedOnly && tab === item.value}
                  onClick={() => selectTab(item.value)}
                  className={cn("h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors", !pausedOnly && tab === item.value ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <label className="flex shrink-0 items-center gap-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" aria-hidden />
            <input
              type="search"
              aria-label="Search work contexts"
              placeholder="Search name, description"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(CONTROL, "w-56")}
            />
          </label>
          <span className="hidden shrink-0 text-[11px] text-[#8b97ad] sm:block">
            <span className="font-mono text-[#e6edf7]">{visible.length}</span> of {projects.length}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject} className="h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]">
          <Plus className="h-3.5 w-3.5" />
          Add Work Context
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No work contexts yet."
          action="Add Work Context"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div aria-label="Work contexts" className={cn("overflow-hidden rounded-md border", LIST_FRAME)}>
          <div className={cn(ROW_TRACKS, "h-7 px-3 text-[10.5px] uppercase tracking-[0.08em] text-[#8b97ad]")}>
            <span>Name</span>
            <span className="hidden text-right sm:block">Target</span>
            <span className="hidden text-right sm:block">Updated</span>
            <span className="text-right">Status</span>
          </div>
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[#8b97ad]">
              No work contexts match this filter.
            </div>
          )}
          {visible.map((project) => (
            <Link
              key={project.id}
              to={projectUrl(project)}
              className={cn(ROW_TRACKS, "h-10 px-3 text-sm no-underline text-inherit transition-colors hover:bg-[#151b28]")}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm border border-[#242d3f]" style={{ backgroundColor: project.color ?? "#6366f1" }} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[#e6edf7]">{project.name}</span>
                  {project.description && (
                    <span className="block truncate text-[11px] text-[#8b97ad]">{project.description}</span>
                  )}
                </span>
              </span>
              <span className="hidden text-right text-xs text-[#8b97ad] sm:block">
                {project.targetDate ? formatDate(project.targetDate) : "—"}
              </span>
              <span className="hidden text-right text-xs text-[#8b97ad] sm:block">{formatDate(project.updatedAt)}</span>
              <span className="flex justify-end">
                <StatusBadge status={project.status} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

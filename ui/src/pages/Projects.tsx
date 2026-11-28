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

// Tactile cockpit palette: white/slate light surfaces, #0e131d/#090c12 obsidian dark surfaces, cobalt focus, lime active pulses.
const CONTROL =
  "h-7 rounded-md border border-slate-200/90 bg-white px-2 text-xs text-slate-950 outline-none transition-colors focus:border-[#2563eb] placeholder:text-slate-400 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#eef2f8] dark:focus:border-[#60a5fa] dark:placeholder:text-[#627089]";
const SEGMENT_ACTIVE = "bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.14)] dark:bg-[#151d2e] dark:text-[#eef2f8] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]";
const SEGMENT_IDLE = "text-slate-500 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:text-[#eef2f8]";
/** Explicit column tracks: color + name/description (flexes, truncates) | target | updated | status pill (never wraps). */
const ROW_TRACKS =
  "grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_max-content]";
const LIST_FRAME = "tactile-card divide-y divide-slate-200/80 border-slate-200/90 bg-white dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";

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
        active ? "bg-slate-100 text-slate-950 shadow-[inset_0_-2px_0_#65a30d] dark:bg-[#151d2e] dark:text-[#eef2f8] dark:shadow-[inset_0_-2px_0_#a3e635]" : "hover:bg-slate-50 hover:text-slate-950 dark:hover:bg-white/[0.05] dark:hover:text-[#eef2f8]",
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="ml-1">{value}</b>
    </button>
  );
}

export function Projects() {
  const { selectedCompanyId, canWrite = true } = useCompany();
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
      <div className="cockpit-strip w-full gap-0 border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" role="group" aria-label="Work contexts by status">
        <StripCell
          label="Total"
          value={projects.length}
          active={tab === "all" && !pausedOnly}
          dot="bg-blue-500 dark:bg-[#60a5fa]"
          title="Show all work contexts"
          onClick={() => { setTab("all"); setPausedOnly(false); }}
        />
        {STATUS_TABS.flatMap((item) => item.value === "all" ? [] : [item.value]).map((status) => (
          <StripCell
            key={status}
            label={status.replace("_", " ")}
            value={counts[status]}
            active={tab === status && !pausedOnly}
            dot={status === "in_progress" ? "bg-lime-500 dark:bg-[#a3e635]" : status === "completed" ? "bg-slate-400 dark:bg-[#627089]" : "bg-amber-500 dark:bg-[#f59e0b]"}
            title={`Show ${status.replace("_", " ")} work contexts`}
            onClick={() => selectTab(status)}
          />
        ))}
        <StripCell
          label="Paused"
          value={counts.paused}
          active={pausedOnly}
          dot={counts.paused > 0 ? "bg-rose-500 dark:bg-[#fb7185]" : "bg-slate-300 dark:bg-[#4a5670]"}
          title="Show work contexts paused by budget hard stop"
          onClick={() => setPausedOnly((current) => !current)}
        />
      </div>

      {/* Tight single-row 40px toolbar: status tabs · search · count · primary action. */}
      <div className="cockpit-toolbar h-10 w-full tactile-card border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] pl-1.5 pr-1.5">
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
            <div role="group" aria-label="Filter work contexts by status" className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#090c12] p-0.5">
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
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-[#8f9db3]" aria-hidden />
            <input
              type="search"
              aria-label="Search work contexts"
              placeholder="Search name, description"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(CONTROL, "w-56")}
            />
          </label>
          <span aria-live="polite" className="hidden shrink-0 text-[11px] text-slate-500 dark:text-[#8f9db3] sm:block">
            <span className="font-mono text-slate-950 dark:text-[#eef2f8]">{visible.length}</span> of {projects.length}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject} disabled={!canWrite} title={!canWrite ? "Member, admin, or owner role required to create work contexts" : undefined} className="h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8] disabled:cursor-not-allowed disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" />
          Add Work Context
        </Button>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No work contexts yet."
          action={canWrite ? "Add Work Context" : undefined}
          onAction={canWrite ? openNewProject : undefined}
        />
      )}

      {projects.length > 0 && (
        <div aria-label="Work contexts" className={cn("overflow-hidden", LIST_FRAME)}>
          <div className={cn(ROW_TRACKS, "h-7 px-3 text-[10.5px] uppercase tracking-[0.08em] text-slate-500 dark:text-[#8f9db3]")}>
            <span>Name</span>
            <span className="hidden text-right sm:block">Target</span>
            <span className="hidden text-right sm:block">Updated</span>
            <span className="text-right">Status</span>
          </div>
          {visible.length === 0 && (
            <div aria-live="polite" className="px-3 py-6 text-center text-xs text-slate-500 dark:text-[#8f9db3]">
              No work contexts match this filter.
            </div>
          )}
          {visible.map((project) => (
            <Link
              key={project.id}
              to={projectUrl(project)}
              className={cn(ROW_TRACKS, "h-10 px-3 text-sm no-underline text-inherit transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.05]")}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm border border-slate-200/90 dark:border-white/[0.08]" style={{ backgroundColor: project.color ?? "#6366f1" }} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-950 dark:text-[#eef2f8]">{project.name}</span>
                  {project.description && (
                    <span className="block truncate text-[11px] text-slate-500 dark:text-[#8f9db3]">{project.description}</span>
                  )}
                </span>
              </span>
              <span className="hidden text-right text-xs text-slate-500 dark:text-[#8f9db3] sm:block">
                {project.targetDate ? formatDate(project.targetDate) : "—"}
              </span>
              <span className="hidden text-right text-xs text-slate-500 dark:text-[#8f9db3] sm:block">{formatDate(project.updatedAt)}</span>
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

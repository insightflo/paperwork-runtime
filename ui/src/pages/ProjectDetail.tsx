import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike, type BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectRouteRef, cn, formatCents, formatDate } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "configuration" | "budget";
type ProjectTab = ProjectBaseTab;

const PROJECT_TABS: { value: ProjectTab; path: string; label: string }[] = [
  { value: "list", path: "issues", label: "Work" },
  { value: "overview", path: "overview", label: "Overview" },
  { value: "configuration", path: "configuration", label: "Configuration" },
  { value: "budget", path: "budget", label: "Budget" },
];

// Tactile cockpit palette: white/slate light surfaces, #0e131d/#090c12 obsidian dark surfaces, cobalt focus, lime active pulses.
const SEGMENT_ACTIVE = "bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.14)] dark:bg-[#151d2e] dark:text-[#eef2f8] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]";
const SEGMENT_IDLE = "text-slate-500 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:text-[#eef2f8]";
/** Tactile hairline card with a specular top highlight and obsidian dark surface. */
const HAIRLINE_CARD = "tactile-card min-w-0 border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const HAIRLINE_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8f9db3]";
/** Descendant override so ProjectProperties' inner bordered blocks inherit the hairline card look. */
const HAIRLINE_DESCENDANTS =
  "[&_.rounded-md.border.p-3]:border-slate-200/90 dark:[&_.rounded-md.border.p-3]:border-white/[0.08] [&_.rounded-md.border.p-3]:bg-white dark:[&_.rounded-md.border.p-3]:bg-[#090c12] [&_.rounded-md.border.p-2]:border-slate-200/90 dark:[&_.rounded-md.border.p-2]:border-white/[0.08] [&_.rounded-md.border.p-2]:bg-slate-50 dark:[&_.rounded-md.border.p-2]:bg-[#090c12]";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="cockpit-cell min-w-0 flex-1">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate normal-case tracking-normal">{value}</b>
    </span>
  );
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className={cn(HAIRLINE_CARD, "divide-y divide-slate-200/80 dark:divide-white/[0.07] tabular-nums")}>
      <div className="px-4 py-3">
        <span className={HAIRLINE_LABEL}>Description</span>
        <InlineEditor
          value={project.description ?? ""}
          onSave={(description) => onUpdate({ description })}
          as="p"
          className="mt-1 text-sm text-slate-700 dark:text-[#c9d3e4]"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={imageUploadHandler}
        />
      </div>
      <dl className="grid grid-cols-1 gap-px divide-y divide-slate-200/80 dark:divide-white/[0.07] bg-slate-200/80 dark:bg-white/[0.08] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="bg-slate-50 dark:bg-[#090c12] px-4 py-3">
          <dt className={HAIRLINE_LABEL}>Status</dt>
          <dd className="mt-1.5">
            <StatusBadge status={project.status} />
          </dd>
        </div>
        <div className="bg-slate-50 dark:bg-[#090c12] px-4 py-3">
          <dt className={HAIRLINE_LABEL}>Target Date</dt>
          <dd className="mt-1.5 text-sm text-slate-950 dark:text-[#eef2f8]">{project.targetDate ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change work context color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { openNewIssue } = useDialog();
  const { isMobile } = useSidebar();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const activeTab = activeRouteTab;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Work Context";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive work context" : "Failed to unarchive work context",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Work Contexts", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Work Context" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Work Context",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    const cachedPath = PROJECT_TABS.find((item) => item.value === cachedTab)?.path ?? "issues";
    return <Navigate to={`/projects/${canonicalProjectRef}/${cachedPath}`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;
  const budgetActive = projectBudgetSummary.isActive;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    const path = PROJECT_TABS.find((item) => item.value === tab)?.path ?? "issues";
    navigate(`/projects/${canonicalProjectRef}/${path}`);
  };

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: identity + budget facts at a glance */}
      <div className="cockpit-strip w-full gap-0 border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" role="group" aria-label="Work context summary">
        <StripFact
          label="Status"
          value={project.status.replace("_", " ")}
          dot={project.pausedAt ? "bg-rose-500 dark:bg-[#fb7185]" : project.status === "in_progress" ? "bg-lime-500 dark:bg-[#a3e635]" : "bg-slate-400 dark:bg-[#627089]"}
        />
        <StripFact label="Target" value={project.targetDate ? formatDate(project.targetDate) : "—"} />
        <StripFact label="Spent" value={budgetActive ? formatCents(projectBudgetSummary.observedAmount) : "—"} />
        <StripFact label="Budget" value={budgetActive ? formatCents(projectBudgetSummary.amount) : "—"} />
        <StripFact label="Utilization" value={budgetActive ? `${projectBudgetSummary.utilizationPercent}%` : "—"} />
        <StripFact label="Updated" value={formatDate(project.updatedAt)} />
      </div>

      {/* Tight single-row 40px toolbar: color · name · pause state · tabs · primary action. */}
      <div className="cockpit-toolbar h-10 w-full tactile-card border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">
            <InlineEditor
              value={project.name}
              onSave={(name) => updateProject.mutate({ name })}
              as="span"
              className="text-sm font-semibold text-slate-950 dark:text-[#eef2f8]"
            />
          </h2>
          {project.pauseReason === "budget" ? (
            <div className="inline-flex shrink-0 items-center gap-2 rounded-full border border-rose-300/80 bg-rose-50 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-rose-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
              <span className="h-2 w-2 rounded-full bg-rose-500 dark:bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
        </div>

        {isMobile ? (
          <select
            aria-label="Work context section"
            value={activeTab ?? "list"}
            onChange={(e) => handleTabChange(e.target.value as ProjectTab)}
            className="h-7 shrink-0 rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#090c12] px-2 text-xs text-slate-950 dark:text-[#eef2f8] outline-none focus:border-[#2563eb] dark:focus:border-[#60a5fa]"
          >
            {PROJECT_TABS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        ) : (
          <div role="group" aria-label="Work context section" className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#090c12] p-0.5">
            {PROJECT_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={(activeTab ?? "list") === item.value}
                onClick={() => handleTabChange(item.value)}
                className={cn("h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors", (activeTab ?? "list") === item.value ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {project.id && resolvedCompanyId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openNewIssue({ projectId: project.id })}
            className="h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Work Item
          </Button>
        )}
      </div>

      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "configuration" && (
        <div className={cn("w-full max-w-6xl 2xl:max-w-none", HAIRLINE_CARD, "p-4 tabular-nums", HAIRLINE_DESCENDANTS)}>
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <section aria-label="Work context budget" className={cn("w-full max-w-5xl divide-y divide-slate-200/80 dark:divide-white/[0.07] 2xl:max-w-none [&_.text-red-300]:text-rose-700 dark:[&_.text-red-300]:text-red-300 [&_.text-amber-200]:text-amber-700 dark:[&_.text-amber-200]:text-amber-200 [&_.text-red-100]:text-rose-700 dark:[&_.text-red-100]:text-red-100", HAIRLINE_CARD)}>
          <header className="flex h-9 items-center px-4 text-xs font-semibold text-slate-950 dark:text-[#eef2f8]">
            Budget Policy
            <span className="ml-auto text-[11px] font-normal text-slate-500 dark:text-[#8f9db3]">Lifetime · billed spend</span>
          </header>
          <div className="p-4">
            <BudgetPolicyCard
              summary={projectBudgetSummary}
              variant="plain"
              isSaving={budgetMutation.isPending}
              onSave={(amount) => budgetMutation.mutate(amount)}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

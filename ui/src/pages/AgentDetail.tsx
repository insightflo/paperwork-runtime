import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, Link, Navigate, useBeforeUnload } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentKey,
  type ClaudeLoginResult,
  type AgentPermissionUpdate,
} from "../api/agents";
import { budgetsApi } from "../api/budgets";
import { heartbeatsApi } from "../api/heartbeats";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageTabBar } from "../components/PageTabBar";
import { adapterLabels, roleLabels, help } from "../components/agent-config-primitives";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunButton, PauseResumeButton } from "../components/AgentActionButtons";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  Trash2,
  Plus,
  Key,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  ChevronDown,
  HelpCircle,
  Wrench,
} from "lucide-react";
import { AgentIcon, AgentIconPicker } from "../components/AgentIconPicker";
import {
  isUuidLike,
  type Agent,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type AgentDetail as AgentDetailRecord,
  type BudgetPolicySummary,
  type HeartbeatRun,
  type HeartbeatRunCursor,
  type HeartbeatRunEvent,
  type HeartbeatRunStats,
  type HeartbeatRunSummary,
  type AgentRuntimeState,
  type LiveEvent,
} from "@paperclipai/shared";
import { agentRouteRef } from "../lib/utils";
import { PromptsTab } from "../components/agent-detail/PromptsTab";
import { RunsTab } from "../components/agent-detail/RunViews";
import { AgentOverview } from "../components/agent-detail/AgentOverview";
import { AgentConfigurePage } from "../components/agent-detail/ConfigureViews";
import { AgentSkillsTab } from "../components/agent-detail/AgentSkillsTab";
import { parseAgentDetailView, runMetrics, setsEqual, type AgentDetailView } from "./agent-detail-view-helpers";

// Cockpit status pill tones: active=lime pulse, running/in-progress=cobalt, attention=amber, blocked/failed=crimson.
const PILL_TONE: Record<string, string> = {
  active: "text-lime-700 dark:text-[#a3e635]", running: "text-blue-600 dark:text-[#60a5fa]", in_progress: "text-blue-600 dark:text-[#60a5fa]",
  planning: "text-amber-600 dark:text-[#f59e0b]", paused: "text-amber-600 dark:text-[#f59e0b]", idle: "text-amber-600 dark:text-[#f59e0b]", pending_approval: "text-amber-600 dark:text-[#f59e0b]",
  failed: "text-rose-600 dark:text-[#fb7185]", blocked: "text-rose-600 dark:text-[#fb7185]", cancelled: "text-rose-600 dark:text-[#fb7185]", canceled: "text-rose-600 dark:text-[#fb7185]", terminated: "text-rose-600 dark:text-[#fb7185]", error: "text-rose-600 dark:text-[#fb7185]",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-slate-200/90 bg-white px-2 text-[10.5px] font-semibold capitalize shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${PILL_TONE[status.toLowerCase()] ?? "text-slate-500 dark:text-[#8f9db3]"}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const EMPTY_HEARTBEAT_RUN_SUMMARIES: HeartbeatRunSummary[] = [];

export function AgentDetail() {
  const { companyPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const activeView = urlRunId ? "runs" as AgentDetailView : parseAgentDetailView(urlTab ?? null);
  const needsDashboardData = activeView === "dashboard";
  const needsRunData = activeView === "runs" || Boolean(urlRunId);
  const shouldLoadHeartbeats = needsDashboardData || needsRunData;
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);

  const { data: agent, isLoading, error } = useQuery<AgentDetailRecord>({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const agentLookupRef = agent?.id ?? routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? routeAgentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId) && needsDashboardData,
  });

  const { data: runStats } = useQuery({
    queryKey: queryKeys.heartbeatStats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.stats(resolvedCompanyId!, { agentId: agent?.id, days: 14 }),
    enabled: !!resolvedCompanyId && !!agent?.id && needsDashboardData,
  });

  const { data: runPage } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.page(resolvedCompanyId!, { agentId: agent?.id, limit: 100 }),
    enabled: !!resolvedCompanyId && !!agent?.id && shouldLoadHeartbeats,
  });

  const latestRunId = runPage?.items[0]?.id ?? null;
  const { data: latestRunDetail } = useQuery({
    queryKey: queryKeys.runDetail(latestRunId ?? "__none__"),
    queryFn: () => heartbeatsApi.get(latestRunId!),
    enabled: !!latestRunId && needsDashboardData,
  });

  const { data: mobileLiveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(resolvedCompanyId!, agent?.id),
    queryFn: () => heartbeatsApi.liveRunsForCompany(resolvedCompanyId!, undefined, agent?.id),
    enabled: !!resolvedCompanyId && !!agent?.id,
    refetchInterval: 15_000,
  });

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(resolvedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!resolvedCompanyId && needsDashboardData,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && needsDashboardData,
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const assignedIssues = (allIssues ?? [])
    .filter((i) => i.assigneeAgentId === agent?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const agentBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "agent" && policy.scopeId === (agent?.id ?? routeAgentRef),
    );
    if (matched) return matched;
    const budgetMonthlyCents = agent?.budgetMonthlyCents ?? 0;
    const spentMonthlyCents = agent?.spentMonthlyCents ?? 0;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "agent",
      scopeId: agent?.id ?? routeAgentRef,
      scopeName: agent?.name ?? "Agent",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: budgetMonthlyCents,
      observedAmount: spentMonthlyCents,
      remainingAmount: Math.max(0, budgetMonthlyCents - spentMonthlyCents),
      utilizationPercent:
        budgetMonthlyCents > 0 ? Number(((spentMonthlyCents / budgetMonthlyCents) * 100).toFixed(2)) : 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: budgetMonthlyCents > 0,
      status: budgetMonthlyCents > 0 && spentMonthlyCents >= budgetMonthlyCents ? "hard_stop" : "ok",
      paused: agent?.status === "paused",
      pauseReason: agent?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [agent, budgetOverview?.policies, resolvedCompanyId, routeAgentRef]);
  const mobileLiveRun = useMemo(
    () => (mobileLiveRuns ?? []).find((r) => r.status === "running" || r.status === "queued") ?? null,
    [mobileLiveRuns],
  );

  useEffect(() => {
    if (!agent) return;
    if (urlRunId) {
      if (routeAgentRef !== canonicalAgentRef) {
        navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      }
      return;
    }
    const canonicalTab =
      activeView === "instructions"
        ? "instructions"
        : activeView === "configuration"
          ? "configuration"
          : activeView === "skills"
            ? "skills"
            : activeView === "runs"
              ? "runs"
              : activeView === "budget"
                ? "budget"
              : "dashboard";
    if (routeAgentRef !== canonicalAgentRef || urlTab !== canonicalTab) {
      navigate(`/agents/${canonicalAgentRef}/${canonicalTab}`, { replace: true });
      return;
    }
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, activeView, navigate]);

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "terminate") => {
      if (!agentLookupRef) return Promise.reject(new Error("No agent reference"));
      switch (action) {
        case "invoke": return agentsApi.invoke(agentLookupRef, resolvedCompanyId ?? undefined);
        case "pause": return agentsApi.pause(agentLookupRef, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agentLookupRef, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
        if (agent?.id) {
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
        }
      }
      if (action === "invoke" && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "agent",
        scopeId: agent?.id ?? routeAgentRef,
        amount,
        windowKind: "calendar_month_utc",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const resetTaskSession = useMutation({
    mutationFn: (taskKey: string | null) =>
      agentsApi.resetSession(agentLookupRef, taskKey, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reset session");
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (permissions: AgentPermissionUpdate) =>
      agentsApi.updatePermissions(agentLookupRef, permissions, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [{ label: "Agents", href: "/agents" }];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    // Sub-view crumb label; views absent here (dashboard, skills — TODO: bring back later) fall through to "Dashboard".
    const viewCrumb: Partial<Record<AgentDetailView, string>> = { instructions: "Instructions", configuration: "Configuration", runs: "Runs", budget: "Budget" };
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else if (urlRunId) {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/dashboard` }, { label: "Runs", href: `/agents/${canonicalAgentRef}/runs` }, { label: `Run ${urlRunId.slice(0, 8)}` });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/dashboard` }, { label: viewCrumb[activeView] ?? "Dashboard" });
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useBeforeUnload(
    useCallback((event) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }, [configDirty]),
  );

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  if (!urlRunId && !urlTab) {
    return <Navigate to={`/agents/${canonicalAgentRef}/dashboard`} replace />;
  }
  const isPendingApproval = agent.status === "pending_approval";
  const showConfigActionBar = (activeView === "configuration" || activeView === "instructions") && (configDirty || configSaving);
  const metricLabel = "text-[10px] uppercase tracking-[0.08em]";
  // Visible (non-subscription) cost of the loaded run page; dashboard-only queries render "—" until loaded.
  const runsCost = (runPage?.items ?? []).reduce((sum, run) => sum + runMetrics(run).cost, 0);
  const liveRunCount = (mobileLiveRuns ?? []).filter((r) => r.status === "running" || r.status === "queued").length;
  const budget = agentBudgetSummary;

  return (
    <div className={cn("space-y-3 tabular-nums", activeView === "dashboard" && "[&_h3]:text-[11px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:text-muted-foreground", "[&_.border.rounded-lg]:rounded-xl [&_.border.rounded-lg.border-border]:border-slate-200/90 dark:[&_.border.rounded-lg.border-border]:border-white/[0.08] [&_.border.rounded-lg.border-border]:bg-white dark:[&_.border.rounded-lg.border-border]:bg-[#0e131d] [&_.border.rounded-lg.border-border]:shadow-[inset_0_1px_0_var(--pw-specular)] [&_a.border.rounded-lg:hover]:bg-slate-50 dark:[&_a.border.rounded-lg:hover]:bg-white/[0.05] [&_.text-red-300]:text-rose-700 dark:[&_.text-red-300]:text-red-300 [&_.text-amber-200]:text-amber-700 dark:[&_.text-amber-200]:text-amber-200 [&_.text-emerald-200]:text-lime-700 dark:[&_.text-emerald-200]:text-[#a3e635] [&_.text-red-100]:text-rose-700 dark:[&_.text-red-100]:text-red-100", isMobile && showConfigActionBar && "pb-24")}>
      {/* 48px detail header — full-bleed inside <main> padding, sticky within the desktop scroll container. */}
      <header className="-mx-4 -mt-4 flex h-12 items-center gap-2 border-b border-slate-200/90 bg-white/95 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12]/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] md:sticky md:top-0 md:z-10 md:-mx-6 md:-mt-6 md:px-6">
        <nav aria-label="Agent breadcrumb" className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-slate-500 dark:text-[#8f9db3]">
          <Link to="/agents" className="hidden shrink-0 hover:text-slate-950 dark:hover:text-[#eef2f8] sm:inline">Agents</Link>
          <span aria-hidden className="hidden shrink-0 text-[#4a5670] sm:inline">/</span>
          <span className="shrink-0 font-mono tabular-nums">{agent.id.slice(0, 8)}</span>
        </nav>
        <AgentIconPicker value={agent.icon} onChange={(icon) => updateIcon.mutate(icon)}>
          <button type="button" title="Change agent icon" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-50 dark:bg-[#090c12] transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.08]">
            <AgentIcon icon={agent.icon} className="h-5 w-5" />
          </button>
        </AgentIconPicker>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-tight text-slate-950 dark:text-[#eef2f8]">{agent.name}</h2>
          <p className="truncate text-[11px] leading-tight text-slate-500 dark:text-[#8f9db3]">
            {roleLabels[agent.role] ?? agent.role}{agent.title ? ` · ${agent.title}` : ""}
          </p>
        </div>
        <StatusPill status={agent.status} />
        {mobileLiveRun && (
          <Link to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`} title="Open live run"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-lime-500/30 dark:border-[#a3e635]/30 bg-lime-500/10 dark:bg-[#a3e635]/10 px-2 py-0.5 no-underline transition-colors hover:bg-lime-500/15 dark:hover:bg-[#a3e635]/15 sm:hidden">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-lime-500 opacity-75 dark:bg-[#a3e635]" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-lime-500 dark:bg-[#a3e635]" />
            </span>
            <span className="text-[11px] font-semibold text-lime-700 dark:text-[#a3e635]">Live</span>
          </Link>
        )}
        {/* Tight action cluster: every button is 28px so the whole bar stays exactly 48px. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 [&_button]:h-7 [&_button]:px-2 [&_button]:text-xs">
          <Button size="sm" className="shrink-0 bg-[#2563eb] font-semibold text-[#f8fafc] hover:bg-[#1d4ed8]"
            onClick={() => openNewIssue({ assigneeAgentId: agent.id })}>
            <Plus className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Assign Work</span>
          </Button>
          <RunButton
            onClick={() => agentAction.mutate("invoke")}
            disabled={agentAction.isPending || isPendingApproval}
            label="Run Heartbeat"
          />
          <PauseResumeButton
            isPaused={agent.status === "paused"}
            onPause={() => agentAction.mutate("pause")}
            onResume={() => agentAction.mutate("resume")}
            disabled={agentAction.isPending || isPendingApproval}
          />
          {/* Overflow menu */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs"><MoreHorizontal className="h-4 w-4" /></Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                onClick={() => { navigator.clipboard.writeText(agent.id); setMoreOpen(false); }}>
                <Copy className="h-3 w-3" />
                Copy Agent ID
              </button>
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                onClick={() => { resetTaskSession.mutate(null); setMoreOpen(false); }}>
                <RotateCcw className="h-3 w-3" />
                Reset Sessions
              </button>
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive hover:bg-accent/50"
                onClick={() => { agentAction.mutate("terminate"); setMoreOpen(false); }}>
                <Trash2 className="h-3 w-3" />
                Terminate
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* 1-row key-metric summary strip (dashboard-only queries render "—" until loaded; secondary cells fold below sm). */}
      <div className="cockpit-strip w-full gap-0 overflow-hidden border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" role="group" aria-label="Agent summary">
        <span className="cockpit-cell min-w-0"><span className={metricLabel}>Runs 14d</span><b>{runStats?.total ?? "—"}</b></span>
        <span className="cockpit-cell"><span className={metricLabel}>Cost</span><b>{runPage ? `$${runsCost.toFixed(4)}` : "—"}</b></span>
        <span className="cockpit-cell"><span className={metricLabel}>Live</span><b className={liveRunCount ? "text-lime-700 dark:text-[#a3e635]" : undefined}>{liveRunCount}</b></span>
        <span className="cockpit-cell"><span className={metricLabel}>Budget</span><b>{usd(budget.observedAmount)}</b>{budget.amount > 0 ? `${usd(budget.amount)} · ${budget.utilizationPercent}%` : "no cap"}</span>
        <span className="cockpit-cell hidden sm:inline-flex"><span className={metricLabel}>Assigned</span><b>{allIssues ? assignedIssues.length : "—"}</b></span>
        <span className="cockpit-cell hidden sm:inline-flex"><span className={metricLabel}>Reports</span><b>{allAgents ? directReports.length : "—"}</b></span>
        {reportsToAgent && <span className="cockpit-cell hidden min-w-0 sm:inline-flex"><span className={metricLabel}>Reports to</span><b className="truncate" title={reportsToAgent.name}>{reportsToAgent.name}</b></span>}
      </div>

      {!urlRunId && (
        <Tabs
          value={activeView}
          onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
        >
          {/* 32px cockpit toolbar with hairline tabs. */}
          <div className="cockpit-toolbar h-auto min-h-8 flex-wrap py-1">
          <PageTabBar
            items={[
              { value: "dashboard", label: "Dashboard" },
              { value: "instructions", label: "Instructions" },
              { value: "skills", label: "Skills" },
              { value: "configuration", label: "Configuration" },
              { value: "runs", label: "Runs" },
              { value: "budget", label: "Budget" },
            ]}
            value={activeView}
            onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
          />
          </div>
        </Tabs>
      )}

      {actionError && <p role="alert" className="whitespace-pre-wrap font-mono text-xs text-destructive">{actionError}</p>}
      {isPendingApproval && (
        <p className="text-sm text-amber-500">
          This agent is pending board approval and cannot be invoked yet.
        </p>
      )}

      {/* Floating Save/Cancel (desktop) */}
      {!isMobile && (
        <div
          className={cn(
            "sticky top-6 z-10 float-right transition-opacity duration-150",
            showConfigActionBar
              ? "opacity-100"
              : "opacity-0 pointer-events-none"
          )}
        >
          <div className="tactile-card flex items-center gap-2 border-slate-200/90 bg-white/95 px-3 py-1.5 backdrop-blur-sm dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]/95">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/90 bg-white/95 backdrop-blur-sm dark:border-white/[0.08] dark:bg-[#090c12]/95">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* View content */}
      {activeView === "dashboard" && (
        <AgentOverview
          agent={agent}
          runs={runPage?.items ?? EMPTY_HEARTBEAT_RUN_SUMMARIES}
          latestRunDetail={latestRunDetail ?? null}
          runStats={runStats}
          assignedIssues={assignedIssues}
          runtimeState={runtimeState}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
        />
      )}

      {activeView === "instructions" && (
        <PromptsTab
          agent={agent}
          companyId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {activeView === "configuration" && (
        <AgentConfigurePage
          agent={agent}
          agentId={agent.id}
          companyId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
          updatePermissions={updatePermissions}
        />
      )}

      {activeView === "skills" && (
        <AgentSkillsTab
          agent={agent}
          companyId={resolvedCompanyId ?? undefined}
        />
      )}

      {activeView === "runs" && (
        <RunsTab
          initialRuns={runPage?.items ?? EMPTY_HEARTBEAT_RUN_SUMMARIES}
          nextCursor={runPage?.nextCursor ?? null}
          companyId={resolvedCompanyId!}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          selectedRunId={urlRunId ?? null}
          adapterType={agent.adapterType}
        />
      )}

      {activeView === "budget" && resolvedCompanyId ? (
        <div className="w-full max-w-5xl 2xl:max-w-none">
          <BudgetPolicyCard
            summary={agentBudgetSummary}
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
            variant="plain"
          />
        </div>
      ) : null}
    </div>
  );
}

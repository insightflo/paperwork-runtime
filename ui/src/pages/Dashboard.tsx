import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { dashboardApi, type DashboardTelemetryWindow } from "../api/dashboard";
import { costsApi } from "../api/costs";
import { activityApi } from "../api/activity";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { missionsApi } from "../api/missions";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { formatCents, relativeTime } from "../lib/utils";
import { Bot, ChevronDown, ChevronRight, LayoutDashboard, Rocket } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { HarnessDiagnosisCard } from "../components/HarnessDiagnosisCard";
import { HarnessProposalsCard } from "../components/HarnessProposalsCard";
import { DashboardCommandHeader } from "../components/DashboardCommandHeader";
import { ActionRequiredStrip } from "../components/ActionRequiredStrip";
import { FleetHealthCard } from "../components/FleetHealthCard";
import { BudgetBurnCard } from "../components/BudgetBurnCard";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { RadialVelocityGauge } from "../components/dashboard/RadialVelocityGauge";
import { HealthAndQuotaPanel } from "../components/dashboard/HealthAndQuotaPanel";
import { TokenFlowChart } from "../components/dashboard/TokenFlowChart";
import { UsageTreemap } from "../components/dashboard/UsageTreemap";
import { LiveSessionsTable, type LiveSessionRow } from "../components/dashboard/LiveSessionsTable";
import { DgateMonitorPanel } from "../components/dashboard/DgateMonitorPanel";
import { PageSkeleton } from "../components/PageSkeleton";
import type { ActivityEvent, Agent, DashboardSummary, Issue } from "@paperclipai/shared";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

const COCKPIT_RUNS_QUERY_KEY_SUFFIX = "dashboard";

function isLiveRun(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

/** Bucket timestamps into per-day counts, oldest first. */
function countPerDay(items: { createdAt: Date | string }[], days: number): number[] {
  const buckets = Array.from({ length: days }, () => 0);
  const now = Date.now();
  for (const item of items) {
    const ageDays = Math.floor((now - new Date(item.createdAt).getTime()) / 86_400_000);
    if (ageDays >= 0 && ageDays < days) buckets[days - 1 - ageDays] += 1;
  }
  return buckets;
}

/** Compact elapsed time for in-flight runs, e.g. "<1m", "4m", "2h 05m", "3d". */
function elapsedLabel(from: Date | string): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(from).getTime()) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Mini inline trend line. Rendered in-flow inside the card header row. */
function Sparkline({ points, label }: { points: number[]; label: string }) {
  const width = 56;
  const height = 16;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const coords = points.map((point, index) => {
    const x = points.length > 1 ? (index / (points.length - 1)) * width : 0;
    const y = max === min ? height / 2 : height - 1 - ((point - min) / (max - min)) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 text-primary" role="img" aria-label={label}>
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TelemetryCell({
  label,
  value,
  sub,
  to,
  spark,
}: {
  label: string;
  value: string | number;
  sub: string;
  to: string;
  spark?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="block min-w-0 px-3.5 py-2.5 no-underline text-inherit transition-colors hover:bg-slate-50/90 dark:hover:bg-[#141b2a]"
    >
      {/* Header row: label left, sparkline right. Both are in normal flow on this row,
          so the sparkline can never overlap the subtext rendered below. */}
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#9aa7bd]">{label}</p>
        {spark && <span className="hidden shrink-0 sm:inline-flex">{spark}</span>}
      </div>
      <p className="mt-1 font-mono text-2xl font-semibold leading-none tracking-tight tabular-nums text-slate-950 dark:text-[#eef2f8]">{value}</p>
      <p className="mt-1 truncate text-[11px] text-slate-500 tabular-nums dark:text-[#627089]">{sub}</p>
    </Link>
  );
}

function LiveRunRow({ run, issue }: { run: LiveRunForIssue; issue?: Issue }) {
  const live = isLiveRun(run);
  return (
    <Link
      to={`/agents/${run.agentId}/runs/${run.id}`}
      className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6.5rem] items-center gap-3 border-b border-slate-200/70 px-3 py-1.5 text-xs no-underline text-inherit transition-colors hover:bg-slate-50/90 dark:border-white/[0.06] dark:hover:bg-[#141b2a]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 dark:bg-emerald-400" />}
          <span
            className={live || run.status === "succeeded"
              ? "relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
              : run.status === "failed" || run.status === "timed_out"
                ? "relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500 dark:bg-red-400"
                : "relative inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground/50"}
          />
        </span>
        <span className="min-w-0 truncate font-medium">{run.agentName}</span>
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {issue ? `${issue.identifier ?? issue.id.slice(0, 8)} · ${issue.title}` : "No linked work"}
      </span>
      <span className="text-right font-mono text-muted-foreground tabular-nums">
        {live ? `live ${elapsedLabel(run.startedAt ?? run.createdAt)}` : relativeTime(run.finishedAt ?? run.createdAt)}
      </span>
    </Link>
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const [telemetryWindow, setTelemetryWindow] = useState<DashboardTelemetryWindow>("6h");
  const [bottomTab, setBottomTab] = useState<"sessions" | "dgate">("sessions");
  const [showOperationsDetails, setShowOperationsDetails] = useState(true);
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: missions } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!),
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: runStats } = useQuery({
    queryKey: queryKeys.heartbeatStats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.stats(selectedCompanyId!, { days: 14 }),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  // Shares the cache entry that ActiveAgentsPanel already reads, so the
  // cockpit timeline adds no extra request.
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), COCKPIT_RUNS_QUERY_KEY_SUFFIX],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, 4),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const { data: telemetry, isLoading: telemetryLoading } = useQuery({
    queryKey: ["dashboard", selectedCompanyId, "telemetry", telemetryWindow],
    queryFn: () => dashboardApi.telemetry(selectedCompanyId!, telemetryWindow),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });

  const { data: dgate, isLoading: dgateLoading } = useQuery({
    queryKey: ["dashboard", selectedCompanyId, "dgate"],
    queryFn: () => dashboardApi.dgate(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const { data: quotaWindows, isLoading: quotasLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(selectedCompanyId!),
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const recentIssues = useMemo(() => (issues ? getRecentIssues(issues) : []), [issues]);
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    void selectedCompanyId;
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

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

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const liveSessionRows = useMemo<LiveSessionRow[]>(() => {
    const raw = telemetry?.liveSessions ?? [];
    return raw.map((session) => ({
      ...session,
      issueTitle: session.issueId ? issueById.get(session.issueId)?.title ?? null : null,
    }));
  }, [telemetry?.liveSessions, issueById]);

  const activeSessionCount = useMemo(
    () =>
      liveSessionRows.filter((s) => {
        const st = s.status.toLowerCase();
        return st === "running" || st === "queued" || st === "in_progress" || st === "active";
      }).length,
    [liveSessionRows],
  );
  const dgateActiveWorkers = dgate?.available && dgate.snapshot ? dgate.snapshot.mapped_count : 0;

  const activeMissions = missions?.filter((m) => m.status === "active").length ?? 0;
  const missionCreatedPerDay = useMemo(() => countPerDay(missions ?? [], 14), [missions]);
  const agentList = agents ?? [];

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperwork. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-4 tabular-nums">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {data && (
        <>
          {/* Control tower: urgent actions → 1top × dgate live telemetry → operations details. */}
          <ActionRequiredStrip data={data} agents={agents} issues={issues} />

          {/* Row 1: Radial Velocity Gauge (4 cols) + System Health & Provider Quotas (8 cols) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12" data-testid="dashboard-1top-row1">
            <RadialVelocityGauge
              className="lg:col-span-4"
              tokensPerHour={telemetry?.velocity.tokensPerHour ?? 0}
              peakTokensPerHour={telemetry?.velocity.peakTokensPerHour ?? 0}
              totalTokens={telemetry?.velocity.totalTokens ?? 0}
              avgTokensPerBucket={telemetry?.velocity.avgTokensPerBucket ?? 0}
              activeWorkers={telemetry?.host.activeRuns ?? data.agents.running}
              hostLabel={telemetry?.host.hostname ?? null}
              loading={telemetryLoading && !telemetry}
            />
            <HealthAndQuotaPanel
              className="lg:col-span-8"
              window={telemetryWindow}
              onWindowChange={setTelemetryWindow}
              host={telemetry?.host ?? null}
              dgate={dgate ?? null}
              quotas={quotaWindows}
              loading={telemetryLoading && !telemetry}
              quotasLoading={quotasLoading && !quotaWindows}
            />
          </div>

          {/* Row 2: Token Flow Stacked Bar Chart (8 cols) + Usage Treemap (4 cols) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12" data-testid="dashboard-1top-row2">
            <TokenFlowChart
              className="lg:col-span-8"
              buckets={telemetry?.buckets ?? []}
              models={telemetry?.models ?? []}
              avgTokensPerBucket={telemetry?.velocity.avgTokensPerBucket ?? 0}
              window={telemetryWindow}
              loading={telemetryLoading && !telemetry}
            />
            <UsageTreemap
              className="lg:col-span-4"
              projectShares={telemetry?.projectShares ?? []}
              agentShares={telemetry?.agentShares ?? []}
              loading={telemetryLoading && !telemetry}
            />
          </div>

          {/* Row 3: Tabbed Live Sessions Table / dgate Web Monitor */}
          <section className="space-y-2" data-testid="dashboard-1top-row3" aria-label="실시간 세션 및 dgate 모니터">
            <div
              role="tablist"
              aria-label="실시간 모니터링 탭"
              className="tactile-card inline-flex items-center gap-1 rounded-[10px] border border-slate-200/90 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-[#07090d] dark:bg-none"
            >
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "sessions"}
                onClick={() => setBottomTab("sessions")}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  bottomTab === "sessions"
                    ? "bg-white text-slate-950 shadow-sm ring-1 ring-[#84cc16]/40 dark:bg-[#151d2e] dark:text-[#eef2f8]"
                    : "text-slate-600 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]"
                }`}
              >
                <span>실행 중인 세션</span>
                <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
                  {activeSessionCount}/{liveSessionRows.length}
                </span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "dgate"}
                onClick={() => setBottomTab("dgate")}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  bottomTab === "dgate"
                    ? "bg-white text-slate-950 shadow-sm ring-1 ring-[#60a5fa]/45 dark:bg-[#151d2e] dark:text-[#eef2f8]"
                    : "text-slate-600 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    dgate?.available
                      ? "bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.8)]"
                      : "bg-muted-foreground/50"
                  }`}
                />
                <span>dgate 웹 모니터</span>
                <span className="rounded-full border border-slate-200/90 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#9aa7bd]">
                  {dgate?.available ? `${dgateActiveWorkers} active` : "offline"}
                </span>
              </button>
            </div>

            {bottomTab === "sessions" ? (
              <LiveSessionsTable
                sessions={liveSessionRows}
                loading={telemetryLoading && !telemetry}
              />
            ) : (
              <DgateMonitorPanel
                dgate={dgate ?? null}
                loading={dgateLoading && !dgate}
              />
            )}
          </section>

          {/* Collapsible Papercompany Operations, Missions, Work & Fleet Details */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowOperationsDetails((prev) => !prev)}
              aria-expanded={showOperationsDetails}
              className="tactile-card tactile-card-interactive flex w-full cursor-pointer items-center justify-between rounded-[12px] border border-slate-200/90 bg-white px-3.5 py-2.5 text-left text-xs font-semibold text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] hover:text-slate-950 dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#9aa7bd] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)] dark:hover:text-[#eef2f8]"
            >
              <span className="inline-flex items-center gap-1.5">
                {showOperationsDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                운영 상세 · 미션 · 워크플로 · 에이전트 플릿
              </span>
              <span className="font-mono text-[10px] font-normal tabular-nums text-slate-500 dark:text-[#627089]">
                {activeMissions} active missions · {data.tasks.inProgress} in progress · {formatCents(data.costs.monthSpendCents)} MTD
              </span>
            </button>
          </div>

          {showOperationsDetails && (
            <div className="space-y-4">
              <div
                data-testid="dashboard-telemetry"
                className="tactile-card grid grid-cols-2 lg:grid-cols-4 divide-x divide-slate-200/80 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] [&>:nth-child(2)]:border-e-0 [&>:nth-child(n+3)]:border-t [&>:nth-child(n+3)]:border-slate-200/80 lg:[&>:nth-child(2)]:border-e lg:[&>:nth-child(n+3)]:border-t-0 dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)] dark:[&>:nth-child(n+3)]:border-white/[0.07]"
              >
                <TelemetryCell
                  label="Agents"
                  to="/agents"
                  value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
                  sub={`${data.agents.running} running · ${data.agents.paused} paused · ${data.agents.error} error`}
                />
                <TelemetryCell
                  label="Work in progress"
                  to="/issues"
                  value={data.tasks.inProgress}
                  sub={`${data.tasks.open} open · ${data.tasks.blocked} blocked`}
                />
                <TelemetryCell
                  label="Active missions"
                  to="/missions"
                  value={activeMissions}
                  sub={`${missions?.length ?? 0} total missions`}
                  spark={missionCreatedPerDay.some((count) => count > 0) ? <Sparkline points={missionCreatedPerDay} label="Missions created per day, last 14 days" /> : undefined}
                />
                <TelemetryCell
                  label="Month spend"
                  to="/costs"
                  value={formatCents(data.costs.monthSpendCents)}
                  sub={data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
                <section
                  className="tactile-card flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]"
                  aria-label="Live execution and recent activity"
                >
                  <header className="flex items-center justify-between gap-3 border-b border-slate-200/80 px-3.5 py-2.5 dark:border-white/[0.07]">
                    <h3 className="text-xs font-semibold">Live execution</h3>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums dark:text-[#9aa7bd]">
                      {liveRuns?.length ?? 0} runs · {liveRuns?.filter(isLiveRun).length ?? 0} live
                    </span>
                  </header>
                  {/* Explicit tracks: the agent and work-item columns each own a
                      minmax(0,…) track and truncate, so they can never overlap. */}
                  <div className="hidden grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6.5rem] gap-3 border-b border-slate-200/80 bg-slate-50/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:grid dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#627089]" aria-hidden="true">
                    <span>Agent</span>
                    <span>Work item</span>
                    <span className="text-right">Started</span>
                  </div>
                  <div>
                    {liveRuns && liveRuns.length > 0 ? (
                      liveRuns.map((run) => <LiveRunRow key={run.id} run={run} issue={run.issueId ? issueById.get(run.issueId) : undefined} />)
                    ) : (
                      <p className="border-b border-slate-200/70 px-3.5 py-3 text-sm text-slate-500 dark:border-white/[0.06] dark:text-[#9aa7bd]">No recent agent runs.</p>
                    )}
                  </div>
                  <h4 className="border-b border-slate-200/80 bg-slate-50/80 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-[#9aa7bd]">
                    Recent activity
                  </h4>
                  <div className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
                    {recentActivity.length === 0 ? (
                      <p className="px-3.5 py-3 text-sm text-slate-500 dark:text-[#9aa7bd]">No activity yet.</p>
                    ) : (
                      recentActivity.map((event: ActivityEvent) => (
                        <ActivityRow
                          key={event.id}
                          event={event}
                          agentMap={agentMap}
                          entityNameMap={entityNameMap}
                          entityTitleMap={entityTitleMap}
                          className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                        />
                      ))
                    )}
                  </div>
                </section>

                <div className="flex min-w-0 flex-col gap-4">
                  <FleetHealthCard agents={agentList} />
                  <BudgetBurnCard
                    agents={agentList}
                    monthSpendCents={data.costs.monthSpendCents}
                    monthBudgetCents={data.costs.monthBudgetCents}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      <HarnessDiagnosisCard companyId={selectedCompanyId} />

      <HarnessProposalsCard companyId={selectedCompanyId} />

      {data && (
        <DashboardCommandHeader
          companyId={selectedCompanyId!}
          kpis={{
            runningAgents: data.agents.running,
            enabledAgents: data.agents.active + data.agents.running + data.agents.paused + data.agents.error,
            inProgressTasks: data.tasks.inProgress,
            blockedTasks: data.tasks.blocked,
            activeMissions,
            monthSpendCents: data.costs.monthSpendCents,
            monthBudgetCents: data.costs.monthBudgetCents,
            waitCount: data.pendingApprovals + data.budgets.pendingApprovals,
          }}
        />
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>div]:rounded-[12px] [&>div]:border [&>div]:border-slate-200/90 [&>div]:bg-white [&>div]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:[&>div]:border-white/[0.08] dark:[&>div]:bg-[#0e131d] dark:[&>div]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart runs={runStats?.days ?? []} />
            </ChartCard>
            <ChartCard title="Work by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Work by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart runs={runStats?.days ?? []} />
            </ChartCard>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Missions */}
            {missions && missions.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#9aa7bd] mb-3">
                  Recent Missions
                </h3>
                <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 divide-y divide-slate-200/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#eef2f8] dark:divide-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
                  {[...missions]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .slice(0, 5)
                    .map((mission) => (
                      <Link
                        key={mission.id}
                        to={`/missions/${mission.id}`}
                        className="px-4 py-3 text-sm cursor-pointer hover:bg-slate-50/90 dark:hover:bg-[#141b2a] transition-colors no-underline text-inherit block"
                      >
                        <div className="flex items-center gap-3">
                          <Rocket className="h-4 w-4 shrink-0 text-slate-400 dark:text-[#627089]" />
                          <span className="flex-1 truncate">{mission.title}</span>
                          <StatusBadge status={mission.status} />
                        </div>
                      </Link>
                    ))}
                </div>
              </div>
            )}

            <div className="min-w-0">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#9aa7bd] mb-3">
                  Recent Work
              </h3>
              {recentIssues.length === 0 ? (
                <div className="tactile-card rounded-[12px] border border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
                  <p className="text-sm text-slate-500 dark:text-[#9aa7bd]">No work yet.</p>
                </div>
              ) : (
                <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 divide-y divide-slate-200/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#eef2f8] dark:divide-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-slate-50/90 dark:hover:bg-[#141b2a] transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><PriorityIcon priority={issue.priority} /></span>
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}

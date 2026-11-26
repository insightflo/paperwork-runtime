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
import { agentUrl, formatCents, relativeTime } from "../lib/utils";
import { Bot, ChevronDown, ChevronRight, LayoutDashboard, Rocket } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { HarnessDiagnosisCard } from "../components/HarnessDiagnosisCard";
import { HarnessProposalsCard } from "../components/HarnessProposalsCard";
import { DashboardCommandHeader } from "../components/DashboardCommandHeader";
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
      className="block min-w-0 border-[#242d3f] bg-card px-3 py-2.5 no-underline text-inherit transition-colors hover:bg-accent/60"
    >
      {/* Header row: label left, sparkline right. Both are in normal flow on this row,
          so the sparkline can never overlap the subtext rendered below. */}
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {spark && <span className="hidden shrink-0 sm:inline-flex">{spark}</span>}
      </div>
      <p className="mt-1 text-2xl font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground tabular-nums">{sub}</p>
    </Link>
  );
}

const ACTION_CHIP = "inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 truncate rounded-md border border-border bg-background px-2 text-xs no-underline text-inherit transition-colors hover:bg-accent";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Inline strip for anything waiting on the operator. Shown only when non-empty. */
function ActionRequiredStrip({ data, agents, issues }: { data: DashboardSummary; agents?: Agent[]; issues?: Issue[] }) {
  const approvals = data.pendingApprovals + data.budgets.pendingApprovals;
  const erroredAgents = (agents ?? []).filter((agent) => agent.status === "error");
  const blockedIssues = issues
    ? issues.filter((issue) => issue.status === "blocked").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : [];
  const chips: ReactNode[] = [];

  if (approvals > 0) {
    chips.push(
      <Link key="approvals" to="/approvals" className={ACTION_CHIP} title={`${plural(approvals, "approval")} waiting`}>
        <span className="font-mono font-semibold text-amber-600 tabular-nums dark:text-amber-300">{approvals}</span>
        <span className="truncate">{approvals === 1 ? "approval waiting" : "approvals waiting"}</span>
      </Link>,
    );
  }
  if (data.budgets.activeIncidents > 0) {
    chips.push(
      <Link key="incidents" to="/costs" className={ACTION_CHIP} title={`Budget incidents · ${plural(data.budgets.pausedProjects, "work context")} paused`}>
        <span className="font-mono font-semibold text-red-600 tabular-nums dark:text-red-300">{data.budgets.activeIncidents}</span>
        <span className="truncate">budget {data.budgets.activeIncidents === 1 ? "incident" : "incidents"} · {plural(data.budgets.pausedAgents, "agent")} paused{data.budgets.pausedProjects > 0 ? ` · ${plural(data.budgets.pausedProjects, "context")}` : ""}</span>
      </Link>,
    );
  }
  for (const agent of erroredAgents.slice(0, 2)) {
    chips.push(
      <Link key={`agent:${agent.id}`} to={agentUrl(agent)} className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-red-600 dark:text-red-300">error</span>
        <span className="truncate">{agent.name}</span>
      </Link>,
    );
  }
  if (erroredAgents.length === 0 && data.agents.error > 0) {
    chips.push(
      <Link key="agent-errors" to="/agents" className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-red-600 tabular-nums dark:text-red-300">{data.agents.error}</span>
        <span className="truncate">{data.agents.error === 1 ? "agent has" : "agents have"} errors</span>
      </Link>,
    );
  }
  for (const issue of blockedIssues.slice(0, 3)) {
    chips.push(
      <Link key={`issue:${issue.id}`} to={`/issues/${issue.identifier ?? issue.id}`} className={ACTION_CHIP} title={issue.title}>
        <span className="font-mono font-semibold text-amber-600 dark:text-amber-300">{issue.identifier ?? issue.id.slice(0, 8)}</span>
        <span className="truncate">{issue.title}</span>
      </Link>,
    );
  }
  if (blockedIssues.length > 3 || (!issues && data.tasks.blocked > 0)) {
    const more = issues ? blockedIssues.length - 3 : data.tasks.blocked;
    chips.push(
      <Link key="blocked" to="/issues" className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-amber-600 tabular-nums dark:text-amber-300">{more}</span>
        <span className="truncate">blocked {more === 1 ? "work" : "work items"}</span>
      </Link>,
    );
  }
  if (chips.length === 0) return null;

  return (
    <section
      aria-label="Action required"
      data-testid="dashboard-action-required"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2"
    >
      <span className="inline-flex shrink-0 items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60 dark:bg-amber-400" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        </span>
        Action required
      </span>
      {chips}
      <Link to="/inbox" className="ml-auto shrink-0 text-xs font-medium text-foreground underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-200">
        Review in Inbox →
      </Link>
    </section>
  );
}

function LiveRunRow({ run, issue }: { run: LiveRunForIssue; issue?: Issue }) {
  const live = isLiveRun(run);
  return (
    <Link
      to={`/agents/${run.agentId}/runs/${run.id}`}
      className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6.5rem] items-center gap-3 border-b border-border/60 px-3 py-1.5 text-xs no-underline text-inherit transition-colors hover:bg-accent/40"
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

const AGENT_HEALTH_ORDER: Record<string, number> = { error: 0, running: 1, paused: 2, active: 3, idle: 3 };

function utilization(spent: number, budget: number): number | null {
  if (budget <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((spent / budget) * 100)));
}

function utilizationTone(percent: number): string {
  if (percent >= 100) return "bg-red-500 dark:bg-red-400";
  if (percent >= 80) return "bg-amber-500 dark:bg-amber-400";
  return "bg-primary";
}

function FleetHealthCard({ agents }: { agents: Agent[] }) {
  const ranked = [...agents].sort((a, b) => {
    const order = (AGENT_HEALTH_ORDER[a.status] ?? 4) - (AGENT_HEALTH_ORDER[b.status] ?? 4);
    return order !== 0 ? order : (b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0) - (a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0);
  });
  const counts = { running: 0, idle: 0, paused: 0, error: 0 };
  for (const agent of agents) {
    if (agent.status === "running") counts.running += 1;
    else if (agent.status === "active" || agent.status === "idle") counts.idle += 1;
    else if (agent.status === "paused") counts.paused += 1;
    else if (agent.status === "error") counts.error += 1;
  }
  return (
    <section className="@container min-w-0 rounded-lg border border-border" aria-label="Agent fleet health">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold">Agent fleet health</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {counts.running} running · {counts.idle} idle · {counts.paused} paused · {counts.error} error
        </span>
      </header>
      {ranked.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No agents yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {ranked.slice(0, 8).map((agent) => {
            const percent = utilization(agent.spentMonthlyCents, agent.budgetMonthlyCents);
            const dot = agent.status === "error" ? "bg-red-500 dark:bg-red-400" : agent.status === "running" ? "bg-emerald-500 dark:bg-emerald-400" : agent.status === "paused" ? "bg-amber-500 dark:bg-amber-400" : "bg-muted-foreground/50";
            return (
              <li key={agent.id}>
                <Link
                  to={agentUrl(agent)}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs no-underline text-inherit transition-colors hover:bg-accent/40 @[19rem]:grid-cols-[minmax(0,1fr)_4.5rem_5rem]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </span>
                  {/* Narrow columns: the bar drops to its own full-width row so the
                      agent name keeps the width. Wide: single row like the mockup. */}
                  <span className="col-span-2 row-start-2 h-1.5 overflow-hidden rounded-sm border border-border bg-background @[19rem]:col-span-1 @[19rem]:col-start-2 @[19rem]:row-start-1" aria-hidden="true">
                    <span className={`block h-full rounded-sm ${percent === null ? "bg-transparent" : utilizationTone(percent)}`} style={{ width: `${percent ?? 0}%` }} />
                  </span>
                  <span className="col-start-2 row-start-1 truncate text-right text-muted-foreground @[19rem]:col-start-3">
                    {percent === null ? agent.status : `${percent}% · ${agent.status}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {ranked.length > 8 && (
        <Link to="/agents" className="block border-t border-border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:text-foreground">
          +{ranked.length - 8} more agents
        </Link>
      )}
    </section>
  );
}

function BudgetBurnCard({ agents, monthSpendCents, monthBudgetCents }: { agents: Agent[]; monthSpendCents: number; monthBudgetCents: number }) {
  const spenders = agents
    .filter((agent) => agent.spentMonthlyCents > 0)
    .sort((a, b) => b.spentMonthlyCents - a.spentMonthlyCents)
    .slice(0, 6);
  const maxSpend = spenders[0]?.spentMonthlyCents ?? 0;
  const companyPercent = utilization(monthSpendCents, monthBudgetCents);
  return (
    <section className="min-w-0 rounded-lg border border-border" aria-label="Budget burn">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold">Budget burn by agent</h3>
        <span className="text-[11px] text-muted-foreground">This month</span>
      </header>
      {spenders.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No agent spend recorded this month.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {spenders.map((agent) => {
            const share = monthSpendCents > 0 ? Math.round((agent.spentMonthlyCents / monthSpendCents) * 100) : 0;
            const percent = utilization(agent.spentMonthlyCents, agent.budgetMonthlyCents);
            return (
              <li key={agent.id} className="px-3 py-1.5">
                <Link to={agentUrl(agent)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs no-underline text-inherit hover:text-foreground">
                  <span className="min-w-0 truncate">{agent.name}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-mono font-semibold">{formatCents(agent.spentMonthlyCents)}</span>
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{share}%</span>
                  </span>
                </Link>
                <div className="mt-1 h-1.5 overflow-hidden rounded-sm border border-border bg-background" aria-hidden="true">
                  <div className="h-full rounded-sm bg-primary" style={{ width: `${maxSpend > 0 ? (agent.spentMonthlyCents / maxSpend) * 100 : 0}%` }} />
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                  {percent === null ? "No monthly cap" : `${percent}% of ${formatCents(agent.budgetMonthlyCents)} cap`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="border-t border-border px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Total month to date</span>
          <span className="font-mono font-semibold tabular-nums">{formatCents(monthSpendCents)}</span>
        </div>
        {companyPercent !== null && (
          <>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm border border-border bg-background" aria-hidden="true">
              <div className={`h-full rounded-sm ${utilizationTone(companyPercent)}`} style={{ width: `${companyPercent}%` }} />
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{companyPercent}% of {formatCents(monthBudgetCents)} budget</p>
          </>
        )}
      </footer>
    </section>
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
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 dark:border-[#242d3f] dark:bg-[#0b0e14]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={bottomTab === "sessions"}
                onClick={() => setBottomTab("sessions")}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  bottomTab === "sessions"
                    ? "bg-background text-foreground shadow-sm ring-1 ring-[#84cc16]/40 dark:bg-[#171f2e]"
                    : "text-muted-foreground hover:text-foreground"
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
                    ? "bg-background text-foreground shadow-sm ring-1 ring-[#5f8dff]/45 dark:bg-[#171f2e]"
                    : "text-muted-foreground hover:text-foreground"
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
                <span className="rounded-full border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums dark:border-[#242d3f] dark:bg-[#151b28]">
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
              className="flex w-full items-center justify-between rounded-lg border border-border bg-card/70 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground dark:border-[#242d3f]"
            >
              <span className="inline-flex items-center gap-1.5">
                {showOperationsDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                운영 상세 · 미션 · 워크플로 · 에이전트 플릿
              </span>
              <span className="font-mono text-[10px] font-normal">
                {activeMissions} active missions · {data.tasks.inProgress} in progress · {formatCents(data.costs.monthSpendCents)} MTD
              </span>
            </button>
          </div>

          {showOperationsDetails && (
            <div className="space-y-4">
              <div
                data-testid="dashboard-telemetry"
                className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-[#242d3f] overflow-hidden rounded-lg border border-border [&>:nth-child(2)]:border-e-0 [&>:nth-child(n+3)]:border-t lg:[&>:nth-child(2)]:border-e lg:[&>:nth-child(n+3)]:border-t-0"
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
                <section className="flex min-w-0 flex-col rounded-lg border border-border" aria-label="Live execution and recent activity">
                  <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                    <h3 className="text-xs font-semibold">Live execution</h3>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {liveRuns?.length ?? 0} runs · {liveRuns?.filter(isLiveRun).length ?? 0} live
                    </span>
                  </header>
                  {/* Explicit tracks: the agent and work-item columns each own a
                      minmax(0,…) track and truncate, so they can never overlap. */}
                  <div className="hidden grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6.5rem] gap-3 border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground sm:grid" aria-hidden="true">
                    <span>Agent</span>
                    <span>Work item</span>
                    <span className="text-right">Started</span>
                  </div>
                  <div>
                    {liveRuns && liveRuns.length > 0 ? (
                      liveRuns.map((run) => <LiveRunRow key={run.id} run={run} issue={run.issueId ? issueById.get(run.issueId) : undefined} />)
                    ) : (
                      <p className="border-b border-border px-3 py-3 text-sm text-muted-foreground">No recent agent runs.</p>
                    )}
                  </div>
                  <h4 className="border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Recent activity
                  </h4>
                  <div className="divide-y divide-border/60">
                    {recentActivity.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">No activity yet.</p>
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
          <div className="grid grid-cols-2 gap-4 [&>div]:rounded-md [&>div]:border [&>div]:border-border/80 [&>div]:bg-card/60">
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
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Recent Missions
                </h3>
                <div className="rounded-md border border-border/80 bg-card/60 divide-y divide-border/60 overflow-hidden">
                  {[...missions]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .slice(0, 5)
                    .map((mission) => (
                      <Link
                        key={mission.id}
                        to={`/missions/${mission.id}`}
                        className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                      >
                        <div className="flex items-center gap-3">
                          <Rocket className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">{mission.title}</span>
                          <StatusBadge status={mission.status} />
                        </div>
                      </Link>
                    ))}
                </div>
              </div>
            )}

            <div className="min-w-0">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Recent Work
              </h3>
              {recentIssues.length === 0 ? (
                <div className="rounded-md border border-border/80 bg-card/60 p-4">
                  <p className="text-sm text-muted-foreground">No work yet.</p>
                </div>
              ) : (
                <div className="rounded-md border border-border/80 bg-card/60 divide-y divide-border/60 overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
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

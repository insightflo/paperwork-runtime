import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { dashboardApi, type DashboardTelemetryWindow } from "../api/dashboard";
import { costsApi } from "../api/costs";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { missionsApi } from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { Bot, LayoutDashboard, Rocket } from "lucide-react";
import { HarnessDiagnosisCard } from "../components/HarnessDiagnosisCard";
import { HarnessProposalsCard } from "../components/HarnessProposalsCard";
import { ActionRequiredStrip } from "../components/ActionRequiredStrip";
import { RadialVelocityGauge } from "../components/dashboard/RadialVelocityGauge";
import { HealthAndQuotaPanel } from "../components/dashboard/HealthAndQuotaPanel";
import { TokenFlowChart } from "../components/dashboard/TokenFlowChart";
import { UsageTreemap } from "../components/dashboard/UsageTreemap";
import { LiveSessionsTable, type LiveSessionRow } from "../components/dashboard/LiveSessionsTable";
import { DgateMonitorPanel } from "../components/dashboard/DgateMonitorPanel";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Issue } from "@paperclipai/shared";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [telemetryWindow, setTelemetryWindow] = useState<DashboardTelemetryWindow>("6h");
  const [bottomTab, setBottomTab] = useState<"sessions" | "dgate">("sessions");

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
  const controlPlaneSummary = dgate?.summary ?? dgate?.snapshot?.summary;
  const controlPlaneActiveWorkers =
    controlPlaneSummary?.activeRuns ??
    controlPlaneSummary?.runningWorkers ??
    dgate?.snapshot?.mapped_count ??
    0;
  const controlPlanePendingGates =
    controlPlaneSummary?.pendingGates ??
    ((controlPlaneSummary?.pendingApprovals ?? 0) +
      (controlPlaneSummary?.pendingDecisions ?? 0) +
      (controlPlaneSummary?.pendingWorktreeProposals ?? 0) +
      (controlPlaneSummary?.openBudgetIncidents ?? 0));

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

          {/* Row 3: Tabbed Live Sessions Table / Internal Control & Execution Monitor */}
          <section className="space-y-2" data-testid="dashboard-1top-row3" aria-label="실시간 세션 및 내부 통제 관제">
            <div
              role="tablist"
              aria-label="실시간 모니터링 탭"
              className="tactile-card inline-flex items-center gap-1 rounded-[10px] border border-slate-200/90 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-background dark:bg-none"
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
                    ? "bg-white text-slate-950 shadow-sm ring-1 ring-[var(--pw-cobalt)]/45 dark:bg-[#151d2e] dark:text-[#eef2f8]"
                    : "text-slate-600 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    controlPlanePendingGates > 0
                      ? "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.8)]"
                      : "bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.8)]"
                  }`}
                />
                <span>내부 통제 · 실행 관제</span>
                <span className="rounded-full border border-slate-200/90 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 tabular-nums dark:border-white/[0.08] dark:bg-card dark:text-[#9aa7bd]">
                  {controlPlanePendingGates > 0
                    ? `${controlPlaneActiveWorkers} active · ${controlPlanePendingGates} gate`
                    : `${controlPlaneActiveWorkers} active`}
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
        </>
      )}

      <HarnessDiagnosisCard companyId={selectedCompanyId} />

      <HarnessProposalsCard companyId={selectedCompanyId} />

      {data && (
        <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Missions */}
            {missions && missions.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#9aa7bd] mb-3">
                  최근 미션
                </h3>
                <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 divide-y divide-slate-200/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:text-[#eef2f8] dark:divide-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
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
                  최근 작업
              </h3>
              {recentIssues.length === 0 ? (
                <div className="tactile-card rounded-[12px] border border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
                  <p className="text-sm text-slate-500 dark:text-[#9aa7bd]">아직 작업이 없습니다.</p>
                </div>
              ) : (
                <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 divide-y divide-slate-200/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:text-[#eef2f8] dark:divide-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
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
      )}
    </div>
  );
}

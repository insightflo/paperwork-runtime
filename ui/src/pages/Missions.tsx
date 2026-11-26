import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  missionsApi,
  type MissionListFilters,
  type MissionStatus,
  type MissionWorkflowRun,
  type MissionWorkflowStep,
} from "../api/missions";
import { agentsApi } from "../api/agents";
import { api } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { INSPECTOR_TOGGLE_EVENT } from "../components/PropertiesPanel";
import { normalizeQueueItems, queueItemLabel } from "../components/QueuePanel";
import {
  Inbox, MessageSquare, PanelRightOpen, Plus, RefreshCw, Rocket, ShieldCheck, UserRoundCheck, X,
} from "lucide-react";

const STATUS_TABS: { label: string; value: MissionStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Planning", value: "planning" },
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
];
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const SORT_OPTIONS = [
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "createdAt:desc", label: "Recently created" },
  { value: "title:asc", label: "Title A-Z" },
  { value: "title:desc", label: "Title Z-A" },
  { value: "status:asc", label: "Status" },
] as const;

// Dark control-cockpit palette (mirrors the approved Linear+Datadog mockup).
const DOT = {
  emerald: "bg-[#34d399]", cobalt: "bg-[#5f8dff]", amber: "bg-[#fbbf24]",
  crimson: "bg-[#f87171]", muted: "bg-[#4a5670]",
} as const;
const STEP_DOT: Record<MissionWorkflowStep["status"], string> = {
  completed: DOT.emerald, running: DOT.cobalt, failed: DOT.crimson, skipped: DOT.muted, pending: DOT.muted,
};
const CONTROL_CLASS =
  "h-7 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] outline-none focus:border-[#5f8dff]";
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto_8rem_10rem]";
const PILL_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:brightness-110";
const PILL_STYLE = {
  backgroundColor: "var(--openbot-surface-25d-raised)",
  borderColor: "var(--openbot-surface-25d-border)",
  color: "var(--openbot-text-secondary)",
};
const QUICK_LINKS = [
  { icon: UserRoundCheck, label: "결정함", to: "/human-operator" },
  { icon: ShieldCheck, label: "Hermit Gate · 실행 규칙", to: "/worktree/rules" },
  { icon: MessageSquare, label: "채널 협업 보드", to: "/channels" },
];

function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(date));
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDefaultCreatedFrom(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateInputValue(date);
}

/** Latest workflow run for the preview pane, preferring a run that is still pending/running. */
function pickPreviewRun(runs: MissionWorkflowRun[] | undefined): MissionWorkflowRun | null {
  if (!runs?.length) return null;
  const latest = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return latest.find((run) => run.status === "running" || run.status === "pending") ?? latest[0];
}

/** `j`/`k` step over the visible rows; clamps at both ends and enters from the first/last row. */
function stepSelection(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index === -1) return delta === 1 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)));
}

function count(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function KpiCell(props: { to: string; label: string; value: string; sub: string; dot: string }) {
  return (
    <Link to={props.to} className="flex min-w-0 flex-col gap-0.5 px-3 py-2 no-underline text-inherit transition-colors hover:bg-[#151b28]">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[#8b97ad]">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${props.dot}`} />
        <span className="truncate">{props.label}</span>
      </span>
      <span className="truncate text-xl font-semibold leading-tight tabular-nums text-[#e6edf7]">{props.value}</span>
      <span className="truncate text-[11px] tabular-nums text-[#8b97ad]">{props.sub}</span>
    </Link>
  );
}

function ToolbarField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex shrink-0 items-center gap-1.5 text-xs text-[#8b97ad]"><span>{label}</span>{children}</label>;
}

export function Missions() {
  const { selectedCompanyId } = useCompany();
  const { openNewMission } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const statusFilter = (searchParams.get("status") as MissionStatus | null) ?? "all";
  const ownerAgentId = searchParams.get("ownerAgentId") ?? "all";
  const sortBy = (searchParams.get("sortBy") as MissionListFilters["sortBy"]) ?? "updatedAt";
  const sortOrder = (searchParams.get("sortOrder") as MissionListFilters["sortOrder"]) ?? "desc";
  const from = searchParams.get("from") ?? getDefaultCreatedFrom();
  const to = searchParams.get("to") ?? "";
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 25);
  const page = parsePositiveInt(searchParams.get("page"), 1);

  useEffect(() => {
    setBreadcrumbs([{ label: "Missions" }]);
  }, [setBreadcrumbs]);

  const missionFilters = useMemo<MissionListFilters>(
    () => ({
      status: statusFilter !== "all" ? statusFilter : undefined,
      ownerAgentId: ownerAgentId !== "all" ? ownerAgentId : undefined,
      from: from || undefined,
      to: to || undefined,
      sortBy,
      sortOrder,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    [from, ownerAgentId, page, pageSize, sortBy, sortOrder, statusFilter, to],
  );

  const {
    data: missions, isLoading, isFetching: isMissionsFetching, error, refetch: refetchMissions,
  } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!, missionFilters),
    queryFn: () => missionsApi.list(selectedCompanyId!, missionFilters),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Live cockpit telemetry. Shares cache keys with the dashboard command header.
  const { data: summary, isError: summaryError } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const { data: allMissions, isError: allMissionsError } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!),
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const { data: pending, isError: pendingError } = useQuery({
    queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending"),
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending", 50),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: queueRaw, isError: queueError } = useQuery({
    queryKey: ["ops-console-queue", selectedCompanyId!],
    queryFn: () => api.get<unknown>(`/companies/${selectedCompanyId}/ops-console/queue`),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
    retry: false,
  });

  // Split-inspector preview: workflow runs of the selected mission only.
  const selectedMission = useMemo(
    () => missions?.find((mission) => mission.id === previewId) ?? null,
    [missions, previewId],
  );
  const { data: previewRuns, isLoading: previewLoading } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(previewId ?? ""),
    queryFn: () => missionsApi.listWorkflowRuns(previewId!),
    enabled: Boolean(selectedCompanyId) && inspectorOpen && Boolean(selectedMission),
  });
  const previewRun = useMemo(() => pickPreviewRun(previewRuns), [previewRuns]);
  const totalSteps = previewRun?.progress.totalSteps ?? 0;
  const completedSteps = previewRun?.progress.completedSteps ?? 0;
  const steps = previewRun?.steps ?? [];
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  const agentMap = agents ? Object.fromEntries(agents.map((a) => [a.id, a.name])) : {};
  const hasPreviousPage = page > 1;
  const hasNextPage = (missions?.length ?? 0) >= pageSize;
  const currentSortValue = `${sortBy}:${sortOrder}`;
  const refreshCurrentTab = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    void refetchMissions();
  };

  const updateSearchParams = (
    updates: Record<string, string | null>,
    options?: { resetPage?: boolean },
  ) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (!value || value === "all") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }

    if (options?.resetPage) {
      params.delete("page");
    }

    setSearchParams(params);
  };

  const previewMission = useCallback((id: string | null) => {
    setPreviewId(id);
    setInspectorOpen(true);
  }, []);
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      previewMission(stepSelection(missions?.map((mission) => mission.id) ?? [], previewId, delta));
    },
    [missions, previewId, previewMission],
  );

  // j/k move the preview across rows; Esc closes the preview while focus is inside it or on a row.
  useEffect(() => {
    if (!missions?.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        moveSelection(event.key === "j" ? 1 : -1);
      } else if (
        event.key === "Escape" &&
        inspectorOpen &&
        (event.target as Element | null)?.closest?.("[data-mission-preview],[data-mission-row]")
      ) {
        setInspectorOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpen, missions, moveSelection]);

  const countByStatus = (status: MissionStatus) =>
    (allMissions ?? []).filter((mission) => mission.status === status).length;
  const queueItems = useMemo(() => normalizeQueueItems(queueRaw), [queueRaw]);
  const pendingCards = useMemo(() => pending?.data ?? [], [pending]);
  const waitsLoaded = pending !== undefined || queueRaw !== undefined;
  const waitCount = pendingCards.length + queueItems.length;
  const waitChips = [
    ...pendingCards.slice(0, 6).map((card) => ({
      id: `decision-${card.id}`, kind: "Decision", label: card.title, to: "/human-operator",
    })),
    ...queueItems.slice(0, 6).map((item) => ({
      id: `queue-${item.id}`, kind: "Queued", label: queueItemLabel(item), to: "/worktree/rules",
    })),
  ];

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a company to view missions." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const hasSummary = Boolean(summary);
  const loadState = (failed: boolean) => (failed ? "Load failed" : "Loading");
  const spendBudgetCents = summary?.costs.monthBudgetCents ?? 0;
  const spendPct = summary && spendBudgetCents > 0
    ? Math.round((summary.costs.monthSpendCents / spendBudgetCents) * 100)
    : 0;
  const activeMissions = allMissions ? countByStatus("active") : null;
  const kpis = [
    {
      to: "/agents", label: "Active agents",
      value: summary ? String(summary.agents.running) : "—",
      sub: summary
        ? `${summary.agents.active + summary.agents.running + summary.agents.paused + summary.agents.error} enabled`
        : loadState(summaryError),
      dot: summary && summary.agents.running > 0 ? DOT.emerald : DOT.muted,
    },
    {
      to: "/issues", label: "Running work",
      value: summary ? String(summary.tasks.inProgress) : "—",
      sub: summary ? `${summary.tasks.blocked} blocked` : loadState(summaryError),
      dot: summary?.tasks.blocked ? DOT.amber : summary?.tasks.inProgress ? DOT.emerald : DOT.muted,
    },
    {
      to: "/missions", label: "Active missions",
      value: activeMissions === null ? "—" : String(activeMissions),
      sub: activeMissions === null
        ? loadState(allMissionsError)
        : `${countByStatus("planning")} planning · ${countByStatus("paused")} paused`,
      dot: activeMissions ? DOT.emerald : DOT.muted,
    },
    {
      to: "/costs", label: "Monthly spend",
      value: summary ? formatCents(summary.costs.monthSpendCents) : "—",
      sub: !summary
        ? loadState(summaryError)
        : spendBudgetCents > 0 ? `of ${formatCents(spendBudgetCents)} · ${spendPct}%` : "No budget",
      dot: !summary || spendBudgetCents <= 0 ? DOT.muted : spendPct >= 100 ? DOT.crimson : spendPct >= 80 ? DOT.amber : DOT.emerald,
    },
    {
      to: "/human-operator", label: "Waiting / blocked",
      value: waitsLoaded ? String(waitCount) : summary ? String(summary.pendingApprovals + summary.budgets.pendingApprovals) : "—",
      sub: waitsLoaded ? `${count("decision", pendingCards.length)} · ${count("queued", queueItems.length)}` : loadState(pendingError || queueError),
      dot: waitCount > 0 ? DOT.amber : DOT.muted,
    },
  ];
  const tickerStatus = waitChips.length
    ? `${waitCount} waiting on humans`
    : pendingError || queueError
      ? "Queue unavailable"
      : waitsLoaded ? "All clear — nothing waiting" : "Checking queue…";

  return (
    <div className="space-y-3 tabular-nums">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      <section aria-label="명령 헤더" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{ backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }}
          >
            <Rocket className="h-3.5 w-3.5" />
            실시간 운영 현황
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_LINKS.map((link) => (
              <Link key={link.to} to={link.to} className={`${PILL_CLASS} cursor-pointer`} style={PILL_STYLE}>
                <link.icon className="h-3.5 w-3.5" />
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => typeof window !== "undefined" && window.dispatchEvent(new CustomEvent(INSPECTOR_TOGGLE_EVENT))}
              className={`${PILL_CLASS} hidden cursor-pointer md:inline-flex`}
              style={PILL_STYLE}
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
              우측 인스펙터
            </button>
          </div>
        </div>

        {/* 1-row 5-column cockpit strip */}
        <div className="grid grid-cols-2 lg:grid-cols-5 divide-x divide-[#242d3f] bg-[#111622] border border-[#242d3f] rounded-md">
          {kpis.map((kpi) => <KpiCell key={kpi.label} {...kpi} />)}
        </div>

        {/* Single-line escalation / queue ticker */}
        <div
          role="status"
          className="flex h-8 items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-md border border-[#fbbf24]/35 bg-[#fbbf24]/7 px-3 text-xs"
        >
          <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#fde68a]">
            <Inbox className="h-3.5 w-3.5" />
            {tickerStatus}
          </span>
          {waitChips.map((chip) => (
            <Link
              key={chip.id}
              to={chip.to}
              title={chip.label}
              className="max-w-56 shrink-0 truncate rounded border border-[#242d3f] bg-[#0b0e14] px-2 py-0.5 text-[11px] no-underline text-inherit transition-colors hover:border-[#fbbf24]"
            >
              <span className="font-semibold text-[#fbbf24]">{chip.kind}</span> {chip.label}
            </Link>
          ))}
          {waitCount > waitChips.length && (
            <span className="shrink-0 text-[11px] text-[#fde68a]">+{waitCount - waitChips.length} more</span>
          )}
          {waitCount > 0 && (
            <Link to="/human-operator" className="ml-auto shrink-0 font-semibold text-[#fde68a] no-underline hover:underline">
              Review →
            </Link>
          )}
        </div>
      </section>

      {/* Single-row unified filter toolbar (40px): filters scroll horizontally, actions stay pinned. */}
      <div className="flex h-10 items-center gap-2 rounded-md border border-[#242d3f] bg-[#111622] pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <div
            role="group"
            aria-label="Filter missions by status"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5"
          >
            {STATUS_TABS.map((tab) => {
              const active = statusFilter === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateSearchParams({ status: tab.value === "all" ? null : tab.value }, { resetPage: true })}
                  className={`h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors ${
                    active ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_0_0_1px_#242d3f]" : "text-[#8b97ad] hover:text-[#e6edf7]"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <select
            aria-label="Main executor"
            value={ownerAgentId}
            onChange={(e) =>
              updateSearchParams({ ownerAgentId: e.target.value === "all" ? null : e.target.value }, { resetPage: true })
            }
            className={`${CONTROL_CLASS} w-36 shrink-0`}
          >
            <option value="all">All executors</option>
            {(agents ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>

          <ToolbarField label="From">
            <input
              type="date"
              aria-label="Created from"
              value={from}
              onChange={(e) => updateSearchParams({ from: e.target.value || null }, { resetPage: true })}
              className={CONTROL_CLASS}
            />
          </ToolbarField>

          <ToolbarField label="To">
            <input
              type="date"
              aria-label="Created to"
              value={to}
              onChange={(e) => updateSearchParams({ to: e.target.value || null }, { resetPage: true })}
              className={CONTROL_CLASS}
            />
          </ToolbarField>

          <select
            aria-label="Sort missions"
            value={currentSortValue}
            onChange={(e) => {
              const [nextSortBy, nextSortOrder] = e.target.value.split(":");
              updateSearchParams({ sortBy: nextSortBy, sortOrder: nextSortOrder }, { resetPage: true });
            }}
            className={`${CONTROL_CLASS} w-36 shrink-0`}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label="Toggle mission preview pane"
          title="Mission preview pane (j/k to browse)"
          onClick={() => {
            if (inspectorOpen) {
              setInspectorOpen(false);
            } else {
              previewMission(previewId ?? stepSelection(missions?.map((mission) => mission.id) ?? [], null, 1));
            }
          }}
          className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors ${
            inspectorOpen
              ? "border-[#5f8dff]/50 bg-[#2563eb]/15 text-[#5f8dff]"
              : "border-[#242d3f] text-[#8b97ad] hover:bg-[#151b28] hover:text-[#e6edf7]"
          }`}
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={refreshCurrentTab}
          disabled={isMissionsFetching}
          className="h-7 w-7 px-0 text-xs"
          title={isMissionsFetching ? "Refreshing" : "Refresh current tab"}
          aria-label="Refresh current missions tab"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isMissionsFetching ? "animate-spin" : ""}`} />
          <span className="sr-only">{isMissionsFetching ? "Refreshing" : "Refresh"}</span>
        </Button>
        <Button
          size="sm"
          onClick={() => openNewMission()}
          className="h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Mission
        </Button>
      </div>

      {missions && missions.length === 0 && (
        <EmptyState
          icon={Rocket}
          message="No missions match the current filters."
          action="Create Mission"
          onAction={openNewMission}
        />
      )}

      <span className="sr-only" aria-live="polite">
        {selectedMission ? `Previewing ${selectedMission.title}` : ""}
      </span>

      {missions && missions.length > 0 && (
        <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_23.5rem]">
          {/* Quick-preview split inspector: right pane on xl, stacked above the list below xl. */}
          {inspectorOpen && (
            <section
              aria-label="Mission preview"
              data-mission-preview
              className="order-first flex min-w-0 flex-col gap-3 self-start rounded-md border border-border/80 bg-card/60 p-3 xl:order-none xl:sticky xl:top-0 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto"
            >
              {selectedMission ? (
                <>
                  <div className="flex items-start gap-2">
                    <StatusBadge status={selectedMission.status} />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={selectedMission.title}>
                      {selectedMission.title}
                    </h2>
                    <button
                      type="button"
                      aria-label="Close mission preview"
                      onClick={() => setInspectorOpen(false)}
                      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {selectedMission.description?.trim() || "No description."}
                  </p>
                  <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Main executor</dt>
                    <dd className="truncate">{agentMap[selectedMission.ownerAgentId] ?? "—"}</dd>
                    <dt className="text-muted-foreground">Project</dt>
                    <dd className="truncate">{selectedMission.project?.name ?? "—"}</dd>
                    <dt className="text-muted-foreground">Created</dt>
                    <dd>{formatDateTime(selectedMission.createdAt)}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatDateTime(selectedMission.updatedAt)}</dd>
                  </dl>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">Step progress</span>
                      <span>{completedSteps}/{totalSteps} · {progressPct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#242d3f]">
                      <div
                        className={`h-full rounded-full transition-[width] ${totalSteps > 0 && completedSteps === totalSteps ? DOT.emerald : DOT.cobalt}`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    {previewLoading ? (
                      <p className="text-xs text-muted-foreground">Loading steps…</p>
                    ) : steps.length > 0 ? (
                      <ol className="max-h-64 space-y-0.5 overflow-y-auto">
                        {steps.map((step) => (
                          <li key={step.stepId} className="flex min-w-0 items-center gap-2 text-xs">
                            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${STEP_DOT[step.status]}`} />
                            <span className="min-w-0 flex-1 truncate" title={step.name}>{step.name}</span>
                            <span className="shrink-0 text-[11px] uppercase text-muted-foreground">{step.status}</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-muted-foreground">No workflow run yet.</p>
                    )}
                  </div>
                  <Link
                    to={`/missions/${selectedMission.id}`}
                    className="inline-flex items-center justify-center rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs font-medium no-underline text-inherit transition-colors hover:bg-accent/50"
                  >
                    Open Full Mission →
                  </Link>
                </>
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Select a mission row or press j/k to preview it.
                </p>
              )}
            </section>
          )}

          <div className="min-w-0 space-y-3">
            <div className="overflow-hidden rounded-md border border-border/80 bg-card/60">
              <div className={`${ROW_GRID} border-b border-border/80 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground`}>
                <span>Mission</span>
                <span>Status</span>
                <span className="hidden sm:block">Main executor</span>
                <span className="hidden justify-self-end sm:block">Created</span>
              </div>
              {missions.map((mission) => {
                const isPreviewed = mission.id === previewId && inspectorOpen;
                return (
                  <div
                    key={mission.id}
                    data-mission-row={mission.id}
                    data-selected={isPreviewed || undefined}
                    onClick={() => previewMission(mission.id)}
                    className={`${ROW_GRID} cursor-pointer border-b border-border/60 px-3 py-2 text-sm transition-colors last:border-b-0 ${
                      isPreviewed ? "bg-[#2563eb]/15 shadow-[inset_2px_0_0_#5f8dff]" : "hover:bg-accent/50"
                    }`}
                  >
                    <Link
                      to={`/missions/${mission.id}`}
                      className="flex min-w-0 items-center gap-2 no-underline text-inherit hover:no-underline"
                    >
                      <Rocket className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate font-medium">{mission.title}</span>
                      {mission.project && (
                        <span className="inline-flex min-w-0 max-w-[9rem] items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: mission.project.color ?? "#6366f1" }}
                          />
                          <span className="truncate">{mission.project.name}</span>
                        </span>
                      )}
                    </Link>
                    <StatusBadge status={mission.status} />
                    <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                      {agentMap[mission.ownerAgentId] ?? "—"}
                    </span>
                    <span className="hidden justify-self-end text-xs tabular-nums text-muted-foreground sm:block">
                      {formatDateTime(mission.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground tabular-nums">
                Page {page}
                {missionFilters.offset !== undefined && missionFilters.limit !== undefined
                  ? ` • Showing ${missionFilters.offset + 1}-${missionFilters.offset + (missions?.length ?? 0)}`
                  : ""}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Per page</span>
                  <select
                    value={String(pageSize)}
                    onChange={(e) => updateSearchParams({ pageSize: e.target.value }, { resetPage: true })}
                    className={CONTROL_CLASS}
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={String(option)}>{option}</option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasPreviousPage}
                  onClick={() => updateSearchParams({ page: String(page - 1) })}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasNextPage}
                  onClick={() => updateSearchParams({ page: String(page + 1) })}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

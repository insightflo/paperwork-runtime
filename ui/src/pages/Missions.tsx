import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  missionsApi,
  type MissionListFilters,
  type MissionListItem,
  type MissionStatus,
  type MissionWorkflowRun,
  type MissionWorkflowStep,
} from "../api/missions";
import { agentsApi } from "../api/agents";
import { api } from "../api/client";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { CompactPagination } from "../components/CompactPagination";
import {
  BUCKET_LABELS,
  MissionFleetRadar,
  formatMissionShortKey,
  getMissionRadarBucket,
  getMissionWorkflowTag,
  matchesMissionRadarFilters,
  sortMissionsByAttentionPriority,
  type MissionRadarBucket,
  type RadarStatusBucket,
} from "../components/missions/MissionFleetRadar";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { normalizeQueueItems, queueItemLabel } from "../components/QueuePanel";
import {
  AlertTriangle,
  Inbox,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  X,
} from "lucide-react";

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const SORT_OPTIONS = [
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "createdAt:desc", label: "Recently created" },
  { value: "title:asc", label: "Title A-Z" },
  { value: "title:desc", label: "Title Z-A" },
  { value: "status:asc", label: "Status" },
] as const;

const DOT = {
  emerald: "bg-[#34d399]",
  lime: "bg-emerald-500 dark:bg-emerald-300",
  cobalt: "bg-primary",
  amber: "bg-[#fbbf24]",
  crimson: "bg-[#f87171]",
  muted: "bg-[#4a5670]",
} as const;

const BUCKET_DOT_CLASS: Record<MissionRadarBucket, string> = {
  need: "bg-[#f43f5e] shadow-[0_0_8px_rgba(244,63,94,0.85)] animate-pulse",
  run: "bg-emerald-500 dark:bg-emerald-300 animate-pulse",
  wait: "bg-[#f59e0b] shadow-[0_0_6px_rgba(245,158,11,0.65)]",
  done: "bg-primary/70",
};

const STEP_DOT: Record<MissionWorkflowStep["status"], string> = {
  completed: "bg-emerald-500 dark:bg-emerald-300",
  running: "bg-primary animate-pulse",
  failed: "bg-[#f43f5e] animate-pulse dark:shadow-[0_0_7px_rgba(244,63,94,0.8)]",
  skipped: "bg-muted-foreground/40",
  pending: "bg-muted-foreground/30",
};

const CONTROL_CLASS =
  "h-7 rounded-md border border-border bg-muted/40 px-2 text-xs text-foreground outline-none transition-colors focus:border-primary focus:bg-card dark:bg-card";

const ROW_GRID =
  "grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 sm:grid-cols-[10px_minmax(0,1fr)_5.5rem_7.5rem_7.75rem]";

function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

function formatCompactTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

/** Step over visible rows; clamps at both ends and enters from the first/last row. */
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

function ToolbarField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Compact step-progress dots (●●●◐○○) for scannable 44px rows. */
function RowStepDots({
  bucket,
  status,
  steps,
}: {
  bucket: MissionRadarBucket;
  status: MissionStatus;
  steps?: MissionWorkflowStep[];
}) {
  if (steps && steps.length > 0) {
    const completed = steps.filter((s) => s.status === "completed").length;
    return (
      <span
        className="hidden items-center gap-1 sm:inline-flex"
        title={`${completed}/${steps.length} steps`}
        data-step-dots
      >
        <span className="inline-flex items-center gap-0.5">
          {steps.slice(0, 6).map((s) => (
            <span
              key={s.stepId}
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${STEP_DOT[s.status]}`}
            />
          ))}
        </span>
        <span className="font-mono text-[10px] font-bold text-muted-foreground tabular-nums">
          {completed}/{steps.length}
        </span>
      </span>
    );
  }

  // Status-derived compact 5-dot progress gauge when per-row workflow runs are not yet expanded.
  const dotStates: Array<"done" | "active" | "need" | "wait" | "idle"> =
    status === "completed"
      ? ["done", "done", "done", "done", "done"]
      : status === "cancelled"
        ? ["idle", "idle", "idle", "idle", "idle"]
        : bucket === "need"
          ? ["done", "done", "need", "idle", "idle"]
          : status === "active"
            ? ["done", "done", "active", "idle", "idle"]
            : status === "paused"
              ? ["done", "wait", "idle", "idle", "idle"]
              : ["wait", "idle", "idle", "idle", "idle"];

  const cls = {
    done: "bg-emerald-500 dark:bg-emerald-300",
    active: "bg-emerald-500 dark:bg-emerald-300 animate-pulse",
    need: "bg-[#f43f5e] animate-pulse shadow-[0_0_6px_rgba(244,63,94,0.8)]",
    wait: "bg-[#f59e0b]",
    idle: "bg-muted-foreground/25 dark:bg-white/[0.12]",
  };

  return (
    <span
      className="hidden items-center gap-1 sm:inline-flex"
      title={BUCKET_LABELS[bucket]}
      data-step-dots
    >
      <span className="inline-flex items-center gap-0.5">
        {dotStates.map((state, idx) => (
          <span key={idx} aria-hidden className={`h-1.5 w-1.5 rounded-full ${cls[state]}`} />
        ))}
      </span>
    </span>
  );
}

export function Missions() {
  const { selectedCompanyId, canWrite = true } = useCompany();
  const { openNewMission } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const toast = useOptionalToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Permanent Live Inspector by default (Combo 4 58/42 Split View); toggleable via toolbar.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [radarStatus, setRadarStatus] = useState<RadarStatusBucket>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [localPage, setLocalPage] = useState(1);
  const [mutatingMissionId, setMutatingMissionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    data: missions,
    isLoading,
    isFetching: isMissionsFetching,
    error,
    refetch: refetchMissions,
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

  // Fleet-wide missions + pending operator decisions / queue for escalation ticker.
  const { data: allMissions } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!),
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const { data: pending } = useQuery({
    queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending"),
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending", 50),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: queueRaw } = useQuery({
    queryKey: ["ops-console-queue", selectedCompanyId!],
    queryFn: () => api.get<unknown>(`/companies/${selectedCompanyId}/ops-console/queue`),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
    retry: false,
  });

  const agentMap = useMemo(
    () => (agents ? Object.fromEntries(agents.map((a) => [a.id, a.name])) : {}),
    [agents],
  );
  const queueItems = useMemo(() => normalizeQueueItems(queueRaw), [queueRaw]);
  const pendingCards = useMemo(() => pending?.data ?? [], [pending]);

  // Identify missions that need immediate operator attention from pending decisions.
  const { attentionMissionIds, attentionReasons } = useMemo(() => {
    const ids = new Set<string>();
    const reasons = new Map<string, string>();
    for (const card of pendingCards) {
      const mId = card.sourceContext?.missionId ?? card.continuation?.missionId ?? null;
      if (mId) {
        ids.add(mId);
        if (!reasons.has(mId)) {
          reasons.set(mId, card.title);
        }
      }
    }
    return { attentionMissionIds: ids, attentionReasons: reasons };
  }, [pendingCards]);

  // Fleet-wide missions for live radar counts & status mosaic.
  const fleetMissions = useMemo(
    () => (allMissions && allMissions.length > 0 ? allMissions : (missions ?? [])),
    [allMissions, missions],
  );

  const shortKeyById = useMemo(() => {
    const map = new Map<string, string>();
    fleetMissions.forEach((m, idx) => map.set(m.id, formatMissionShortKey(idx)));
    (missions ?? []).forEach((m, idx) => {
      if (!map.has(m.id)) map.set(m.id, formatMissionShortKey(idx));
    });
    return map;
  }, [fleetMissions, missions]);

  const hasClientRadarFilter =
    radarStatus !== "all" || searchQuery.trim().length > 0 || workflowFilter !== "all";
  const hasUrlFilter =
    statusFilter !== "all" ||
    ownerAgentId !== "all" ||
    Boolean(to) ||
    (Boolean(searchParams.get("from")) && from !== getDefaultCreatedFrom());
  const hasAnyFilter = hasClientRadarFilter || hasUrlFilter;

  // When a client-side radar filter/search is active, filter across the full fleet and paginate cleanly.
  const filteredClientMissions = useMemo(() => {
    const source = hasClientRadarFilter ? fleetMissions : (missions ?? []);
    const matched = hasClientRadarFilter
      ? source.filter((mission) =>
          matchesMissionRadarFilters(
            mission,
            shortKeyById.get(mission.id) ?? "",
            { radarStatus, searchQuery, workflowFilter },
            attentionMissionIds,
            agentMap,
          ),
        )
      : source;
    return sortMissionsByAttentionPriority(matched, attentionMissionIds);
  }, [
    hasClientRadarFilter,
    fleetMissions,
    missions,
    shortKeyById,
    radarStatus,
    searchQuery,
    workflowFilter,
    attentionMissionIds,
    agentMap,
  ]);

  const activePage = hasClientRadarFilter ? localPage : page;
  const visibleMissions = useMemo(() => {
    if (!hasClientRadarFilter) return filteredClientMissions;
    const start = (localPage - 1) * pageSize;
    return filteredClientMissions.slice(start, start + pageSize);
  }, [hasClientRadarFilter, filteredClientMissions, localPage, pageSize]);

  const hasNextPage = hasClientRadarFilter
    ? localPage * pageSize < filteredClientMissions.length
    : (missions?.length ?? 0) >= pageSize;

  // Permanent Live Inspector selection: falls back to the top-priority visible mission for 0ms readiness.
  const activeMissionId = useMemo(() => {
    if (previewId) {
      const existsInVisible = visibleMissions.some((m) => m.id === previewId);
      const existsInFleet = fleetMissions.some((m) => m.id === previewId);
      if (existsInVisible || existsInFleet) return previewId;
    }
    return visibleMissions[0]?.id ?? null;
  }, [previewId, visibleMissions, fleetMissions]);

  const selectedMission = useMemo(
    () =>
      visibleMissions.find((m) => m.id === activeMissionId) ??
      fleetMissions.find((m) => m.id === activeMissionId) ??
      null,
    [visibleMissions, fleetMissions, activeMissionId],
  );

  const { data: previewRuns, isLoading: previewLoading } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(selectedMission?.id ?? ""),
    queryFn: () => missionsApi.listWorkflowRuns(selectedMission!.id),
    enabled: Boolean(selectedCompanyId) && inspectorOpen && Boolean(selectedMission),
  });
  const { data: previewIssues } = useQuery({
    queryKey: queryKeys.missions.issues(selectedMission?.id ?? ""),
    queryFn: () => missionsApi.listIssues(selectedMission!.id),
    enabled: Boolean(selectedCompanyId) && inspectorOpen && Boolean(selectedMission),
  });

  const previewRun = useMemo(() => pickPreviewRun(previewRuns), [previewRuns]);
  const totalSteps = previewRun?.progress.totalSteps ?? 0;
  const completedSteps = previewRun?.progress.completedSteps ?? 0;
  const steps = previewRun?.steps ?? [];
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const linkedIssues = Array.isArray(previewIssues) ? previewIssues : [];

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

  const handlePageChange = (nextPage: number) => {
    const safePage = Math.max(1, nextPage);
    if (hasClientRadarFilter) {
      setLocalPage(safePage);
    } else {
      updateSearchParams({ page: String(safePage) });
    }
  };

  const previewMission = useCallback((id: string | null) => {
    setActionError(null);
    setPreviewId(id);
    setInspectorOpen(true);
  }, []);

  const handleToggleMissionStatus = useCallback(
    async (mission: MissionListItem) => {
      if (!canWrite || !selectedCompanyId || mutatingMissionId) return;
      const nextStatus: MissionStatus = mission.status === "active" ? "paused" : "active";
      setActionError(null);
      setMutatingMissionId(mission.id);
      try {
        await missionsApi.update(mission.id, { status: nextStatus });
        await queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId) });
        void refetchMissions();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionError(message);
        toast?.pushToast({
          title: nextStatus === "paused" ? "미션 일시정지 실패" : "미션 재개 실패",
          body: message,
          tone: "error",
        });
      } finally {
        setMutatingMissionId(null);
      }
    },
    [canWrite, selectedCompanyId, mutatingMissionId, queryClient, refetchMissions, toast],
  );

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      const ids = visibleMissions.map((mission) => mission.id);
      previewMission(stepSelection(ids, activeMissionId, delta));
    },
    [visibleMissions, activeMissionId, previewMission],
  );

  // ↑/↓ and j/k step across rows; / focuses search; Esc closes preview when focused inside it or on a row.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) {
        if (event.key === "Escape" && event.target === searchInputRef.current) {
          setSearchQuery("");
          setLocalPage(1);
          searchInputRef.current?.blur();
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (!visibleMissions.length) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        moveSelection(-1);
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
  }, [inspectorOpen, visibleMissions.length, moveSelection]);

  const waitCount = pendingCards.length + queueItems.length;
  const waitChips = [
    ...pendingCards.slice(0, 6).map((card) => ({
      id: `decision-${card.id}`,
      kind: "Decision",
      label: card.title,
      to: "/human-operator",
    })),
    ...queueItems.slice(0, 6).map((item) => ({
      id: `queue-${item.id}`,
      kind: "Queued",
      label: queueItemLabel(item),
      to: "/worktree/rules",
    })),
  ];

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a company to view missions." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selectedBucket = selectedMission
    ? getMissionRadarBucket(selectedMission, attentionMissionIds)
    : null;
  const selectedReason = selectedMission ? attentionReasons.get(selectedMission.id) : undefined;
  const canToggleStatus =
    selectedMission &&
    (selectedMission.status === "active" ||
      selectedMission.status === "paused" ||
      selectedMission.status === "planning");

  return (
    <div className="space-y-3 tabular-nums">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* Compact escalation ticker (only shown when human decisions or queued items await action) */}
      {waitCount > 0 && (
        <div
          role="status"
          className="tactile-card flex h-8 items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-[10px] border border-amber-500/35 bg-amber-500/[0.07] px-3 text-xs text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-amber-500/35 dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        >
          <span className="flex shrink-0 items-center gap-1.5 font-semibold text-amber-800 dark:text-[#fde68a]">
            <Inbox className="h-3.5 w-3.5" />
            {`${waitCount} waiting on humans`}
          </span>
          {waitChips.map((chip) => (
            <Link
              key={chip.id}
              to={chip.to}
              title={chip.label}
              className="max-w-56 shrink-0 truncate rounded border border-border bg-card px-2 py-0.5 text-[11px] no-underline text-inherit transition-colors hover:border-amber-500/60 dark:border-white/[0.08] dark:bg-background dark:hover:border-amber-500/60"
            >
              <span className="font-semibold text-amber-700 dark:text-[#fbbf24]">{chip.kind}</span>{" "}
              {chip.label}
            </Link>
          ))}
          {waitCount > waitChips.length && (
            <span className="shrink-0 text-[11px] text-amber-800 dark:text-[#fde68a]">
              +{waitCount - waitChips.length} more
            </span>
          )}
          <Link
            to="/human-operator"
            className="ml-auto shrink-0 font-semibold text-amber-800 no-underline hover:underline dark:text-[#fde68a]"
          >
            Review →
          </Link>
        </div>
      )}

      {/* Combo 1 Fleet Mission Radar: Status chips with live counts, search & workflow filter */}
      <MissionFleetRadar
        missions={fleetMissions}
        attentionMissionIds={attentionMissionIds}
        radarStatus={radarStatus}
        onRadarStatusChange={(next) => {
          setRadarStatus(next);
          setLocalPage(1);
        }}
        searchQuery={searchQuery}
        onSearchQueryChange={(next) => {
          setSearchQuery(next);
          setLocalPage(1);
        }}
        workflowFilter={workflowFilter}
        onWorkflowFilterChange={(next) => {
          setWorkflowFilter(next);
          setLocalPage(1);
        }}
        searchInputRef={searchInputRef}
      />

      {/* Single-row compact controls toolbar (40px): executor, date range, sort, inspector, refresh, new mission */}
      <div className="tactile-card flex h-10 items-center gap-2 rounded-[12px] border border-border bg-card/95 pl-2 pr-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_20px_-12px_rgba(0,0,0,0.7)]">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <select
            aria-label="Main executor"
            value={ownerAgentId}
            onChange={(e) =>
              updateSearchParams(
                { ownerAgentId: e.target.value === "all" ? null : e.target.value },
                { resetPage: true },
              )
            }
            className={`${CONTROL_CLASS} w-36 shrink-0`}
          >
            <option value="all">All executors</option>
            {(agents ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
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
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {hasAnyFilter && (
            <button
              type="button"
              onClick={() => {
                setRadarStatus("all");
                setSearchQuery("");
                setWorkflowFilter("all");
                setLocalPage(1);
                if (hasUrlFilter) {
                  updateSearchParams(
                    { status: null, ownerAgentId: null, from: null, to: null },
                    { resetPage: true },
                  );
                }
              }}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
            >
              <X className="h-3 w-3" />
              필터 초기화
            </button>
          )}
        </div>

        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label="미션 미리보기 창 전환"
          title="미션 라이브 인스펙터 (↑/↓ 또는 j/k 탐색)"
          onClick={() => {
            if (inspectorOpen) {
              setInspectorOpen(false);
            } else {
              previewMission(activeMissionId ?? stepSelection(visibleMissions.map((m) => m.id), null, 1));
            }
          }}
          className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors ${
            inspectorOpen
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
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
          title={isMissionsFetching ? "새로고침 중" : "현재 탭 새로고침"}
          aria-label="현재 미션 탭 새로고침"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isMissionsFetching ? "animate-spin" : ""}`} />
          <span className="sr-only">{isMissionsFetching ? "새로고침 중" : "새로고침"}</span>
        </Button>
        <Button
          size="sm"
          disabled={!canWrite}
          title={!canWrite ? "Member, admin, or owner role required to create missions" : undefined}
          onClick={() => {
            if (!canWrite) return;
            openNewMission();
          }}
          className="h-7 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          새 미션
        </Button>
      </div>

      {visibleMissions.length === 0 && (
        <div className="space-y-2">
          <EmptyState
            icon={Rocket}
            message={
              hasClientRadarFilter
                ? "No missions match the current radar filter or search query."
                : "No missions match the current filters."
            }
            action={hasClientRadarFilter ? "Reset Radar Filters" : canWrite ? "Create Mission" : undefined}
            onAction={
              hasClientRadarFilter
                ? () => {
                    setRadarStatus("all");
                    setSearchQuery("");
                    setWorkflowFilter("all");
                    setLocalPage(1);
                  }
                : canWrite
                  ? openNewMission
                  : undefined
            }
          />
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {selectedMission ? `Previewing ${selectedMission.title}` : ""}
      </span>

      {/* 58/42 Split View: Left High-Density 44px List + Right Permanent Live Inspector */}
      {visibleMissions.length > 0 && (
        <div
          data-mission-split
          className={`grid min-w-0 gap-3 ${
            inspectorOpen ? "lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]" : "grid-cols-1"
          }`}
        >
          {/* Left Pane (58%): High-Density 44px Scannable Mission List + CompactPagination */}
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="tactile-card overflow-hidden rounded-[12px] border border-border bg-card/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
              <div
                className={`${ROW_GRID} border-b border-border bg-muted/40 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground`}
              >
                <span aria-hidden />
                <span className="flex min-w-0 items-center gap-2">
                  <span>미션</span>
                  <span className="font-mono text-[10px] font-semibold normal-case tracking-normal text-muted-foreground tabular-nums">
                    {hasClientRadarFilter ? `${filteredClientMissions.length}건 필터됨` : `${visibleMissions.length}건`}
                  </span>
                  {hasClientRadarFilter && (
                    <button
                      type="button"
                      onClick={() => {
                        setRadarStatus("all");
                        setSearchQuery("");
                        setWorkflowFilter("all");
                        setLocalPage(1);
                      }}
                      className="shrink-0 cursor-pointer text-[10px] font-semibold normal-case tracking-normal text-primary hover:underline"
                    >
                      필터 초기화
                    </button>
                  )}
                </span>
                <span className="hidden sm:block">단계</span>
                <span className="hidden sm:block">메인 실행자</span>
                <span className="hidden justify-self-end sm:block">업데이트</span>
              </div>

              <div role="listbox" aria-label="Mission list">
                {visibleMissions.map((mission) => {
                  const bucket = getMissionRadarBucket(mission, attentionMissionIds);
                  const shortKey = shortKeyById.get(mission.id) ?? "M--";
                  const reason = attentionReasons.get(mission.id);
                  const isSelected = mission.id === activeMissionId && inspectorOpen;
                  const workflowTag = getMissionWorkflowTag(mission);

                  return (
                    <div
                      key={mission.id}
                      role="option"
                      aria-selected={isSelected}
                      data-mission-row={mission.id}
                      data-selected={isSelected || undefined}
                      data-radar-bucket={bucket}
                      onClick={() => previewMission(mission.id)}
                      className={`${ROW_GRID} relative min-h-[44px] cursor-pointer border-b border-border/60 px-3 py-1.5 text-sm transition-colors last:border-b-0 dark:border-white/[0.05] ${
                        isSelected
                          ? "bg-primary/12 shadow-[inset_2px_0_0_var(--primary)]"
                          : bucket === "need"
                            ? "bg-[#f43f5e]/[0.06] hover:bg-[#f43f5e]/[0.11]"
                            : "hover:bg-accent/50 dark:hover:bg-white/[0.04]"
                      } ${bucket === "done" ? "opacity-75" : ""}`}
                    >
                      <span
                        aria-hidden
                        className={`h-2 w-2 shrink-0 rounded-full ${BUCKET_DOT_CLASS[bucket]}`}
                      />

                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 font-mono text-[10px] font-bold text-muted-foreground">
                            {shortKey}
                          </span>
                          <Link
                            to={`/missions/${mission.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="min-w-0 truncate text-[13px] font-semibold text-foreground no-underline hover:underline"
                          >
                            {mission.title}
                          </Link>
                          <span className="hidden shrink-0 items-center gap-1 rounded border border-border/70 bg-muted/50 px-1.5 py-0 text-[10px] font-medium text-muted-foreground md:inline-flex dark:border-white/[0.08] dark:bg-white/[0.04]">
                            {mission.project?.color && (
                              <span
                                aria-hidden
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: mission.project.color }}
                              />
                            )}
                            <span className="max-w-[7rem] truncate">{workflowTag}</span>
                          </span>
                        </div>
                        {reason && (
                          <span className="truncate text-[10.5px] font-medium text-rose-600 dark:text-[#ffb3c1]">
                            개입 필요 · {reason}
                          </span>
                        )}
                      </div>

                      <RowStepDots
                        bucket={bucket}
                        status={mission.status}
                        steps={mission.id === selectedMission?.id ? steps : undefined}
                      />

                      <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {agentMap[mission.ownerAgentId] ?? "—"}
                        </span>
                      </div>

                      <div className="hidden items-center justify-end gap-1.5 sm:flex">
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {formatCompactTime(mission.updatedAt ?? mission.createdAt)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Explicit Pagination (CompactPagination + Per-Page + Keyboard Hint) */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CompactPagination
                page={activePage}
                count={visibleMissions.length}
                hasMore={hasNextPage}
                loading={isMissionsFetching}
                pageSize={pageSize}
                labels={{
                  list: "Missions pagination",
                  prev: "Previous",
                  next: "Next",
                  page: "Page",
                  showing: "Showing",
                  loading: "Loading…",
                }}
                onPageChange={handlePageChange}
                className="flex-1"
              />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  <span>Per page</span>
                  <select
                    aria-label="Missions per page"
                    value={String(pageSize)}
                    onChange={(e) => {
                      setLocalPage(1);
                      updateSearchParams({ pageSize: e.target.value }, { resetPage: true });
                    }}
                    className={CONTROL_CLASS}
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={String(option)}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hidden items-center gap-1 text-[10.5px] xl:inline-flex">
                  <kbd className="rounded border border-border px-1 font-mono text-[9.5px] dark:border-white/[0.14]">
                    ↑
                  </kbd>
                  <kbd className="rounded border border-border px-1 font-mono text-[9.5px] dark:border-white/[0.14]">
                    ↓
                  </kbd>
                  <span>선택</span>
                </span>
              </div>
            </div>
          </div>

          {/* Right Pane (42%): Permanent Live Inspector with 0ms switch */}
          {inspectorOpen && (
            <section
              aria-label="Mission preview"
              data-mission-preview
              className="tactile-card flex min-w-0 flex-col gap-3 self-start rounded-[12px] border border-border bg-card/95 p-3.5 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] lg:sticky lg:top-0 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_18px_40px_-24px_rgba(0,0,0,0.9)]"
            >
              {selectedMission ? (
                <>
                  {/* Inspector Header */}
                  <div className="space-y-1.5 border-b border-border/70 pb-2.5 dark:border-white/[0.07]">
                    <div className="flex items-center gap-1.5">
                      {selectedBucket && (
                        <span
                          aria-hidden
                          className={`h-2 w-2 shrink-0 rounded-full ${BUCKET_DOT_CLASS[selectedBucket]}`}
                        />
                      )}
                      <StatusBadge status={selectedMission.status} />
                      <span className="font-mono text-[10.5px] font-bold text-muted-foreground">
                        {shortKeyById.get(selectedMission.id) ?? "M--"}
                      </span>
                      <span className="truncate rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.04]">
                        {getMissionWorkflowTag(selectedMission)}
                      </span>
                      <button
                        type="button"
                        aria-label="미션 미리보기 닫기"
                        onClick={() => setInspectorOpen(false)}
                        className="ml-auto flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <h2
                      className="text-sm font-bold leading-snug text-foreground"
                      title={selectedMission.title}
                    >
                      {selectedMission.title}
                    </h2>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {selectedMission.description?.trim() || "No description."}
                    </p>
                  </div>

                  {/* Attention Alert Callout (when pending decision exists) */}
                  {selectedReason && (
                    <div className="flex items-center gap-2 rounded-lg border border-[#f43f5e]/45 bg-[#f43f5e]/10 px-2.5 py-2 text-xs">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-[#f43f5e]" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-rose-700 dark:text-[#ffb3c1]">
                          개입 필요 · 승인/결정 대기
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">{selectedReason}</div>
                      </div>
                      <Link
                        to="/human-operator"
                        className="shrink-0 rounded-md bg-[#f43f5e] px-2 py-1 text-[11px] font-bold text-white no-underline hover:brightness-110"
                      >
                        결정함 →
                      </Link>
                    </div>
                  )}

                  {/* Compact KV Metrics Grid */}
                  <dl className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Main executor
                      </dt>
                      <dd className="truncate font-semibold text-foreground">
                        {agentMap[selectedMission.ownerAgentId] ?? "—"}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Step progress
                      </dt>
                      <dd className="font-mono font-semibold text-foreground tabular-nums">
                        {completedSteps}/{totalSteps} · {progressPct}%
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Created
                      </dt>
                      <dd className="truncate text-[11px] tabular-nums text-foreground">
                        {formatDateTime(selectedMission.createdAt)}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Updated
                      </dt>
                      <dd className="truncate text-[11px] tabular-nums text-foreground">
                        {formatDateTime(selectedMission.updatedAt)}
                      </dd>
                    </div>
                  </dl>

                  {/* Action Controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/missions/${selectedMission.id}`}
                      className="inline-flex flex-1 items-center justify-center rounded-lg border border-primary bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground no-underline transition-all hover:bg-primary/90"
                    >
                      Open Full Mission →
                    </Link>
                    {canToggleStatus && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canWrite || mutatingMissionId === selectedMission.id}
                        title={!canWrite ? "Member, admin, or owner role required to pause or resume missions" : undefined}
                        onClick={() => {
                          if (!canWrite) return;
                          void handleToggleMissionStatus(selectedMission);
                        }}
                        className="h-8 gap-1.5 px-2.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {selectedMission.status === "active" ? (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            일시정지
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            재개
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                  {actionError && <p className="text-xs text-destructive">{actionError}</p>}

                  {/* Step Pipeline Progress Preview */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-muted-foreground">
                        {previewRun?.workflowName ? `Workflow · ${previewRun.workflowName}` : "Step progress"}
                      </span>
                      <span className="font-mono text-[11px] font-bold tabular-nums">
                        {completedSteps}/{totalSteps} · {progressPct}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-[width] ${
                          totalSteps > 0 && completedSteps === totalSteps ? DOT.lime : DOT.cobalt
                        }`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    {previewLoading ? (
                      <p className="text-xs text-muted-foreground">Loading steps…</p>
                    ) : steps.length > 0 ? (
                      <ol className="max-h-52 space-y-1 overflow-y-auto pt-1">
                        {steps.map((step) => (
                          <li
                            key={step.stepId}
                            className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs dark:border-white/[0.05] dark:bg-white/[0.02]"
                          >
                            <span
                              aria-hidden
                              className={`h-2 w-2 shrink-0 rounded-full ${STEP_DOT[step.status]}`}
                            />
                            <span className="min-w-0 flex-1 truncate font-medium" title={step.name}>
                              {step.name}
                            </span>
                            {step.issue?.identifier && (
                              <span className="shrink-0 font-mono text-[10px] text-primary">
                                {step.issue.identifier}
                              </span>
                            )}
                            <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
                              {step.status}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-muted-foreground">No workflow run yet.</p>
                    )}
                  </div>

                  {/* Linked Issues Preview */}
                  {linkedIssues.length > 0 && (
                    <div className="space-y-1.5 border-t border-border/70 pt-2.5 dark:border-white/[0.07]">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                        <span>Linked issues</span>
                        <span className="font-mono tabular-nums">{linkedIssues.length}</span>
                      </div>
                      <ul className="space-y-1">
                        {linkedIssues.slice(0, 5).map((issue) => (
                          <li key={issue.id}>
                            <Link
                              to={`/issues/${issue.identifier ?? issue.id}`}
                              className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs no-underline text-inherit transition-colors hover:bg-accent/50 dark:border-white/[0.05] dark:bg-white/[0.02]"
                            >
                              {issue.identifier && (
                                <span className="shrink-0 font-mono text-[10px] font-bold text-primary">
                                  {issue.identifier}
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                              <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
                                {issue.status}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Select a mission row or press ↑/↓ to inspect it.
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

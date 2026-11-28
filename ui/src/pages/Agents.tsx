import { useState, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import {
  AgentTelemetryCard,
  filterTelemetryAgents,
  type AgentLiveRunSummary,
  type AgentUsageSummary,
  type TelemetryStatusFilter,
} from "../components/agents/AgentTelemetryCard";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Plus,
  List,
  GitBranch,
  LayoutGrid,
  SlidersHorizontal,
  Search,
  X,
} from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type HeartbeatRun } from "@paperclipai/shared";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  antigravity_local: "Antigravity",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  commandcode_local: "Command Code",
  pi_local: "Pi",
  cursor: "Cursor",
  process: "Process",
  http: "HTTP",
};

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type ViewMode = "cards" | "list" | "org";

const CONTROL =
  "h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none transition-colors focus:border-primary placeholder:text-muted-foreground dark:border-white/[0.09] dark:bg-background dark:text-[#eef2f8] dark:focus:border-primary dark:placeholder:text-[#627089]";

const STATUS_ROUTES: Partial<Record<TelemetryStatusFilter, string>> = {
  all: "/agents/all",
  running: "/agents/active",
  attention: "/agents/error",
};

/** Explicit column tracks for compact list view. */
const ROW_TRACKS =
  "grid grid-cols-[0.875rem_minmax(0,1fr)_max-content] items-center gap-x-3 sm:grid-cols-[0.875rem_minmax(0,1fr)_7rem_4.5rem_max-content]";

function statusFilterFromPath(pathSegment: string): TelemetryStatusFilter {
  if (pathSegment === "active") return "running";
  if (pathSegment === "paused" || pathSegment === "error") return "attention";
  return "all";
}

function filterOrgTree(nodes: OrgNode[], accept: (node: OrgNode) => boolean): OrgNode[] {
  return nodes.reduce<OrgNode[]>((acc, node) => {
    const reports = filterOrgTree(node.reports, accept);
    if (accept(node) || reports.length > 0) acc.push({ ...node, reports });
    return acc;
  }, []);
}

/** One cell of the 1-row fleet telemetry strip (Combo 1 obsidian + specular top border). */
function FleetCell({
  label,
  value,
  sub,
  dot,
  active,
  onClick,
}: {
  label: string;
  value: number;
  sub: string;
  dot: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-0.5 px-3.5 py-2.5 text-left transition-colors",
        "hover:bg-muted/50 dark:hover:bg-[#141b2a]",
        active && "bg-muted/70 dark:bg-[#121826]",
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground dark:text-[#9aa7bd]">
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate font-mono text-xl font-bold leading-tight tabular-nums text-foreground dark:text-[#eef2f8]">
        {value}
      </span>
      <span className="truncate text-[11px] tabular-nums text-muted-foreground dark:text-[#627089]">
        {sub}
      </span>
    </button>
  );
}

export function Agents() {
  const { selectedCompanyId, canAdmin = true } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();

  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const [statusFilter, setStatusFilter] = useState<TelemetryStatusFilter>(() =>
    statusFilterFromPath(pathSegment),
  );

  useEffect(() => {
    if (pathSegment === "active") setStatusFilter("running");
    else if (pathSegment === "paused" || pathSegment === "error") setStatusFilter("attention");
    else if (pathSegment === "all") setStatusFilter("all");
  }, [pathSegment]);

  const [view, setView] = useState<ViewMode>("cards");
  const effectiveView: ViewMode = isMobile && view === "org" ? "cards" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adapterFilter, setAdapterFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const isTyping = Boolean(
        target && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)),
      );
      if (isTyping) {
        if (event.key === "Escape" && target === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: recentRuns } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "agents-telemetry"] as const,
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 120),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: telemetry } = useQuery({
    queryKey: [...queryKeys.dashboard(selectedCompanyId!), "telemetry", "24h"] as const,
    queryFn: () => dashboardApi.telemetry(selectedCompanyId!, "24h"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Map agentId -> live run summary
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, AgentLiveRunSummary>();
    for (const r of liveRuns ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, {
        runId: r.id,
        liveCount: 1,
        status: r.status,
        startedAt: r.startedAt,
        triggerDetail: r.triggerDetail,
        invocationSource: r.invocationSource,
        issueId: r.issueId ?? null,
      });
    }
    return map;
  }, [liveRuns]);

  const liveAgentIds = useMemo(() => new Set(liveRunByAgent.keys()), [liveRunByAgent]);

  // Group recent heartbeat runs per agent (newest first)
  const recentRunsByAgent = useMemo(() => {
    const map = new Map<string, HeartbeatRun[]>();
    for (const run of recentRuns ?? []) {
      const bucket = map.get(run.agentId);
      if (bucket) {
        bucket.push(run);
      } else {
        map.set(run.agentId, [run]);
      }
    }
    return map;
  }, [recentRuns]);

  // Map agentId -> 24h usage share from dashboard telemetry
  const usageShareByAgent = useMemo(() => {
    const map = new Map<string, AgentUsageSummary>();
    for (const share of telemetry?.agentShares ?? []) {
      if (!share.id) continue;
      map.set(share.id, {
        tokens: share.tokens,
        costCents: share.costCents,
        runs: share.runs,
        sharePct: share.sharePct,
      });
    }
    return map;
  }, [telemetry]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const adapterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents ?? []) set.add(a.adapterType);
    return Array.from(set).sort((a, b) =>
      (adapterLabels[a] ?? a).localeCompare(adapterLabels[b] ?? b),
    );
  }, [agents]);

  const roleOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents ?? []) set.add(a.role);
    return Array.from(set).sort((a, b) =>
      (roleLabels[a] ?? a).localeCompare(roleLabels[b] ?? b),
    );
  }, [agents]);

  const fleet = useMemo(() => {
    const list = (agents ?? []).filter((a) => showTerminated || a.status !== "terminated");
    const count = (status: string) => list.filter((a) => a.status === status).length;
    const running = count("running");
    const active = count("active") + running;
    const errors = count("error");
    const approvals = count("pending_approval");
    const paused = count("paused");
    return {
      total: list.length,
      active,
      running,
      errors,
      approvals,
      idle: count("idle"),
      paused,
      attention: errors + paused + approvals,
      live: liveRunByAgent.size,
    };
  }, [agents, showTerminated, liveRunByAgent]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  const filtered = useMemo(
    () =>
      filterTelemetryAgents(agents ?? [], {
        status: statusFilter,
        query,
        adapter: adapterFilter,
        role: roleFilter,
        showTerminated,
        liveAgentIds,
        roleLabels,
        adapterLabels,
      }),
    [agents, statusFilter, query, adapterFilter, roleFilter, showTerminated, liveAgentIds],
  );

  const filteredIdSet = useMemo(() => new Set(filtered.map((a) => a.id)), [filtered]);

  const filteredOrg = useMemo(
    () => filterOrgTree(orgTree ?? [], (node) => filteredIdSet.has(node.id)),
    [orgTree, filteredIdSet],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const handleStatusSelect = (next: TelemetryStatusFilter) => {
    setStatusFilter(next);
    const route = STATUS_ROUTES[next];
    if (route) {
      navigate(route);
    }
  };

  const activeExtraFilterCount =
    (showTerminated ? 1 : 0) +
    (adapterFilter !== "all" ? 1 : 0) +
    (roleFilter !== "all" ? 1 : 0);

  const hasActiveFilters =
    statusFilter !== "all" ||
    query.trim() !== "" ||
    adapterFilter !== "all" ||
    roleFilter !== "all" ||
    showTerminated;

  const resetAllFilters = () => {
    setQuery("");
    setAdapterFilter("all");
    setRoleFilter("all");
    setShowTerminated(false);
    setFiltersOpen(false);
    if (statusFilter !== "all") {
      handleStatusSelect("all");
    }
  };

  return (
    <div className="mx-auto w-full space-y-4 tabular-nums">
      {/* 1-row 4-column fleet telemetry strip */}
      <section
        aria-label="Fleet telemetry"
        className="tactile-card grid grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] lg:grid-cols-4 dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_28px_-18px_rgba(0,0,0,0.85)]"
      >
        <FleetCell
          label="전체 에이전트"
          value={fleet.total}
          dot="bg-blue-500 dark:bg-primary"
          sub={`라이브 ${fleet.live} · 일시정지 ${fleet.paused}`}
          active={statusFilter === "all"}
          onClick={() => handleStatusSelect("all")}
        />
        <FleetCell
          label="실행 중 / 활성"
          value={fleet.active}
          dot={cn(
            "bg-emerald-700 dark:bg-emerald-300",
            (fleet.running > 0 || fleet.live > 0) && "animate-pulse",
          )}
          sub={`실행 ${fleet.running} · 준비 ${Math.max(0, fleet.active - fleet.running)}`}
          active={statusFilter === "running"}
          onClick={() => handleStatusSelect("running")}
        />
        <FleetCell
          label="대기"
          value={fleet.idle}
          dot="bg-amber-500 dark:bg-[#f59e0b]"
          sub={`대기 중 ${fleet.idle}`}
          active={statusFilter === "idle"}
          onClick={() => handleStatusSelect("idle")}
        />
        <FleetCell
          label="오류 / 일시정지"
          value={fleet.attention}
          dot={
            fleet.errors > 0
              ? "bg-rose-500 dark:bg-[#fb7185]"
              : fleet.attention > 0
                ? "bg-amber-500 dark:bg-[#f59e0b]"
                : "bg-slate-400 dark:bg-[#627089]"
          }
          sub={`오류 ${fleet.errors} · 정지 ${fleet.paused} · 승인 ${fleet.approvals}`}
          active={statusFilter === "attention"}
          onClick={() => handleStatusSelect("attention")}
        />
      </section>

      {/* Widescreen primary toolbar: search + adapter/role filters + view toggle + new agent */}
      <div className="tactile-card flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-slate-200/90 bg-white px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_6px_20px_-12px_rgba(0,0,0,0.7)]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {/* Search input */}
          <label className="relative flex min-w-[180px] flex-1 max-w-xs items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground dark:text-[#627089]"
              aria-hidden
            />
            <input
              ref={searchInputRef}
              type="search"
              aria-label="에이전트 검색"
              placeholder="이름, 역할, 어댑터, 모델 검색 (/)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(CONTROL, "w-full pl-8")}
            />
          </label>

          {/* Adapter filter */}
          <select
            aria-label="어댑터 필터"
            value={adapterFilter}
            onChange={(e) => setAdapterFilter(e.target.value)}
            className={cn(CONTROL, "hidden sm:block")}
          >
            <option value="all">전체 어댑터</option>
            {adapterOptions.map((adapter) => (
              <option key={adapter} value={adapter}>
                {adapterLabels[adapter] ?? adapter}
              </option>
            ))}
          </select>

          {/* Role filter */}
          <select
            aria-label="역할 필터"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className={cn(CONTROL, "hidden md:block")}
          >
            <option value="all">전체 역할</option>
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {roleLabels[role] ?? role}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 dark:border-primary/35 dark:bg-primary/15 dark:text-primary dark:hover:bg-primary/25"
            >
              <X className="h-3 w-3" />
              필터 초기화
            </button>
          )}

          <span className="hidden text-[11px] text-muted-foreground xl:inline dark:text-[#627089]">
            표시{" "}
            <span className="font-mono font-semibold text-foreground dark:text-[#eef2f8]">
              {filtered.length}
            </span>
            명
          </span>
        </div>

        {/* Right controls: extra filters + view toggle + New Agent */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs transition-colors dark:border-white/[0.09] dark:bg-background",
                filtersOpen || activeExtraFilterCount > 0
                  ? "text-foreground dark:bg-[#151d2e] dark:text-[#eef2f8]"
                  : "text-muted-foreground hover:text-foreground dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
              )}
              aria-expanded={filtersOpen}
              aria-label="에이전트 필터 옵션"
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">옵션</span>
              {activeExtraFilterCount > 0 && (
                <span className="rounded bg-blue-500/15 px-1 font-mono text-[10px] tabular-nums text-blue-600 dark:bg-primary/20 dark:text-primary">
                  {activeExtraFilterCount}
                </span>
              )}
            </button>
            {filtersOpen && (
              <div className="tactile-card absolute right-0 top-full z-50 mt-1.5 w-56 rounded-[12px] border border-slate-200/90 bg-white p-1.5 shadow-lg dark:border-white/[0.12] dark:bg-[#121826] dark:bg-none">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted dark:text-[#eef2f8] dark:hover:bg-white/[0.06]"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border dark:border-white/20",
                      showTerminated && "bg-foreground dark:bg-emerald-300 dark:border-emerald-300",
                    )}
                  >
                    {showTerminated && (
                      <span className="text-[10px] leading-none text-background">
                        &#10003;
                      </span>
                    )}
                  </span>
                  종료된 에이전트 포함
                </button>
                {(adapterFilter !== "all" || roleFilter !== "all" || query.trim() !== "") && (
                  <button
                    type="button"
                    className="mt-1 flex w-full items-center justify-center rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground dark:border-white/[0.08] dark:text-[#9aa7bd] dark:hover:bg-white/[0.06]"
                    onClick={() => {
                      setAdapterFilter("all");
                      setRoleFilter("all");
                      setQuery("");
                      setFiltersOpen(false);
                    }}
                  >
                    검색/필터 초기화
                  </button>
                )}
              </div>
            )}
          </div>

          {/* View toggle: 텔레메트리 카드 (default) ↔ 목록 ↔ 조직도 */}
          <div
            role="group"
            aria-label="보기 전환"
            className="flex items-center overflow-hidden rounded-lg border border-border bg-muted/40 p-0.5 dark:border-white/[0.08] dark:bg-background"
          >
            <button
              type="button"
              aria-label="텔레메트리 카드 보기"
              aria-pressed={effectiveView === "cards"}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                effectiveView === "cards"
                  ? "bg-background text-foreground shadow-xs dark:bg-[#151d2e] dark:text-emerald-300"
                  : "text-muted-foreground hover:text-foreground dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
              )}
              onClick={() => setView("cards")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">텔레메트리 카드</span>
            </button>
            <button
              type="button"
              aria-label="목록 보기"
              aria-pressed={effectiveView === "list"}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                effectiveView === "list"
                  ? "bg-background text-foreground shadow-xs dark:bg-[#151d2e] dark:text-[#eef2f8]"
                  : "text-muted-foreground hover:text-foreground dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
              )}
              onClick={() => setView("list")}
            >
              <List className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">목록</span>
            </button>
            {!isMobile && (
              <button
                type="button"
                aria-label="조직도 보기"
                aria-pressed={effectiveView === "org"}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                  effectiveView === "org"
                    ? "bg-background text-foreground shadow-xs dark:bg-[#151d2e] dark:text-[#eef2f8]"
                    : "text-muted-foreground hover:text-foreground dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">조직도</span>
              </button>
            )}
          </div>

          <Button
            size="sm"
            variant="outline"
            disabled={!canAdmin}
            title={!canAdmin ? "Admin or owner role required to hire agents" : undefined}
            onClick={() => {
              if (!canAdmin) return;
              openNewAgent();
            }}
            className="h-8 border-transparent bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New Agent
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message={
            canAdmin
              ? "Create your first agent to get started."
              : "No agents yet. Admin or owner role required to hire agents."
          }
          action={canAdmin ? "New Agent" : undefined}
          onAction={canAdmin ? openNewAgent : undefined}
        />
      )}

      {/* Wide 2–3 column Agent Telemetry Card Grid (Primary Reading Zone) */}
      {effectiveView === "cards" && filtered.length > 0 && (
        <section
          aria-label="에이전트 텔레메트리 카드"
          className={cn(
            "grid gap-4",
            filtered.length === 1
              ? "grid-cols-1 max-w-2xl"
              : "grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3",
          )}
        >
          {filtered.map((agent) => {
            const ref = agentRouteRef(agent);
            const live = liveRunByAgent.get(agent.id);
            return (
              <AgentTelemetryCard
                key={agent.id}
                agent={agent}
                roleLabel={roleLabels[agent.role] ?? agent.role}
                adapterLabel={adapterLabels[agent.adapterType] ?? agent.adapterType}
                detailHref={agentUrl(agent)}
                liveRun={live}
                liveRunHref={live ? `/agents/${ref}/runs/${live.runId}` : undefined}
                recentRuns={recentRunsByAgent.get(agent.id) ?? []}
                usageShare={usageShareByAgent.get(agent.id) ?? null}
              />
            );
          })}
        </section>
      )}

      {effectiveView === "cards" && agents && agents.length > 0 && filtered.length === 0 && (
        <div className="tactile-card rounded-[12px] border border-dashed border-slate-300/90 bg-white/80 py-10 text-center text-sm text-slate-500 dark:border-white/[0.12] dark:bg-card dark:bg-none dark:text-[#9aa7bd]">
          선택한 필터에 해당하는 에이전트가 없습니다.
        </div>
      )}

      {/* Compact List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white divide-y divide-slate-200/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:divide-white/[0.065] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
          {filtered.map((agent) => (
            <AgentRow
              key={agent.id}
              to={agentUrl(agent)}
              name={agent.name}
              sub={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
              dot={agentStatusDot[agent.status] ?? agentStatusDotDefault}
              adapter={adapterLabels[agent.adapterType] ?? agent.adapterType}
              heartbeat={agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
              status={agent.status}
              live={liveRunByAgent.get(agent.id)}
              agentRef={agentRouteRef(agent)}
            />
          ))}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          선택한 필터에 해당하는 에이전트가 없습니다.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white divide-y divide-slate-200/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:divide-white/[0.065] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          선택한 필터에 해당하는 에이전트가 없습니다.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          정의된 조직 계층 구조가 없습니다.
        </p>
      )}
    </div>
  );
}

/** Fixed-track grid row for compact list / org views. */
function AgentRow({
  to,
  name,
  sub,
  dot,
  adapter,
  heartbeat,
  status,
  live,
  agentRef,
  style,
}: {
  to: string;
  name: string;
  sub: string;
  dot: string;
  adapter: string | null;
  heartbeat: string | null;
  status: string;
  live?: AgentLiveRunSummary;
  agentRef: string;
  style?: CSSProperties;
}) {
  return (
    <Link
      to={to}
      style={style}
      className={cn(
        ROW_TRACKS,
        "w-full px-3.5 py-2.5 text-left no-underline text-inherit transition-colors hover:bg-muted/50 dark:hover:bg-[#141b2a]",
      )}
    >
      <span className="relative flex h-2.5 w-2.5">
        <span className={`absolute inline-flex h-full w-full rounded-full ${dot}`} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground dark:text-[#eef2f8]">
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground dark:text-[#9aa7bd]">{sub}</span>
      </span>
      {adapter && (
        <span
          title={adapter}
          className="hidden truncate font-mono text-xs text-muted-foreground sm:block dark:text-[#9aa7bd]"
        >
          {adapter}
        </span>
      )}
      {heartbeat && (
        <span className="hidden truncate text-right font-mono text-xs tabular-nums text-muted-foreground sm:block dark:text-[#627089]">
          {heartbeat}
        </span>
      )}
      <span className="flex items-center justify-end gap-2">
        {live && (
          <LiveRunIndicator
            agentRef={agentRef}
            runId={live.runId}
            liveCount={live.liveCount}
          />
        )}
        <StatusBadge status={status} />
      </span>
    </Link>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, AgentLiveRunSummary>;
}) {
  const agent = agentMap.get(node.id);
  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <AgentRow
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        name={node.name}
        sub={roleLabels[node.role] ?? node.role}
        dot={agentStatusDot[node.status] ?? agentStatusDotDefault}
        adapter={agent ? adapterLabels[agent.adapterType] ?? agent.adapterType : null}
        heartbeat={agent ? (agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—") : null}
        status={node.status}
        live={liveRunByAgent.get(node.id)}
        agentRef={agent ? agentRouteRef(agent) : node.id}
      />
      {node.reports.length > 0 && (
        <div className="ml-4 border-l border-border dark:border-white/[0.08]">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 rounded-full bg-emerald-700/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 no-underline transition-colors hover:bg-emerald-700/20 dark:bg-emerald-300/15 dark:text-emerald-300"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-700 opacity-75 dark:bg-emerald-300" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-700 dark:bg-emerald-300" />
      </span>
      Live{liveCount > 1 ? ` (${liveCount})` : ""}
    </Link>
  );
}

import { useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { queryKeys } from "../lib/queryKeys";
import { useSidebarDensity } from "../lib/sidebar-slide-physics";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarWaitChip, resolveAgentWaitState, type AgentWaitState } from "./SidebarWaitChip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

/** running = live run · attention = waiting on a human, a budget pause, an approval or an error · idle = the rest. */
type AgentActivity = "running" | "attention" | "idle";
type PinnedActivity = Exclude<AgentActivity, "idle">;
interface AgentEntry {
  agent: Agent;
  runCount: number;
  waitState: AgentWaitState | null;
  activity: AgentActivity;
}

const STATUS_DOT: Record<PinnedActivity, { color: string; glow: string; label: string }> = {
  running: { color: "var(--pw-lime)", glow: "var(--pw-lime-glow)", label: "Running" },
  attention: { color: "var(--pw-amber, #f59e0b)", glow: "rgba(245,158,11,0.35)", label: "Needs attention" },
};
/** Compact right-aligned mono pill: never shrinks or wraps. */
const COUNT_PILL =
  "inline-flex h-[16px] shrink-0 tabular-nums items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 font-mono text-[9.5px] font-medium leading-none";
const AMBER_PILL = "bg-amber-500/15 text-amber-700 dark:text-[var(--pw-amber)]";
const LIVE_PILL = "bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]";
const IDLE_TOGGLE =
  "mt-1 flex w-full items-center rounded-[7px] font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-slate-200/50 hover:text-foreground dark:hover:bg-white/[0.04] dark:hover:text-[#eef2f8]";

/** BFS sort: roots first (no reportsTo), then their direct reports, etc. */
function sortByHierarchy(agents: Agent[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const parent = a.reportsTo && byId.has(a.reportsTo) ? a.reportsTo : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const sorted: Agent[] = [];
  const queue = childrenOf.get(null) ?? [];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }
  return sorted;
}

function classifyAgentActivity(agent: Agent, waitState: AgentWaitState | null): AgentActivity {
  if (waitState && waitState.kind !== "live") return "attention";
  if (agent.pauseReason === "budget" || agent.status === "pending_approval" || agent.status === "error") {
    return "attention";
  }
  return waitState || agent.status === "running" ? "running" : "idle";
}

function AgentStatusDot({ kind, corner }: { kind: PinnedActivity; corner?: boolean }) {
  const meta = STATUS_DOT[kind];
  return (
    <span title={meta.label} className={cn("relative flex h-1.5 w-1.5 shrink-0", corner && "absolute right-1 top-1")}>
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
        style={{ backgroundColor: meta.color }}
      />
      <span
        className="relative inline-flex h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color, boxShadow: `0 0 8px ${meta.glow}` }}
      />
    </span>
  );
}

function AgentRow({ entry, to, active, compact }: { entry: AgentEntry; to: string; active: boolean; compact: boolean }) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { agent, runCount, waitState, activity } = entry;
  const budgetPaused = agent.pauseReason === "budget";
  const livePill = !compact && (waitState?.kind === "live" || (activity === "running" && runCount > 0));
  const showDot = activity !== "idle" && !(compact && waitState);
  const statusPill =
    !compact && activity === "attention" && !waitState && !budgetPaused
      ? agent.status === "error" ? "ERR" : "WAIT"
      : null;
  const showTrailing = budgetPaused || livePill || waitState != null || statusPill != null;
  const roleMeta = agent.title || agent.role || agent.adapterType;
  const rightMeta = activity === "running" ? (runCount > 0 ? `${runCount} run` : "active") : activity === "attention" ? "attention" : "idle";

  if (compact) {
    return (
      <NavLink
        to={to}
        title={agent.name}
        aria-label={agent.name}
        onClick={() => {
          if (isMobile) setSidebarOpen(false);
        }}
        className={cn(
          "relative mx-auto flex h-8 w-8 items-center justify-center rounded-[8px] border transition-all duration-150",
          active
            ? "border-slate-200/90 bg-white text-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#eef2f8]"
            : "border-transparent text-muted-foreground hover:bg-slate-200/50 hover:text-foreground dark:hover:bg-white/[0.04] dark:hover:text-[#eef2f8]",
        )}
      >
        {showDot && <AgentStatusDot kind={activity} corner />}
        <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" />
      </NavLink>
    );
  }

  return (
    <NavLink
      to={to}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "block rounded-[8px] border px-2 py-[7px] transition-all duration-150",
        active
          ? "border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.95)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
          : "border-transparent bg-slate-100/60 hover:border-slate-200/90 hover:bg-white dark:bg-white/[0.015] dark:hover:border-white/[0.065] dark:hover:bg-white/[0.045] dark:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
      )}
    >
      <div className="mb-0.5 flex items-center justify-between gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-foreground">
          {showDot ? (
            <AgentStatusDot kind={activity} />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400/50 dark:bg-white/20" />
          )}
          <span className="truncate">{agent.name}</span>
        </span>
        {showTrailing && (
          <span className="flex shrink-0 items-center gap-1">
            {budgetPaused && <BudgetSidebarMarker title="Agent paused by budget" />}
            {livePill && (
              <span title={`${runCount} live run${runCount === 1 ? "" : "s"}`} className={cn(COUNT_PILL, LIVE_PILL)}>
                {runCount > 1 ? `${runCount} LIVE` : "LIVE"}
              </span>
            )}
            {waitState && !livePill && <SidebarWaitChip state={waitState} provider={agent.adapterType} compact={false} />}
            {statusPill && <span className={cn(COUNT_PILL, AMBER_PILL)}>{statusPill}</span>}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 pl-3 font-mono text-[10px] text-muted-foreground">
        <span className="truncate">{roleMeta}</span>
        <span className="shrink-0 opacity-75">{rightMeta}</span>
      </div>
    </NavLink>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  // Idle agents stay collapsed by default behind a 1-line `대기 (N)` toggle.
  const [idleOpen, setIdleOpen] = useState(false);
  const { selectedCompanyId, canWrite } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const { compact: rawCompact } = useSidebarDensity();
  const compact = rawCompact && !isMobile;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: pendingDecisions } = useQuery({
    queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending"),
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending", 50),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    retry: false,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter((a: Agent) => a.status !== "terminated");
    return sortByHierarchy(filtered);
  }, [agents]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  /** Pinned = running or needs attention; everything else folds into Idle. Both groups keep the hierarchy order. */
  const { pinned, idle } = useMemo(() => {
    const groups = { pinned: [] as AgentEntry[], idle: [] as AgentEntry[] };
    for (const agent of visibleAgents) {
      const runCount = liveCountByAgent.get(agent.id) ?? 0;
      const waitState = resolveAgentWaitState({
        agentId: agent.id,
        pendingDecisions: pendingDecisions?.data,
        liveRunCount: runCount,
      });
      const entry: AgentEntry = { agent, runCount, waitState, activity: classifyAgentActivity(agent, waitState) };
      (entry.activity === "idle" ? groups.idle : groups.pinned).push(entry);
    }
    return groups;
  }, [visibleAgents, liveCountByAgent, pendingDecisions]);

  const idleLabel = `대기 (${idle.length})`;
  const renderRow = (entry: AgentEntry) => (
    <AgentRow
      key={entry.agent.id}
      entry={entry}
      to={activeTab ? `${agentUrl(entry.agent)}/${activeTab}` : agentUrl(entry.agent)}
      active={activeAgentId === agentRouteRef(entry.agent)}
      compact={compact}
    />
  );

  return (
    <Collapsible open={compact ? true : open} onOpenChange={setOpen} className="flex min-h-0 flex-1 flex-col">
      {compact ? (
        <div className="mb-1 flex justify-center border-t border-sidebar-border pt-1.5">
          {canWrite !== false && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openNewAgent();
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
              aria-label="New agent"
              title="New agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="mb-1 flex shrink-0 items-center justify-between px-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 text-left">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              실행 중인 에이전트
            </span>
          </CollapsibleTrigger>
          <div className="flex items-center gap-1.5">
            <span
              title={`${pinned.length} active agent${pinned.length === 1 ? "" : "s"}`}
              className="font-mono text-[10px] font-medium tabular-nums text-[var(--pw-lime)]"
            >
              ● {pinned.length}
            </span>
            <NavLink
              to="/agents"
              onClick={(e) => {
                e.stopPropagation();
                if (isMobile) setSidebarOpen(false);
              }}
              className="rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              title="전체 에이전트 보기"
            >
              전체 →
            </NavLink>
            {canWrite !== false && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openNewAgent();
                }}
                className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
                aria-label="New agent"
                title="New agent"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <CollapsibleContent className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-1">
          {pinned.map(renderRow)}
        </div>
        {idle.length > 0 && (
          <Collapsible open={idleOpen} onOpenChange={setIdleOpen}>
            <CollapsibleTrigger
              aria-label={idleLabel}
              title={idleLabel}
              className={cn(IDLE_TOGGLE, compact ? "h-7 justify-center" : "h-7 gap-1.5 px-2")}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform duration-150", idleOpen && "rotate-90")} />
              <span className="tabular-nums">{compact ? idle.length : idleLabel}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 flex flex-col gap-1">
              {idle.map(renderRow)}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

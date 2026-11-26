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

/** Idle rows fold away by default once there are more than this many. */
const IDLE_COLLAPSE_THRESHOLD = 3;

/** running = live run · attention = waiting on a human, a budget pause, an approval or an error · idle = the rest. */
type AgentActivity = "running" | "attention" | "idle";
type PinnedActivity = Exclude<AgentActivity, "idle">;
interface AgentEntry {
  agent: Agent;
  runCount: number;
  waitState: AgentWaitState | null;
  activity: AgentActivity;
}

const STATUS_DOT: Record<PinnedActivity, { color: string; label: string }> = {
  running: { color: "var(--pw-emerald, #34d399)", label: "Running" },
  attention: { color: "var(--pw-amber, #fbbf24)", label: "Needs attention" },
};
/** Compact right-aligned pill: never shrinks or wraps, so it cannot collide with the agent name. */
const COUNT_PILL = "inline-flex h-[18px] shrink-0 tabular-nums items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[11px] font-medium leading-none";
const SUBTLE_PILL = "border-border bg-muted text-muted-foreground dark:border-[#242d3f] dark:bg-[#111622]";
const AMBER_PILL = "border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-[var(--pw-amber)]";
const LIVE_PILL = cn(SUBTLE_PILL, "dark:text-[var(--pw-emerald)]");
const IDLE_TOGGLE =
  "mt-0.5 flex w-full items-center rounded-[9px] text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";

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
    <span title={meta.label} className={cn("relative flex h-2 w-2 shrink-0", corner && "absolute right-0.5 top-0.5")}>
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
        style={{ backgroundColor: meta.color }}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
    </span>
  );
}

function AgentRow({ entry, to, active, compact }: { entry: AgentEntry; to: string; active: boolean; compact: boolean }) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { agent, runCount, waitState, activity } = entry;
  const budgetPaused = agent.pauseReason === "budget";
  // Expanded rows replace the live-run chip with a concise count pill; the mini bar keeps the chip (and skips the dot).
  const livePill = !compact && waitState?.kind === "live";
  const showDot = activity !== "idle" && !(compact && waitState);
  // Pinned by agent status alone (no pending decision card, no budget pause): surface the reason.
  const statusPill =
    !compact && activity === "attention" && !waitState && !budgetPaused
      ? agent.status === "error" ? "Error" : "Approval"
      : null;
  const showTrailing = budgetPaused || waitState != null || statusPill != null;

  return (
    <NavLink
      to={to}
      title={compact ? agent.name : undefined}
      aria-label={compact ? agent.name : undefined}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "relative flex items-center text-[13px] font-medium transition-colors",
        compact ? "justify-center gap-1 px-1.5 py-1.5" : "gap-2 px-3 py-1.5",
        active
          ? "bg-accent text-foreground"
          : activity === "idle"
            ? "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {showDot && <AgentStatusDot kind={activity} corner={compact} />}
      <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
      {!compact && (
        <span className="min-w-0 flex-1">
          <span className="block truncate">{agent.name}</span>
          {agent.title && (
            <span className="block truncate text-[10px] font-normal text-muted-foreground/60 leading-tight">
              {agent.title}
            </span>
          )}
        </span>
      )}
      {showTrailing && (
        <span className={cn("flex shrink-0 items-center gap-1.5", !compact && "ml-auto")}>
          {budgetPaused && <BudgetSidebarMarker title="Agent paused by budget" />}
          {livePill && (
            <span title={`${runCount} live run${runCount === 1 ? "" : "s"}`} className={cn(COUNT_PILL, LIVE_PILL)}>
              {runCount} live
            </span>
          )}
          {waitState && !livePill && <SidebarWaitChip state={waitState} provider={agent.adapterType} compact={compact} />}
          {statusPill && <span className={cn(COUNT_PILL, AMBER_PILL)}>{statusPill}</span>}
        </span>
      )}
    </NavLink>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  // null = follow the default (collapse once the idle group grows past the threshold); otherwise the user's last toggle.
  const [idleOpenOverride, setIdleOpenOverride] = useState<boolean | null>(null);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile } = useSidebar();
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
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
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

  const idleOpen = idleOpenOverride ?? idle.length <= IDLE_COLLAPSE_THRESHOLD;
  const idleLabel = `Idle (${idle.length})`;
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
    <Collapsible open={compact ? true : open} onOpenChange={setOpen}>
      {compact ? (
        <div className="flex justify-center border-t border-sidebar-border pt-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New agent"
            title="New agent"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="group">
          <div className="flex items-center px-3 py-1.5">
            <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
              <ChevronRight
                className={cn(
                  "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                  open && "rotate-90"
                )}
              />
              <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
                Agents
              </span>
            </CollapsibleTrigger>
            {pinned.length > 0 && (
              <span title={`${pinned.length} active agent${pinned.length === 1 ? "" : "s"}`} className={cn(COUNT_PILL, SUBTLE_PILL, "mr-1")}>
                {pinned.length}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                openNewAgent();
              }}
              className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
              aria-label="New agent"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {pinned.map(renderRow)}
        </div>
        {idle.length > 0 && (
          <Collapsible open={idleOpen} onOpenChange={setIdleOpenOverride}>
            <CollapsibleTrigger
              aria-label={idleLabel}
              title={idleLabel}
              className={cn(IDLE_TOGGLE, compact ? "h-7 justify-center" : "h-7 gap-1.5 px-3")}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", idleOpen && "rotate-90")} />
              <span className="tabular-nums">{compact ? idle.length : idleLabel}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-0.5 flex flex-col gap-0.5">
              {idle.map(renderRow)}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

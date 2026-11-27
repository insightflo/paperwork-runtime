import { NavLink } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarWaitChip, type AgentWaitState } from "./SidebarWaitChip";
import type { Agent } from "@paperclipai/shared";

/** running = live run · attention = waiting on a human, a budget pause, an approval or an error · idle = the rest. */
export type AgentActivity = "running" | "attention" | "idle";
type PinnedActivity = Exclude<AgentActivity, "idle">;
export interface AgentEntry {
  agent: Agent;
  runCount: number;
  waitState: AgentWaitState | null;
  activity: AgentActivity;
}

const STATUS_DOT: Record<PinnedActivity, { color: string; glow: string; label: string }> = {
  running: { color: "var(--pw-lime)", glow: "var(--pw-lime-glow)", label: "Running" },
  attention: { color: "var(--pw-amber)", glow: "var(--pw-amber-soft)", label: "Needs attention" },
};
/** Compact right-aligned mono pill: never shrinks or wraps. */
const COUNT_PILL =
  "inline-flex h-[16px] shrink-0 tabular-nums items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 font-mono text-[9.5px] font-medium leading-none";
const AMBER_PILL = "bg-amber-500/15 text-amber-700 dark:text-[var(--pw-amber)]";
const LIVE_PILL = "bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]";

/** BFS sort: roots first (no reportsTo), then their direct reports, etc. */
export function sortByHierarchy(agents: Agent[]): Agent[] {
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

export function classifyAgentActivity(agent: Agent, waitState: AgentWaitState | null): AgentActivity {
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

export function AgentRow({ entry, to, active, compact }: { entry: AgentEntry; to: string; active: boolean; compact: boolean }) {
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
            ? "border-slate-200/90 bg-white text-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-foreground"
            : "border-transparent text-muted-foreground hover:bg-slate-200/50 hover:text-foreground dark:hover:bg-white/[0.04] dark:hover:text-foreground",
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

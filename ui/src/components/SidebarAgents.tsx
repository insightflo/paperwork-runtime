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
import { resolveAgentWaitState } from "./SidebarWaitChip";
import { AgentRow, classifyAgentActivity, sortByHierarchy, type AgentEntry } from "./SidebarAgentRow";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

const IDLE_TOGGLE =
  "mt-1 flex w-full items-center rounded-[7px] font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-slate-200/50 hover:text-foreground dark:hover:bg-white/[0.04] dark:hover:text-foreground";

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

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
import { SidebarWaitChip, resolveAgentWaitState } from "./SidebarWaitChip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

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

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
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
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return sortByHierarchy(filtered);
  }, [agents]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;


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
          {visibleAgents.map((agent: Agent) => {
            const runCount = liveCountByAgent.get(agent.id) ?? 0;
            const waitState = resolveAgentWaitState({
              agentId: agent.id,
              pendingDecisions: pendingDecisions?.data,
              liveRunCount: runCount,
            });
            return (
              <NavLink
                key={agent.id}
                to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
                title={compact ? agent.name : undefined}
                aria-label={compact ? agent.name : undefined}
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
                className={cn(
                  "flex items-center text-[13px] font-medium transition-colors",
                  compact ? "justify-center gap-1 px-1.5 py-1.5" : "gap-2.5 px-3 py-1.5",
                  activeAgentId === agentRouteRef(agent)
                    ? "bg-accent text-foreground"
                    : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
                {!compact && (
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{agent.name}</span>
                    {agent.title && (
                      <span className="block truncate text-[10px] font-normal text-muted-foreground/60 leading-tight">
                        {agent.title}
                      </span>
                    )}
                  </span>
                )}
                {(agent.pauseReason === "budget" || waitState) && (
                  <span className={cn("flex items-center gap-1.5 shrink-0", !compact && "ml-auto")}>
                    {agent.pauseReason === "budget" ? (
                      <BudgetSidebarMarker title="Agent paused by budget" />
                    ) : null}
                    <SidebarWaitChip state={waitState} provider={agent.adapterType} compact={compact} />
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

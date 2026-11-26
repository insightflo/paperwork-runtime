import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
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
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal, Search } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  antigravity_local: "Antigravity",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  hermes_local: "Hermes",
  commandcode_local: "Command Code",
  pi_local: "Pi",
  cursor: "Cursor",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const CONTROL = "h-7 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] outline-none focus:border-[#5f8dff] placeholder:text-[#5c6a84]";
const STATUS_TABS: { value: FilterTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Error" },
];
/** Explicit column tracks: status dot | name+role (flexes, truncates) | adapter | heartbeat | status pill (max-content, never wraps). */
const ROW_TRACKS =
  "grid grid-cols-[0.875rem_minmax(0,1fr)_max-content] items-center gap-x-3 sm:grid-cols-[0.875rem_minmax(0,1fr)_7rem_4.5rem_max-content]";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || haystack.toLowerCase().includes(q);
}

function agentHaystack(agent: Agent): string {
  return [agent.name, agent.title ?? "", roleLabels[agent.role] ?? agent.role, adapterLabels[agent.adapterType] ?? agent.adapterType, agent.status.replace("_", " ")].join(" ");
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean, query: string): Agent[] {
  return agents.filter((a) => matchesFilter(a.status, tab, showTerminated) && matchesQuery(agentHaystack(a), query));
}

function filterOrgTree(nodes: OrgNode[], accept: (node: OrgNode) => boolean): OrgNode[] {
  return nodes.reduce<OrgNode[]>((acc, node) => {
    const reports = filterOrgTree(node.reports, accept);
    if (accept(node) || reports.length > 0) acc.push({ ...node, reports });
    return acc;
  }, []);
}

/** One cell of the 1-row fleet telemetry strip: label (with micro status dot) / bold value / muted sub. */
function FleetCell({ to, label, value, sub, dot }: { to: string; label: string; value: number; sub: string; dot: string }) {
  return (
    <Link to={to} className="flex min-w-0 flex-col gap-0.5 px-3 py-2 no-underline text-inherit transition-colors hover:bg-[#151b28]">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[#8b97ad]">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-xl font-bold leading-tight tabular-nums text-[#e6edf7]">{value}</span>
      <span className="truncate text-[11px] tabular-nums text-[#8b97ad]">{sub}</span>
    </Link>
  );
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");

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

  const { data: runs } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const fleet = useMemo(() => {
    const list = (agents ?? []).filter((a) => showTerminated || a.status !== "terminated");
    const count = (status: string) => list.filter((a) => a.status === status).length;
    const running = count("running");
    return {
      total: list.length,
      active: count("active") + running,
      running,
      errors: count("error"),
      approvals: count("pending_approval"),
      idle: count("idle"),
      paused: count("paused"),
      live: liveRunByAgent.size,
    };
  }, [agents, showTerminated, liveRunByAgent]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated, query);
  const filteredOrg = filterOrgTree(orgTree ?? [], (node) => {
    if (!matchesQuery([node.name, roleLabels[node.role] ?? node.role, node.status.replace("_", " ")].join(" "), query)) return false;
    const agent = agentMap.get(node.id);
    return agent ? matchesFilter(agent.status, tab, showTerminated) : matchesFilter(node.status, tab, showTerminated);
  });

  return (
    <div className="space-y-3 tabular-nums">
      {/* 1-row 4-column fleet telemetry strip */}
      <section aria-label="Fleet telemetry" className="grid grid-cols-2 divide-x divide-[#242d3f] rounded-md border border-[#242d3f] bg-[#111622] lg:grid-cols-4">
        <FleetCell to="/agents/all" label="Total" value={fleet.total} dot="bg-[#5f8dff]" sub={`${fleet.live} live · ${fleet.paused} paused`} />
        <FleetCell to="/agents/active" label="Active / Running" value={fleet.active} dot={cn("bg-[#34d399]", fleet.running > 0 && "animate-pulse")} sub={`${fleet.running} running · ${fleet.active - fleet.running} ready`} />
        <FleetCell to="/agents/error" label="Attention / Blocked" value={fleet.errors + fleet.approvals} dot={fleet.errors + fleet.approvals > 0 ? "bg-[#f87171]" : "bg-[#4a5670]"} sub={`${fleet.errors} error · ${fleet.approvals} approval`} />
        <FleetCell to="/agents/active" label="Idle" value={fleet.idle} dot="bg-[#fbbf24]" sub={`${fleet.paused} paused`} />
      </section>

      {/* Tight single-row 40px filter / search / action toolbar. Filters scroll; actions stay pinned. */}
      <div className="flex h-10 items-center gap-2 rounded-md border border-[#242d3f] bg-[#111622] pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden">
          {isMobile ? (
            <select aria-label="Filter agents by status" value={tab} onChange={(e) => navigate(`/agents/${e.target.value}`)} className={cn(CONTROL, "shrink-0")}>
              {STATUS_TABS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          ) : (
            <div role="group" aria-label="Filter agents by status" className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
              {STATUS_TABS.map((item) => {
                const active = tab === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => navigate(`/agents/${item.value}`)}
                    className={cn(
                      "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors",
                      active ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_0_0_1px_#242d3f]" : "text-[#8b97ad] hover:text-[#e6edf7]"
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
          <label className="flex shrink-0 items-center gap-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" aria-hidden />
            <input
              type="search"
              aria-label="Search agents"
              placeholder="Search name, role, adapter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn(CONTROL, "w-56")}
            />
          </label>
          <span className="hidden shrink-0 text-[11px] text-[#8b97ad] sm:block">
            <span className="font-mono text-[#e6edf7]">{filtered.length}</span> agent{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Filters */}
          <div className="relative">
            <button
              type="button"
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs transition-colors",
                filtersOpen || showTerminated ? "text-[#e6edf7] bg-[#151b28]" : "text-[#8b97ad] hover:text-[#e6edf7]"
              )}
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 rounded bg-[#5f8dff]/15 px-1 font-mono text-[10px] tabular-nums text-[#5f8dff]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-[#242d3f] bg-[#151b28] p-1 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-[#e6edf7] hover:bg-[#1b2433]"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-[#242d3f]",
                    showTerminated && "bg-[#e6edf7]"
                  )}>
                    {showTerminated && <span className="text-[10px] leading-none text-[#0b0e14]">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center overflow-hidden rounded-md border border-[#242d3f] bg-[#0b0e14]">
              <button
                type="button"
                aria-label="List view"
                aria-pressed={effectiveView === "list"}
                className={cn("flex h-7 w-7 items-center justify-center transition-colors", effectiveView === "list" ? "bg-[#151b28] text-[#e6edf7]" : "text-[#8b97ad] hover:text-[#e6edf7]")}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Org chart view"
                aria-pressed={effectiveView === "org"}
                className={cn("flex h-7 w-7 items-center justify-center transition-colors", effectiveView === "org" ? "bg-[#151b28] text-[#e6edf7]" : "text-[#8b97ad] hover:text-[#e6edf7]")}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent} className="h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]">
            <Plus className="h-3.5 w-3.5" />
            New Agent
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="overflow-hidden rounded-md border border-[#242d3f] bg-[#111622] divide-y divide-[#242d3f]">
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
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="overflow-hidden rounded-md border border-[#242d3f] bg-[#111622] divide-y divide-[#242d3f]">
          {filteredOrg.map((node) => (
            <OrgTreeNode key={node.id} node={node} depth={0} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

type LiveRun = { runId: string; liveCount: number };

/** Fixed-track grid row: name/role flex+truncate, adapter/heartbeat fixed, status pill sized to content so nothing collides or wraps. */
function AgentRow({ to, name, sub, dot, adapter, heartbeat, status, live, agentRef, style }: {
  to: string;
  name: string;
  sub: string;
  dot: string;
  adapter: string | null;
  heartbeat: string | null;
  status: string;
  live?: LiveRun;
  agentRef: string;
  style?: CSSProperties;
}) {
  return (
    <Link to={to} style={style} className={cn(ROW_TRACKS, "w-full px-3 py-2 text-left no-underline text-inherit transition-colors hover:bg-[#151b28]")}>
      <span className="relative flex h-2.5 w-2.5">
        <span className={`absolute inline-flex h-full w-full rounded-full ${dot}`} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-[#e6edf7]">{name}</span>
        <span className="truncate text-xs text-[#8b97ad]">{sub}</span>
      </span>
      {adapter && <span title={adapter} className="hidden truncate text-xs font-mono text-[#8b97ad] sm:block">{adapter}</span>}
      {heartbeat && <span className="hidden truncate text-right text-xs text-[#8b97ad] sm:block">{heartbeat}</span>}
      <span className="flex items-center justify-end gap-2">
        {live && <LiveRunIndicator agentRef={agentRef} runId={live.runId} liveCount={live.liveCount} />}
        <StatusBadge status={status} />
      </span>
    </Link>
  );
}

function OrgTreeNode({ node, depth, agentMap, liveRunByAgent }: { node: OrgNode; depth: number; agentMap: Map<string, Agent>; liveRunByAgent: Map<string, LiveRun> }) {
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
        <div className="border-l border-[#242d3f] ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({ agentRef, runId, liveCount }: { agentRef: string; runId: string; liveCount: number }) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 no-underline transition-colors hover:bg-blue-500/20 dark:text-blue-400"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      Live{liveCount > 1 ? ` (${liveCount})` : ""}
    </Link>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";

// Combo 1 cockpit palette: light slate surfaces, obsidian #0e131d/#090c12 dark surfaces, cobalt/lime/amber signals.
const PANEL = "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]";
/** Deep-cobalt primary CTA — the single governing action of this page. */
const PRIMARY_CTA =
  "ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white no-underline shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]";
/** Fixed column tracks: name (flexes, truncates) | role (truncates) | status pill (never wraps). */
const ROW_TRACKS = "grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_max-content]";

type StatusFilter = "all" | "active" | "paused" | "pending_approval" | "error";

const STATUS_FILTERS: { value: StatusFilter; label: string; dot: string }[] = [
  { value: "all", label: "Total", dot: "bg-blue-600 dark:bg-[#60a5fa]" },
  { value: "active", label: "Active", dot: "bg-lime-600 dark:bg-[#a3e635]" },
  { value: "paused", label: "Paused", dot: "bg-amber-600 dark:bg-[#f59e0b]" },
  { value: "pending_approval", label: "Approval", dot: "bg-violet-600 dark:bg-[#a78bfa]" },
  { value: "error", label: "Error", dot: "bg-rose-600 dark:bg-[#f87171]" },
];

function statusDot(status: string): string {
  if (status === "active") return "bg-lime-500 dark:bg-[#a3e635]";
  if (status === "paused") return "bg-amber-500 dark:bg-[#f59e0b]";
  if (status === "pending_approval") return "bg-amber-500 dark:bg-[#f59e0b]";
  if (status === "error") return "bg-rose-500 dark:bg-[#f87171]";
  return "bg-slate-400 dark:bg-[#8b97ad]";
}

/** Keep a node when it matches the filter itself or has a matching descendant, so the reporting path stays visible. */
function filterTree(nodes: OrgNode[], filter: StatusFilter): OrgNode[] {
  if (filter === "all") return nodes;
  return nodes.flatMap((node) => {
    const reports = filterTree(node.reports, filter);
    return node.status === filter || reports.length > 0 ? [{ ...node, reports }] : [];
  });
}

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className={cn(ROW_TRACKS, "h-9 px-3 text-sm no-underline text-inherit transition-colors hover:bg-slate-50 dark:hover:bg-[#141b29]")}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {hasChildren ? (
            <button
              className="p-0.5 text-slate-500 transition-colors hover:text-slate-900 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setExpanded(!expanded);
              }}
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
              />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <span className={cn("h-2 w-2 shrink-0 rounded-full", statusDot(node.status))} />
          <span className="min-w-0 truncate font-medium text-slate-900 dark:text-[#edf2fb]">{node.name}</span>
        </span>
        <span className="hidden min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad] sm:block">{node.role}</span>
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree nodes={node.reports} depth={depth + 1} hrefFn={hrefFn} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const stats = useMemo(() => {
    const counts: Record<string, number> = { all: 0, roots: data?.length ?? 0, active: 0, paused: 0, pending_approval: 0, error: 0 };
    const walk = (nodes: OrgNode[]) => {
      for (const node of nodes) {
        counts.all += 1;
        counts[node.status] = (counts[node.status] ?? 0) + 1;
        walk(node.reports);
      }
    };
    walk(data ?? []);
    return counts;
  }, [data]);

  const visible = useMemo(() => filterTree(data ?? [], filter), [data, filter]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-3 tabular-nums">
      {/* 1-row cockpit strip: agent counts double as status-filter shortcuts */}
      <div className="cockpit-strip tactile-card w-full gap-0 border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]" role="group" aria-label="Agents in the org chart by status">
        <span className="cockpit-cell min-w-0 shrink-0">
          <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate uppercase tracking-wide">Org Chart</span>
        </span>
        <span className="cockpit-cell shrink-0" title="Top-level agents">
          Roots <b className="ml-1 font-mono">{stats.roots}</b>
        </span>
        {STATUS_FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            title={`Show ${item.label.toLowerCase()} agents`}
            onClick={() => setFilter(item.value)}
            className={cn(
              "cockpit-cell min-w-0 flex-1 cursor-pointer justify-center transition-colors",
              filter === item.value
                ? "bg-blue-600/10 text-slate-900 shadow-[inset_0_-1px_0_#2563eb] dark:bg-[#151d2c] dark:text-[#edf2fb] dark:shadow-[inset_0_-1px_0_#60a5fa]"
                : "hover:bg-slate-100/80 hover:text-slate-900 dark:hover:bg-[#151d2c] dark:hover:text-[#edf2fb]",
            )}
          >
            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.dot)} />
            <span className="truncate uppercase tracking-wide">{item.label}</span>
            <b className="ml-1 font-mono">{stats[item.value] ?? 0}</b>
          </button>
        ))}
      </div>

      {/* Tight single-row 40px toolbar: visible/total readout · deep-cobalt canvas CTA. */}
      <div className="cockpit-toolbar tactile-card h-10 w-full rounded-[12px] border-slate-200/90 bg-white/95 pl-1.5 pr-1.5 dark:border-white/[0.08] dark:bg-[#0e131d]">
        <span className="shrink-0 text-[11px] text-slate-500 dark:text-[#8b97ad]">
          <b className="font-mono text-slate-900 dark:text-[#edf2fb]">{visible.length}</b> of {stats.all} agents shown
        </span>
        <Link to="/org" className={PRIMARY_CTA} title="Open the interactive org chart canvas">
          Open Org Chart
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div aria-label="Org chart" className={cn(PANEL, "overflow-hidden")}>
          <div className={cn(ROW_TRACKS, "h-7 border-b border-slate-200/90 px-3 text-[10.5px] uppercase tracking-[0.08em] text-slate-500 dark:border-white/[0.08] dark:text-[#8b97ad]")}>
            <span>Agent</span>
            <span className="hidden sm:block">Role</span>
            <span className="text-right">Status</span>
          </div>
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-[#8b97ad]">No agents match this filter.</div>
          )}
          <OrgTree nodes={visible} hrefFn={(id) => `/agents/${id}`} />
        </div>
      )}
    </div>
  );
}

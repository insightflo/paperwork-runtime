import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Network } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  depth: number;
  children: LayoutNode[];
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  return Math.max(CARD_W, childrenW + (node.reports.length - 1) * GAP_X);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number, depth: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];
  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    let cx = x + (totalW - childrenW - (node.reports.length - 1) * GAP_X) / 2;
    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y, depth + 1));
      cx += cw + GAP_X;
    }
  }
  return { id: node.id, name: node.name, role: node.role, status: node.status, x: x + (totalW - CARD_W) / 2, y, depth, children: layoutChildren };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];
  let x = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, PADDING, 0));
    x += w + GAP_X;
  }
  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

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

const statusDotColor: Record<string, string> = {
  running: "#60a5fa",
  active: "#a3e635",
  paused: "#f59e0b",
  idle: "#f59e0b",
  error: "#f87171",
  terminated: "#8b97ad",
};
const defaultDotColor = "#8b97ad";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const fitChartToScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const fitZoom = Math.min((containerW - 40) / bounds.width, (containerH - 40) / bounds.height, 1);
    setZoom(fitZoom);
    setPan({
      x: (containerW - bounds.width * fitZoom) / 2,
      y: (containerH - bounds.height * fitZoom) / 2,
    });
  }, [bounds]);

  const applyCenterZoom = useCallback((newZoom: number) => {
    const container = containerRef.current;
    if (container) {
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      const scale = newZoom / zoom;
      setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
    }
    setZoom(newZoom);
  }, [zoom, pan]);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;
    fitChartToScreen();
  }, [allNodes, fitChartToScreen]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({ x: dragStart.current.panX + e.clientX - dragStart.current.x, y: dragStart.current.panY + e.clientY - dragStart.current.y });
  }, [dragging]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);
    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  const depth = useMemo(() => allNodes.reduce((max, n) => Math.max(max, n.depth), 0) + 1, [allNodes]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div className="-m-4 flex min-h-[calc(100dvh-3rem)] flex-col gap-3 bg-slate-50 p-3 tabular-nums text-slate-900 md:-m-6 md:p-4 dark:bg-[#07090d] dark:text-[#edf2fb]">
      {/* 1-row cockpit strip: reporting-structure telemetry for the canvas below */}
      <div className="cockpit-strip tactile-card w-full shrink-0 gap-0 border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]" role="group" aria-label="Org chart summary">
        <span className="cockpit-cell shrink-0">
          <Network className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="uppercase tracking-wide">Org Chart</span>
        </span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Cards on the canvas">Agents <b className="ml-1 font-mono">{allNodes.length}</b></span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Top-level agents">Roots <b className="ml-1 font-mono">{layout.length}</b></span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Reporting lines">Reports <b className="ml-1 font-mono">{edges.length}</b></span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Deepest reporting level">Depth <b className="ml-1 font-mono">{depth}</b></span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Current canvas zoom">Zoom <b className="ml-1 font-mono text-blue-600 dark:text-[#60a5fa]">{Math.round(zoom * 100)}%</b></span>
      </div>
      <div
        ref={containerRef}
        className="tactile-card relative min-h-[420px] w-full flex-1 overflow-hidden rounded-[12px] border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-[#090c12]"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Zoom controls */}
        <div className="tactile-card absolute right-3 top-3 z-10 w-12 overflow-hidden rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]">
          <div className="border-b border-slate-200/90 px-1 py-1 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:border-white/[0.08] dark:text-[#8b97ad]">
            Zoom
          </div>
          <button type="button"
            className="flex h-7 w-full items-center justify-center text-sm text-slate-900 transition-colors hover:bg-slate-100 dark:text-[#edf2fb] dark:hover:bg-[#141b29]"
            onClick={() => applyCenterZoom(Math.min(zoom * 1.2, 2))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button"
            className="flex h-7 w-full items-center justify-center border-t border-slate-200/90 text-sm text-slate-900 transition-colors hover:bg-slate-100 dark:border-white/[0.08] dark:text-[#edf2fb] dark:hover:bg-[#141b29]"
            onClick={() => applyCenterZoom(Math.max(zoom * 0.8, 0.2))}
            aria-label="Zoom out"
          >
            &minus;
          </button>
          <div aria-live="polite" aria-atomic="true" className="border-t border-slate-200/90 px-1 py-1 text-center font-mono text-[10px] text-slate-500 tabular-nums dark:border-white/[0.08] dark:text-[#8b97ad]">
            {Math.round(zoom * 100)}%
          </div>
          <button type="button"
            className="flex h-7 w-full items-center justify-center border-t border-slate-200/90 bg-blue-600 text-[10px] font-semibold uppercase tracking-wider text-white transition-colors hover:bg-blue-500 dark:border-white/[0.08] dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
            onClick={fitChartToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            Fit
          </button>
        </div>

        {/* SVG layer for edges */}
        <svg className="pointer-events-none absolute inset-0 text-slate-300 dark:text-white/[0.14]" style={{ width: "100%", height: "100%" }}>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;
              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        </svg>

        {/* Card layer */}
        <div
          className="absolute inset-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;
            return (
              <div
                key={node.id}
                data-org-card role="link" tabIndex={0} aria-label={`Open agent ${node.name}`} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.click(); } }}
                className="tactile-card absolute cursor-pointer select-none rounded-[12px] border-slate-200/90 bg-white/95 transition-colors duration-150 hover:border-blue-500/60 dark:border-white/[0.08] dark:bg-[#0e131d] dark:hover:border-[#60a5fa]/70"
                style={{ left: node.x, top: node.y, width: CARD_W, minHeight: CARD_H }}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Agent icon + status dot */}
                  <div className="relative shrink-0">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/90 bg-slate-50 dark:border-white/[0.08] dark:bg-[#090c12]">
                      <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-slate-500 dark:text-[#edf2fb]/70" />
                    </div>
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-[#0e131d]"
                      style={{ backgroundColor: dotColor }}
                    />
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="w-full truncate text-sm font-semibold leading-tight text-slate-900 dark:text-[#edf2fb]">
                      {node.name}
                    </span>
                    <span className="mt-0.5 w-full truncate text-[10px] font-semibold uppercase leading-tight tracking-wider text-slate-500 dark:text-[#8b97ad]">
                      {agent?.title ?? ((AGENT_ROLE_LABELS as Record<string, string>)[node.role] ?? node.role)}
                    </span>
                    {agent && (
                      <span className="mt-1 w-full truncate font-mono text-[10px] uppercase leading-tight text-slate-400 dark:text-[#8b97ad]/70">
                        {adapterLabels[agent.adapterType] ?? agent.adapterType}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

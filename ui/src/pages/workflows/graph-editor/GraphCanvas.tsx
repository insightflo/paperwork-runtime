// [파일 목적] 워크플로우 그래프 에디터의 캔버스(노드/엣지 SVG, 팬/줌/드래그/클릭/컨텍스트 메뉴)를
// 렌더링하는 프레젠테이션 컴포넌트. 모든 상태와 핸들러는 부모(WorkflowGraphEditor 코디네이터)가
// 소유하며 이 컴포넌트는 props로 전달받은 값/콜백만 사용한다.
// [주요 흐름] graph-workbench-main 래퍼 안에 (1) 편집 툴 독, (2) 컨텍스트 메뉴, (3) 컨테이너/그룹/엣지/노드
// SVG 레이어, (4) 보기 툴 독, (5) 상태 스트립을 그린다.
// [외부 연결] ../workflow-graph.js(모델/타입), ./graphStyles.js, ./graphUiUtils.js, ./GraphToolbar.js,
// ../workflow-page-styles.js, react.
// [수정시 주의] 캔버스 전용 상태(pan/scale/drag)는 절대 여기서 만들지 말고 코디네이터에서 props로 넘길 것.
// 루트 Workflows.tsx를 역참조(import)하지 말 것.
import * as React from "react";
import { type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import type { PendingWorkflowConnection } from "../workflow-control-nodes.js";
import {
  type WorkflowGraphContainerSummary,
  type WorkflowGraphEdge,
  type WorkflowGraphModel,
  type WorkflowGraphWorkbenchSummary,
} from "../workflow-graph.js";
import { graphPolicyBadgeStyle, statusBadgeStyle } from "../workflow-page-styles.js";
import {
  graphCanvasStyle,
  graphEdgeRemoveButtonStyle,
  graphNodeStyle,
  graphWorkbenchMainStyle,
} from "./graphStyles.js";
import {
  containerColor,
  graphEdgeDisplayLabel,
  type GraphContextMenuState,
  type GraphEdgeActionAnchor,
} from "./graphUiUtils.js";
import { GraphCanvasEditTools, GraphCanvasViewTools } from "./GraphCanvasControls.js";
import { GraphCanvasContextMenu } from "./GraphCanvasContextMenu.js";
import { resolveNodeLogicalClass } from "./node-logical-class.js";
import { GRAPH_CANVAS_CONNECTOR_STATES, GraphCanvasStatusStrip, type WorkflowLogicalClassCounts } from "./GraphCanvasStatusStrip.js";
import { GraphNodeHandles } from "./GraphNodeHandles.js";
import { GraphConnectionEffects } from "./GraphConnectionEffects.js";
import {
  CONNECTOR_STATE_STYLES,
  getConnectorVisualStyle,
  type ConnectorState,
} from "./connector-styles.js";

export interface GraphCanvasProps {
  graph: WorkflowGraphModel;
  canvasWidth: number;
  canvasHeight: number;
  canvasScale: number;
  canvasPanX: number;
  canvasPanY: number;
  isCanvasPanning: boolean;
  draggingStepId: string | null;
  pendingConnection: PendingWorkflowConnection | null;
  graphCanvasRef: React.RefObject<HTMLDivElement | null>;
  selectedStep: StepDraft | null;
  selectedEdgeId: string | null;
  selectedEdgeActionAnchor: GraphEdgeActionAnchor | null;
  graphContextMenu: GraphContextMenuState | null;
  selectedContainerSummary: WorkflowGraphContainerSummary | null;
  selectedPathNodeIds: Set<string>;
  matchingNodeIds: Set<string>;
  availableTools: { name: string }[];
  workbenchSummary: WorkflowGraphWorkbenchSummary;
  // handlers
  beginCanvasPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleCanvasPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  endCanvasPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleCanvasClick: () => void;
  handleCanvasContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  stopGraphControlEvent: (event: React.SyntheticEvent<HTMLElement>) => void;
  handleEdgeClick: (event: React.MouseEvent<Element>, edge: WorkflowGraphEdge) => void;
  handleEdgeDoubleClick: (event: React.MouseEvent<Element>, edge: WorkflowGraphEdge) => void;
  handleEdgeContextMenu: (event: React.MouseEvent<Element>, edge: WorkflowGraphEdge) => void;
  beginNodeDrag: (event: React.PointerEvent<HTMLButtonElement>, stepId: string, x: number, y: number) => void;
  handleNodePointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  endNodeDrag: (event: React.PointerEvent<HTMLButtonElement>) => void;
  handleNodeClick: (event: React.MouseEvent<HTMLButtonElement>, stepId: string) => void;
  handleNodeDoubleClick: (event: React.MouseEvent<HTMLButtonElement>, stepId: string) => void;
  handleNodeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, stepId: string) => void;
  handleNodeContextMenu: (event: React.MouseEvent<HTMLElement>, stepId: string) => void;
  beginEdgeConnection: (event: React.PointerEvent<HTMLElement>, connection: PendingWorkflowConnection) => void;
  completeEdgeConnection: (event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, targetId: string) => void;
  disconnect: (sourceId: string, targetId: string, when?: string) => void;
  setCanvasScaleFromPoint: (nextScale: number, clientX?: number, clientY?: number) => void;
  runWorkbenchAction: (actionId: string) => void;
  runNodeContextAction: (actionId: string, stepId: string) => void;
  runEdgeContextAction: (actionId: string, sourceId: string, targetId: string) => void;
  runCanvasContextAction: (actionId: string) => void;
  addAfter: (stepId: string | null) => void;
  handleDeleteGraphObjectPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

type GraphEdgeEmphasis = "highlighted" | "dimmed";
type GraphEdgeFocus = { type: "node" | "edge"; id: string } | null;

const markerEmphasisOptions = [
  ["base", {}],
  ["highlighted", { highlighted: true }],
  ["dimmed", { dimmed: true }],
] as const;

function connectorStateForEdge(edge: WorkflowGraphEdge): ConnectorState {
  if (edge.kind === "conditional") return edge.when === "condition_false" ? "condition_false" : "condition_true";
  return edge.kind === "failure" ? "blocked" : edge.kind === "early-stop" ? "rework" : "default";
}

function graphEdgeAccessibleDescription(edge: WorkflowGraphEdge, sourceLabel: string, targetLabel: string): string {
  const detail = graphEdgeDisplayLabel(edge);
  return `Workflow connector: ${sourceLabel} → ${targetLabel}${detail ? ` (${detail})` : ""}`;
}

function activateEdgeFromKeyboard(event: React.KeyboardEvent<SVGGElement>): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function graphEdgeEmphasis(edge: WorkflowGraphEdge, focus: GraphEdgeFocus): GraphEdgeEmphasis | null {
  if (!focus) return null;
  if (focus.type === "edge") return edge.id === focus.id ? "highlighted" : "dimmed";
  return edge.source === focus.id || edge.target === focus.id ? "highlighted" : "dimmed";
}

type GraphCanvasEdgesProps = Pick<GraphCanvasProps,
  "graph" | "selectedEdgeId" | "handleEdgeClick" | "handleEdgeDoubleClick" | "handleEdgeContextMenu"
> & {
  focus: GraphEdgeFocus;
  setHoveredEdgeId: (edgeId: string | null) => void;
};

function GraphCanvasEdges({
  graph,
  selectedEdgeId,
  handleEdgeClick,
  handleEdgeDoubleClick,
  handleEdgeContextMenu,
  focus,
  setHoveredEdgeId,
}: GraphCanvasEdgesProps) {
  const markerPrefix = React.useId();
  return (
    <svg role="group" aria-label="Workflow connectors" width="100%" height="100%"
      style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "auto" }}>
      <defs>
        {GRAPH_CANVAS_CONNECTOR_STATES.flatMap((state) => markerEmphasisOptions.map(([emphasis, options]) => {
          const visual = getConnectorVisualStyle(state, options);
          return (
            <marker key={`${state}-${emphasis}`} id={`${markerPrefix}-${state}-${emphasis}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L8,4 L0,8 Z" fill={visual.stroke} opacity={emphasis === "base" ? 1 : visual.opacity} />
            </marker>
          );
        }))}
      </defs>
      <g>
        {graph.edges.map((edge) => {
          const source = graph.nodes.find((node) => node.id === edge.source);
          const target = graph.nodes.find((node) => node.id === edge.target);
          if (!source || !target) return null;
          const startX = source.x + 172;
          const startY = source.y + (edge.when === "condition_true" ? 24 : edge.when === "condition_false" ? 54 : 38);
          const endX = target.x;
          const endY = target.y + 38;
          const midX = startX + Math.max(34, (endX - startX) / 2);
          const edgePath = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`;
          const selected = selectedEdgeId === edge.id;
          const emphasis = graphEdgeEmphasis(edge, focus);
          const connectorState = connectorStateForEdge(edge);
          const visual = getConnectorVisualStyle(connectorState, {
            highlighted: emphasis === "highlighted",
            dimmed: emphasis === "dimmed",
          });
          const color = visual.stroke;
          const accessibleDescription = graphEdgeAccessibleDescription(edge, source.label, target.label);
          const widthBoost = visual.strokeWidth - CONNECTOR_STATE_STYLES[connectorState].strokeWidth;
          const lineWidth = (selected ? 4 : 3) + widthBoost;
          const glowWidth = (selected ? 10 : 8) + widthBoost * 2;
          const lineOpacity = emphasis ? visual.opacity : undefined;
          const glowOpacity = emphasis
            ? Math.max(0.04, visual.opacity * (emphasis === "highlighted" ? 0.35 : 0.25))
            : 0.25;
          const emphasisKey = emphasis ?? "base";
          const transition = "opacity 150ms ease, stroke-width 150ms ease";
          return (
            <g key={edge.id} role="button" tabIndex={0} focusable="true" aria-label={accessibleDescription} data-graph-edge-accessible="true"
              onClick={(event) => handleEdgeClick(event, edge)} onDoubleClick={(event) => handleEdgeDoubleClick(event, edge)}
              onContextMenu={(event) => handleEdgeContextMenu(event, edge)} onKeyDown={activateEdgeFromKeyboard}
              onFocus={() => setHoveredEdgeId(edge.id)} onBlur={() => setHoveredEdgeId(null)}
              onPointerEnter={() => setHoveredEdgeId(edge.id)} onPointerLeave={() => setHoveredEdgeId(null)}
              onMouseEnter={() => setHoveredEdgeId(edge.id)} onMouseLeave={() => setHoveredEdgeId(null)}>
              <title>{accessibleDescription}</title>
              <path data-graph-edge="true" data-edge-id={edge.id} data-edge-emphasis={emphasis ?? undefined} d={edgePath} fill="none"
                stroke="transparent" strokeWidth="16" pointerEvents="stroke" style={{ cursor: "pointer" }} />
              <path data-graph-edge-glow="true" d={edgePath} fill="none" stroke={color} strokeWidth={glowWidth} strokeLinecap="round"
                opacity={glowOpacity} strokeDasharray={visual.strokeDasharray} pointerEvents="none" style={{ filter: "blur(3px)", transition }} />
              <path data-graph-edge-line="true" data-edge-state={connectorState} d={edgePath} fill="none" stroke={color} strokeWidth={lineWidth}
                strokeLinecap="round" opacity={lineOpacity} strokeDasharray={visual.strokeDasharray}
                markerEnd={`url(#${markerPrefix}-${connectorState}-${emphasisKey})`} pointerEvents="none" style={{ transition }} />
              {graphEdgeDisplayLabel(edge) ? (
                <text x={midX} y={(startY + endY) / 2 - 6} fill={color} fontSize="11" fontWeight="700"
                  opacity={emphasis ? visual.opacity : undefined} textAnchor="middle" pointerEvents="none"
                  style={{ transition: "opacity 150ms ease" }}>{graphEdgeDisplayLabel(edge)}</text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// [목적] 워크플로우 그래프 캔버스(노드/엣지/팬/줌/컨텍스트 메뉴) 렌더.
// [입력] GraphCanvasProps — 코디네이터가 소유한 상태/파생값/핸들러.
// [출력] JSX.Element (graph-workbench-main 래퍼).
// [연결] WorkflowGraphEditor 코디네이터가 렌더.
// [주의] 상태를 직접 생성하지 말 것. 동작 변경 없이 props 기반 렌더만 수행.
export function GraphCanvas({
  graph,
  canvasWidth,
  canvasHeight,
  canvasScale,
  canvasPanX,
  canvasPanY,
  isCanvasPanning,
  draggingStepId,
  pendingConnection,
  graphCanvasRef,
  selectedStep,
  selectedEdgeId,
  selectedEdgeActionAnchor,
  graphContextMenu,
  selectedContainerSummary,
  selectedPathNodeIds,
  matchingNodeIds,
  availableTools,
  workbenchSummary,
  beginCanvasPan,
  handleCanvasPointerMove,
  endCanvasPan,
  handleCanvasClick,
  handleCanvasContextMenu,
  stopGraphControlEvent,
  handleEdgeClick,
  handleEdgeDoubleClick,
  handleEdgeContextMenu,
  beginNodeDrag,
  handleNodePointerMove,
  endNodeDrag,
  handleNodeClick,
  handleNodeDoubleClick,
  handleNodeKeyDown,
  handleNodeContextMenu,
  beginEdgeConnection,
  completeEdgeConnection,
  disconnect,
  setCanvasScaleFromPoint,
  runWorkbenchAction,
  runNodeContextAction,
  runEdgeContextAction,
  runCanvasContextAction,
  addAfter,
  handleDeleteGraphObjectPointerDown,
}: GraphCanvasProps): JSX.Element {
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = React.useState<string | null>(null);
  const activeHoveredEdgeId = hoveredEdgeId && graph.edges.some((edge) => edge.id === hoveredEdgeId) ? hoveredEdgeId : null;
  const activeHoveredNodeId = hoveredNodeId && graph.nodes.some((node) => node.id === hoveredNodeId) ? hoveredNodeId : null;
  const selectedEdgeFocusId = selectedEdgeId && graph.edges.some((edge) => edge.id === selectedEdgeId) ? selectedEdgeId : null;
  const selectedNodeFocusId = graph.nodes.find((node) => node.step.id === selectedStep?.id)?.id ?? null;
  // [목적] 노드 스텝을 논리 클래스(함수/AI 에이전트/사람 대기)로 집계해 상태 스트립 범례에 전달한다.
  // [주의] 읽기 전용 파생값 — 저장된 스텝 형태는 바꾸지 않는다(graphApprovalRequired → human_wait 읽기 승격).
  const logicalClassCounts = React.useMemo<WorkflowLogicalClassCounts>(() => {
    const counts: WorkflowLogicalClassCounts = { function: 0, ai_agent: 0, human_wait: 0 };
    for (const node of graph.nodes) counts[resolveNodeLogicalClass(node.step)] += 1;
    return counts;
  }, [graph]);
  const edgeEmphasisFocus: GraphEdgeFocus = activeHoveredEdgeId
    ? { type: "edge", id: activeHoveredEdgeId }
    : activeHoveredNodeId
      ? { type: "node", id: activeHoveredNodeId }
      : selectedEdgeFocusId
        ? { type: "edge", id: selectedEdgeFocusId }
        : selectedNodeFocusId
          ? { type: "node", id: selectedNodeFocusId }
          : null;
  return (
    <div key="graph-workbench-main" style={graphWorkbenchMainStyle}>
      <div style={{ position: "relative", minHeight: 0 }}>
      <div key="graph-canvas" ref={graphCanvasRef}
        style={{ ...graphCanvasStyle, minHeight: 0, overflow: "auto", cursor: isCanvasPanning ? "grabbing" : "grab" }}
        onPointerDown={beginCanvasPan}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onPointerLeave={() => {
          setHoveredNodeId(null);
          setHoveredEdgeId(null);
        }}
        onContextMenu={handleCanvasContextMenu}
        onClick={handleCanvasClick}
      >
        <GraphCanvasContextMenu
          graphContextMenu={graphContextMenu}
          availableTools={availableTools}
          stopGraphControlEvent={stopGraphControlEvent}
          runNodeContextAction={runNodeContextAction}
          runEdgeContextAction={runEdgeContextAction}
          runCanvasContextAction={runCanvasContextAction}
        />
        <div
          key="graph-canvas-inner"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
        <div
          key="graph-canvas-content"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%", minWidth: `${canvasWidth}px`,
            height: "100%", minHeight: `${canvasHeight}px`,
            overflow: "visible",
            transform: `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`,
            transformOrigin: "0 0",
            transition: draggingStepId || isCanvasPanning ? "none" : "transform 140ms ease",
            pointerEvents: "none",
          }}
        >
          <div key="graph-containers" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.containers.map((container) => {
              const color = containerColor(container.type);
              const selected = selectedContainerSummary?.id === container.id;
              return (
                <button key={container.id} type="button" aria-label={`Select ${container.type} container ${container.title}`}
                  style={{
                    position: "absolute", left: container.x, top: container.y, width: container.width, height: container.height,
                    padding: 0, border: `${selected ? "2px solid" : "1px dashed"} ${color}`, borderRadius: "8px",
                    background: `color-mix(in srgb, ${color} 8%, transparent)`,
                    boxShadow: selected ? `0 0 0 2px color-mix(in srgb, ${color} 24%, transparent)` : "none",
                    cursor: "pointer", pointerEvents: "auto", textAlign: "left",
                  }}>
                  <div key="container-label"
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "calc(100% - 16px)", margin: "6px",
                      padding: "3px 7px", borderRadius: "6px", background: "var(--background, #020617)", color,
                      fontSize: "11px", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                    <span key="type" style={{ textTransform: "uppercase" }}>{container.type}</span>
                    <span key="title">{container.title}</span>
                  </div>
                  {container.description ? (
                    <div key="description"
                      style={{
                        margin: "0 8px", maxWidth: "calc(100% - 16px)", color: "var(--muted-foreground, #94a3b8)",
                        fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                      {container.description}
                    </div>
                  ) : null}
                  {container.badges.length > 0 ? (
                    <div key="badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "6px 8px 0" }}>
                      {container.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color }}>{badge}</span>
                      ))}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div key="graph-groups" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.groups.filter((group) => !group.collapsed).map((group) => (
              <div key={group.id}
                style={{
                  position: "absolute", left: group.x, top: group.y, width: group.width, height: group.height,
                  border: `1px solid ${group.color}`, borderRadius: "8px",
                  background: `color-mix(in srgb, ${group.color} 10%, transparent)`, pointerEvents: "none",
                }}>
                <div style={{
                  display: "inline-flex", maxWidth: "calc(100% - 16px)", margin: "6px", padding: "3px 7px", borderRadius: "6px",
                  background: "var(--background, #020617)", color: group.color, fontSize: "11px", fontWeight: 700,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {group.title}
                </div>
              </div>
            ))}
          </div>
          <GraphCanvasEdges graph={graph} selectedEdgeId={selectedEdgeId} handleEdgeClick={handleEdgeClick}
            handleEdgeDoubleClick={handleEdgeDoubleClick} handleEdgeContextMenu={handleEdgeContextMenu}
            focus={edgeEmphasisFocus} setHoveredEdgeId={setHoveredEdgeId} />
          <GraphConnectionEffects graph={graph} pendingConnection={pendingConnection}
            canvasScale={canvasScale} graphCanvasRef={graphCanvasRef} />
          {selectedEdgeActionAnchor ? (
            <button
              key="graph-edge-remove"
              type="button"
              data-graph-edge-remove="true"
              aria-label={`Remove relationship from ${selectedEdgeActionAnchor.edge.source} to ${selectedEdgeActionAnchor.edge.target}`}
              title="Remove relationship"
              style={{
                ...graphEdgeRemoveButtonStyle,
                left: selectedEdgeActionAnchor.x - 11,
                top: selectedEdgeActionAnchor.y - 11,
              }}
              onPointerDown={stopGraphControlEvent}
              onPointerUp={stopGraphControlEvent}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                disconnect(selectedEdgeActionAnchor.edge.source, selectedEdgeActionAnchor.edge.target, selectedEdgeActionAnchor.edge.when);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleEdgeContextMenu(event, selectedEdgeActionAnchor.edge);
              }}
            >
              -
            </button>
          ) : null}
          <div key="graph-nodes" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.nodes.map((node) => {
              const selected = selectedStep?.id === node.step.id;
              const matched = matchingNodeIds.has(node.id);
              const inSelection = !selected && selectedPathNodeIds.has(node.id);
              const showNodeMetadata = selected || matched || inSelection;
              const badgeSections = [
                ["badges", node.advanced.badges, undefined], ["testing-badges", node.testing.badges, "#fbbf24"],
                ["execution-badges", node.execution.badges, "#38bdf8"], ["data-flow-badges", node.dataFlow.badges, "#a78bfa"],
                ["resource-badges", node.resources.badges, "#34d399"], ["runtime-badges", node.runStatus.runtimeBadges, "#f97316"],
              ] as const;
              return (
                <button key={node.id || node.order} type="button" data-graph-node="true"
                  style={{
                    ...graphNodeStyle(selected, node.kind, matched, inSelection), left: node.x, top: node.y,
                    cursor: draggingStepId === node.step.id ? "grabbing" : "grab", touchAction: "none", pointerEvents: "auto",
                  }}
                  onPointerDown={(event) => beginNodeDrag(event, node.step.id, node.x, node.y)}
                  onPointerMove={handleNodePointerMove}
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId(null)}
                  onMouseEnter={() => setHoveredNodeId(node.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={endNodeDrag}
                  onContextMenu={(event) => handleNodeContextMenu(event, node.step.id)}
                  onClick={(event) => handleNodeClick(event, node.step.id)}
                  onDoubleClick={(event) => handleNodeDoubleClick(event, node.step.id)}
                  onKeyDown={(event) => handleNodeKeyDown(event, node.step.id)}
                >
                  <GraphNodeHandles step={node.step} pendingConnection={pendingConnection}
                    beginEdgeConnection={beginEdgeConnection} completeEdgeConnection={completeEdgeConnection} />
                  <span key="meta-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <span key="kind" style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", textTransform: "uppercase" }}>{node.kind}</span>
                    <span key="status" style={{ ...statusBadgeStyle(node.runStatus.status), fontSize: "10px" }}>{node.runStatus.status}</span>
                  </span>
                  <span key="label" style={{ display: "block", marginTop: "6px", fontSize: "13px", fontWeight: 700, overflowWrap: "anywhere" }}>{node.label}</span>
                  <span key="location" style={{ display: "block", marginTop: "4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>L{node.layer} · {node.id || "(no id)"}</span>
                  {node.kind === "if" && node.runStatus.controlOutcome ? (
                    <span key="if-outcome" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: node.runStatus.controlOutcome === "condition_true" ? "#22c55e" : "#fb923c", fontWeight: 800 }}>IF outcome: {node.runStatus.controlOutcome === "condition_true" ? "true" : "false"}</span>
                  ) : null}
                  {matched ? (
                    <span key="match" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#fbbf24", fontWeight: 700 }}>Search match</span>
                  ) : null}
                  {inSelection ? (
                    <span key="selection" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#22c55e", fontWeight: 700 }}>Selected path</span>
                  ) : null}
                  {showNodeMetadata ? badgeSections.map(([key, badges, color]) => badges.length > 0 ? (
                    <span key={key} style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, ...(color ? { color } : {}) }}>{badge}</span>
                      ))}
                    </span>
                  ) : null) : null}
                  {showNodeMetadata && node.runStatus.issueIdentifier ? (
                    <span key="issue" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>Issue: {node.runStatus.issueIdentifier}</span>
                  ) : null}
                  {showNodeMetadata && node.runStatus.summary ? (
                    <span key="summary" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>{node.runStatus.summary}</span>
                  ) : null}
                  {showNodeMetadata && typeof node.step.graphNote === "string" && node.step.graphNote.trim() ? (
                    <span key="note" style={{ display: "block", marginTop: "6px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>Note: {node.step.graphNote.trim()}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        </div>
      </div>
        <GraphCanvasEditTools selectedStep={selectedStep} selectedEdgeActionAnchor={selectedEdgeActionAnchor}
          addAfter={addAfter} handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
          stopGraphControlEvent={stopGraphControlEvent} />
        <GraphCanvasViewTools canvasScale={canvasScale} selectedStep={selectedStep}
          setCanvasScaleFromPoint={setCanvasScaleFromPoint} runWorkbenchAction={runWorkbenchAction} />
      </div>
      <GraphCanvasStatusStrip workbenchSummary={workbenchSummary} canvasScale={canvasScale} logicalClassCounts={logicalClassCounts} />
    </div>
  );
}

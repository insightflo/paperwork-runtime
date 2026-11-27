import { type CSSProperties, type JSX } from "react";
import type { WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { graphPolicyBadgeStyle } from "../workflow-page-styles.js";
import { CONNECTOR_STATE_STYLES, type ConnectorState } from "./connector-styles.js";
import { graphStatusStripStyle } from "./graphStyles.js";
import { nodeLogicalClassBadgeLabel, nodeLogicalClassBadgeStyle, workflowNodeLogicalClassOrder, type WorkflowNodeLogicalClass } from "./node-logical-class.js";

export type WorkflowLogicalClassCounts = Record<WorkflowNodeLogicalClass, number>;

export const GRAPH_CANVAS_CONNECTOR_STATES: readonly ConnectorState[] = [
  "default", "condition_true", "condition_false", "blocked", "rework",
];
const connectorLegendStyle: CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "4px 8px",
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const connectorLegendItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

function ConnectorStateLegend(): JSX.Element {
  return (
    <ul data-connector-state-legend="true" role="list" aria-label="Connector state legend" style={connectorLegendStyle}>
      {GRAPH_CANVAS_CONNECTOR_STATES.map((state) => {
        const style = CONNECTOR_STATE_STYLES[state];
        return (
          <li key={state} data-connector-state={state} style={connectorLegendItemStyle}>
            <svg aria-hidden="true" width="24" height="8" viewBox="0 0 24 8" style={{ display: "block", flex: "0 0 auto" }}>
              <line data-connector-state-swatch="true" x1="1" y1="4" x2="23" y2="4" stroke={style.stroke}
                strokeWidth={style.strokeWidth} strokeDasharray={style.strokeDasharray} opacity={style.opacity} strokeLinecap="round" />
            </svg>
            <span>{state.replaceAll("_", " ")}</span>
          </li>
        );
      })}
    </ul>
  );
}

// Logical class count legend: compact per-class pills using the shared
// node-logical-class token styles. human_wait > 0 is surfaced as a structural
// pause gate (data-pause-gate + aria-label) since it stops the run until a
// person acts. New styles use semantic tokens only — no raw hex literals.
const logicalClassLegendStyle: CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "4px 8px",
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const logicalClassLegendItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  color: "var(--muted-foreground)",
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const logicalClassGateTagStyle: CSSProperties = {
  color: "var(--pw-amber)",
  fontWeight: 800,
};

function LogicalClassCountLegend({ logicalClassCounts }: { logicalClassCounts: WorkflowLogicalClassCounts }): JSX.Element {
  return (
    <ul data-logical-class-legend="true" role="list" aria-label="Logical node class counts" style={logicalClassLegendStyle}>
      {workflowNodeLogicalClassOrder.map((logicalClass) => {
        const count = logicalClassCounts[logicalClass];
        const isPauseGate = logicalClass === "human_wait" && count > 0;
        const ariaLabel = isPauseGate
          ? `${count} ${nodeLogicalClassBadgeLabel(logicalClass)} — structural pause gate`
          : `${count} ${nodeLogicalClassBadgeLabel(logicalClass)}`;
        return (
          <li key={logicalClass} data-logical-class={logicalClass} data-pause-gate={isPauseGate ? "true" : undefined}
            aria-label={ariaLabel} style={logicalClassLegendItemStyle}>
            <span style={nodeLogicalClassBadgeStyle[logicalClass]}>{nodeLogicalClassBadgeLabel(logicalClass)}</span>
            <span aria-hidden="true">{count}</span>
            {isPauseGate ? <span aria-hidden="true" style={logicalClassGateTagStyle}>pause gate</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function GraphCanvasStatusStrip({
  workbenchSummary,
  canvasScale,
  logicalClassCounts,
}: {
  workbenchSummary: WorkflowGraphWorkbenchSummary;
  canvasScale: number;
  logicalClassCounts?: WorkflowLogicalClassCounts;
}): JSX.Element {
  const statusStripAccentColor = "#38bdf8";
  return (
    <div key="graph-status-strip" style={graphStatusStripStyle}>
      <div key="path-summary" style={{ minWidth: 0, display: "flex", alignItems: "center", gap: "7px", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflow: "hidden" }}>
        <strong style={{ color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>Selected path</strong>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workbenchSummary.pathSummary}</span>
      </div>
      <div key="status-badges" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "5px", flexWrap: "wrap" }}>
        {workbenchSummary.statusBadges.map((badge) => (
          <span key={badge} style={{ ...graphPolicyBadgeStyle, color: badge.includes("error") && !badge.startsWith("0 ") ? "var(--destructive, #ef4444)" : statusStripAccentColor }}>{badge}</span>
        ))}
        <span key="canvas-scale" style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{Math.round(canvasScale * 100)}%</span>
      </div>
      {logicalClassCounts ? <LogicalClassCountLegend logicalClassCounts={logicalClassCounts} /> : null}
      <ConnectorStateLegend />
    </div>
  );
}

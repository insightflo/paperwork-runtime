import { type CSSProperties, type JSX } from "react";
import type { WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { graphPolicyBadgeStyle } from "../workflow-page-styles.js";
import { CONNECTOR_STATE_STYLES, type ConnectorState } from "./connector-styles.js";
import { graphStatusStripStyle } from "./graphStyles.js";

const connectorStates = Object.keys(CONNECTOR_STATE_STYLES) as ConnectorState[];
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
      {connectorStates.map((state) => {
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

export function GraphCanvasStatusStrip({
  workbenchSummary,
  canvasScale,
}: {
  workbenchSummary: WorkflowGraphWorkbenchSummary;
  canvasScale: number;
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
      <ConnectorStateLegend />
    </div>
  );
}

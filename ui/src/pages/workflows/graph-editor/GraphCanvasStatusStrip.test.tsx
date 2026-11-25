// @vitest-environment jsdom
import { createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { jsonToSteps } from "../step-draft.js";
import { buildWorkflowGraphModel, buildWorkflowGraphWorkbenchSummary, type WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { CONNECTOR_STATE_STYLES, type ConnectorState } from "./connector-styles.js";
import { GraphCanvas, type GraphCanvasProps } from "./GraphCanvas.js";
import { GraphCanvasStatusStrip } from "./GraphCanvasStatusStrip.js";

const connectorStates = Object.keys(CONNECTOR_STATE_STYLES) as ConnectorState[];
const workbenchSummary: WorkflowGraphWorkbenchSummary = {
  selectedStepId: "alpha",
  commandGroups: [],
  statusBadges: ["0 errors", "2 nodes"],
  pathSummary: "alpha → beta",
  detailsHiddenByDefault: false,
};

function renderStatic(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe("GraphCanvasStatusStrip connector legend", () => {
  it("renders every state as a semantic list item with swatches derived from connector styles", () => {
    const container = renderStatic(<GraphCanvasStatusStrip workbenchSummary={workbenchSummary} canvasScale={1.25} />);
    const legend = container.querySelector('ul[data-connector-state-legend="true"]');
    expect(legend).not.toBeNull();
    expect(legend!.getAttribute("role")).toBe("list");
    expect(legend!.getAttribute("aria-label")).toBe("Connector state legend");

    const items = Array.from(legend!.querySelectorAll("li[data-connector-state]"));
    expect(items.map((item) => item.getAttribute("data-connector-state"))).toEqual(connectorStates);
    for (const state of connectorStates) {
      const style = CONNECTOR_STATE_STYLES[state];
      const item = items.find((candidate) => candidate.getAttribute("data-connector-state") === state)!;
      const swatch = item.querySelector("line[data-connector-state-swatch]");
      expect(item.textContent).toContain(state.replaceAll("_", " "));
      expect(swatch).not.toBeNull();
      expect(swatch!.getAttribute("stroke")).toBe(style.stroke);
      expect(swatch!.getAttribute("stroke-width")).toBe(String(style.strokeWidth));
      expect(swatch!.getAttribute("stroke-dasharray")).toBe(style.strokeDasharray);
      expect(swatch!.getAttribute("opacity")).toBe(String(style.opacity));
    }
  });

  it("keeps the existing path summary, status badges, and canvas scale", () => {
    const container = renderStatic(<GraphCanvasStatusStrip workbenchSummary={workbenchSummary} canvasScale={1.25} />);
    expect(container.textContent).toContain("Selected path");
    expect(container.textContent).toContain("alpha → beta");
    expect(container.textContent).toContain("0 errors");
    expect(container.textContent).toContain("2 nodes");
    expect(container.textContent).toContain("125%");
  });
});

describe("GraphCanvas rendered edge accessibility", () => {
  const steps = jsonToSteps([
    { id: "alpha", title: "Alpha", type: "agent" },
    { id: "beta", title: "Beta", type: "agent", dependsOn: ["alpha"] },
  ]);
  const graph = buildWorkflowGraphModel(steps);

  function canvasProps(): GraphCanvasProps {
    const noop = vi.fn();
    return {
      graph,
      canvasWidth: 1000,
      canvasHeight: 700,
      canvasScale: 1,
      canvasPanX: 0,
      canvasPanY: 0,
      isCanvasPanning: false,
      draggingStepId: null,
      pendingConnection: null,
      graphCanvasRef: createRef<HTMLDivElement>(),
      selectedStep: null,
      selectedEdgeId: null,
      selectedEdgeActionAnchor: null,
      graphContextMenu: null,
      selectedContainerSummary: null,
      selectedPathNodeIds: new Set(),
      matchingNodeIds: new Set(),
      availableTools: [],
      workbenchSummary: buildWorkflowGraphWorkbenchSummary(steps, ""),
      beginCanvasPan: noop,
      handleCanvasPointerMove: noop,
      endCanvasPan: noop,
      handleCanvasClick: noop,
      handleCanvasContextMenu: noop,
      stopGraphControlEvent: noop,
      handleEdgeClick: noop,
      handleEdgeDoubleClick: noop,
      handleEdgeContextMenu: noop,
      beginNodeDrag: noop,
      handleNodePointerMove: noop,
      endNodeDrag: noop,
      handleNodeClick: noop,
      handleNodeDoubleClick: noop,
      handleNodeKeyDown: noop,
      handleNodeContextMenu: noop,
      beginEdgeConnection: noop,
      completeEdgeConnection: noop,
      disconnect: noop,
      setCanvasScaleFromPoint: noop,
      runWorkbenchAction: noop,
      runNodeContextAction: noop,
      runEdgeContextAction: noop,
      runCanvasContextAction: noop,
      addAfter: noop,
      handleDeleteGraphObjectPointerDown: noop,
    };
  }

  it("exposes the source-to-target connection as an SVG title on the interactive edge path", () => {
    const container = renderStatic(<GraphCanvas {...canvasProps()} />);
    const edge = graph.edges.find((candidate) => candidate.source === "alpha" && candidate.target === "beta")!;
    const hit = container.querySelector(`[data-graph-edge="true"][data-edge-id="${edge.id}"]`);
    expect(hit).not.toBeNull();
    expect(hit!.querySelector("title")?.textContent).toBe("Workflow connector: Alpha → Beta");

    const svg = hit!.closest("svg");
    expect(svg!.getAttribute("aria-hidden")).toBeNull();
    expect(svg!.getAttribute("role")).toBe("group");
    expect(svg!.getAttribute("aria-label")).toBe("Workflow connectors");
  });
});

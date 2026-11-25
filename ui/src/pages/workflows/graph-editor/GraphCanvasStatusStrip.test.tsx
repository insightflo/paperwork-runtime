// @vitest-environment jsdom
import { act, createRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { jsonToSteps, type StepDraft } from "../step-draft.js";
import { buildWorkflowGraphModel, buildWorkflowGraphWorkbenchSummary, type WorkflowGraphModel, type WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { CONNECTOR_STATE_STYLES, type ConnectorState } from "./connector-styles.js";
import { GraphCanvas, type GraphCanvasProps } from "./GraphCanvas.js";
import { GraphCanvasStatusStrip } from "./GraphCanvasStatusStrip.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const legendStates: ConnectorState[] = ["default", "condition_true", "condition_false", "blocked", "rework"];
const workbenchSummary: WorkflowGraphWorkbenchSummary = {
  selectedStepId: "alpha",
  commandGroups: [],
  statusBadges: ["0 errors", "2 nodes"],
  pathSummary: "alpha → beta",
  detailsHiddenByDefault: false,
};
const steps = jsonToSteps([
  { id: "alpha", title: "Alpha", type: "agent" },
  { id: "beta", title: "Beta", type: "agent", dependsOn: ["alpha"] },
]);
const graph = buildWorkflowGraphModel(steps);
const stateSteps = jsonToSteps([
  { id: "start", title: "Start", type: "agent" },
  { id: "normal", title: "Normal", type: "agent", dependsOn: ["start"] },
  { id: "gate", title: "Gate", type: "if", dependsOn: ["normal"] },
  { id: "branch-path", title: "Branch Path", type: "agent", conditionalDependencies: [{ stepId: "gate", when: "condition_true" }, { stepId: "gate", when: "condition_false" }] },
  { id: "failure-path", title: "Failure Path", type: "agent", conditionalDependencies: [{ stepId: "gate", when: "failure" }] },
  { id: "rework-path", title: "Rework Path", type: "agent", dependsOn: ["start"], graphEdgeMetadata: { start: { kind: "early-stop", label: "rework" } } },
]);
const stateGraph = buildWorkflowGraphModel(stateSteps);

function renderStatic(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

function canvasProps(nextGraph: WorkflowGraphModel, nextSteps: StepDraft[], overrides: Partial<GraphCanvasProps> = {}): GraphCanvasProps {
  const noop = vi.fn();
  return {
    graph: nextGraph,
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
    workbenchSummary: buildWorkflowGraphWorkbenchSummary(nextSteps, ""),
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
    ...overrides,
  };
}

function hitPath(container: ParentNode, edgeId: string): Element {
  const hit = container.querySelector(`[data-graph-edge="true"][data-edge-id="${edgeId}"]`);
  expect(hit, `missing hit path for ${edgeId}`).not.toBeNull();
  return hit!;
}

describe("GraphCanvasStatusStrip connector legend", () => {
  it("renders only canvas-reachable states as semantic list items with swatches derived from connector styles", () => {
    const container = renderStatic(<GraphCanvasStatusStrip workbenchSummary={workbenchSummary} canvasScale={1.25} />);
    const legend = container.querySelector('ul[data-connector-state-legend="true"]');
    expect(legend).not.toBeNull();
    expect(legend!.getAttribute("role")).toBe("list");
    expect(legend!.getAttribute("aria-label")).toBe("Connector state legend");

    const items = Array.from(legend!.querySelectorAll("li[data-connector-state]"));
    expect(items.map((item) => item.getAttribute("data-connector-state"))).toEqual(legendStates);
    for (const state of legendStates) {
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

describe("GraphCanvas rendered connectors", () => {
  it("matches every legend swatch to the stroke and dash of the corresponding rendered edge", () => {
    const container = renderStatic(<GraphCanvas {...canvasProps(stateGraph, stateSteps)} />);
    const cases = [
      ["default", "start->normal"],
      ["condition_true", "gate->branch-path:condition_true"],
      ["condition_false", "gate->branch-path:condition_false"],
      ["blocked", "gate->failure-path:failure"],
      ["rework", "start->rework-path"],
    ] as const;

    for (const [state, edgeId] of cases) {
      const style = CONNECTOR_STATE_STYLES[state];
      const line = hitPath(container, edgeId).parentElement!.querySelector("[data-graph-edge-line]");
      const swatch = container.querySelector(`li[data-connector-state="${state}"] line[data-connector-state-swatch]`);
      expect(line, `missing rendered line for ${state}`).not.toBeNull();
      expect(swatch, `missing legend swatch for ${state}`).not.toBeNull();
      expect(line!.getAttribute("data-edge-state")).toBe(state);
      expect(line!.getAttribute("stroke")).toBe(style.stroke);
      expect(line!.getAttribute("stroke-dasharray")).toBe(style.strokeDasharray);
      expect(swatch!.getAttribute("stroke")).toBe(line!.getAttribute("stroke"));
      expect(swatch!.getAttribute("stroke-dasharray")).toBe(line!.getAttribute("stroke-dasharray"));
    }

    const trueLine = hitPath(container, "gate->branch-path:condition_true").parentElement!.querySelector("[data-graph-edge-line]")!;
    const falseLine = hitPath(container, "gate->branch-path:condition_false").parentElement!.querySelector("[data-graph-edge-line]")!;
    expect(trueLine.getAttribute("stroke")).not.toBe(falseLine.getAttribute("stroke"));
    expect(trueLine.getAttribute("stroke-dasharray")).not.toBe(falseLine.getAttribute("stroke-dasharray"));
  });

  it("matches arrow marker colors to the same connector state styles", () => {
    const container = renderStatic(<GraphCanvas {...canvasProps(stateGraph, stateSteps)} />);
    for (const state of legendStates) {
      const style = CONNECTOR_STATE_STYLES[state];
      const marker = Array.from(container.querySelectorAll("marker")).find((candidate) => candidate.id.endsWith(`-${state}-base`));
      expect(marker, `missing base marker for ${state}`).not.toBeNull();
      expect(marker!.querySelector("path")!.getAttribute("fill")).toBe(style.stroke);
    }
  });

  it("disambiguates true and false branch titles even when they share the same source and target", () => {
    const container = renderStatic(<GraphCanvas {...canvasProps(stateGraph, stateSteps)} />);
    const trueGroup = hitPath(container, "gate->branch-path:condition_true").parentElement!;
    const falseGroup = hitPath(container, "gate->branch-path:condition_false").parentElement!;
    expect(trueGroup.querySelector("title")?.textContent).toBe("Workflow connector: Gate → Branch Path (true)");
    expect(falseGroup.querySelector("title")?.textContent).toBe("Workflow connector: Gate → Branch Path (false)");
  });
});

describe("GraphCanvas rendered edge accessibility", () => {
  it("exposes the source-to-target connection on a focusable interactive edge group", () => {
    const container = renderStatic(<GraphCanvas {...canvasProps(graph, steps)} />);
    const edge = graph.edges.find((candidate) => candidate.source === "alpha" && candidate.target === "beta")!;
    const hit = hitPath(container, edge.id);
    const control = hit.closest('g[role="button"]');
    expect(control).not.toBeNull();
    expect(control!.getAttribute("tabindex")).toBe("0");
    expect(control!.getAttribute("aria-label")).toBe("Workflow connector: Alpha → Beta");
    expect(control!.querySelector("title")?.textContent).toBe("Workflow connector: Alpha → Beta");
    expect(hit.querySelector("title")).toBeNull();

    const svg = hit.closest("svg");
    expect(svg!.getAttribute("aria-hidden")).toBeNull();
    expect(svg!.getAttribute("role")).toBe("group");
    expect(svg!.getAttribute("aria-label")).toBe("Workflow connectors");
  });

  it("activates a focused edge with the keyboard", async () => {
    const handleEdgeClick = vi.fn();
    const edge = graph.edges.find((candidate) => candidate.source === "alpha" && candidate.target === "beta")!;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<GraphCanvas {...canvasProps(graph, steps, { handleEdgeClick })} />); });
      const control = hitPath(host, edge.id).closest('g[role="button"]');
      expect(control).not.toBeNull();
      await act(async () => {
        control!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(handleEdgeClick).toHaveBeenCalledTimes(1);
      expect(handleEdgeClick.mock.calls[0]?.[1]).toBe(edge);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

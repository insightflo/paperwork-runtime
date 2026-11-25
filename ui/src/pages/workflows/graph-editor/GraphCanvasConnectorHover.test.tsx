// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonToSteps } from "../step-draft.js";
import { buildWorkflowGraphModel, buildWorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { GraphCanvas, type GraphCanvasProps } from "./GraphCanvas.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const steps = jsonToSteps([
  { id: "alpha", title: "Alpha", type: "agent" },
  { id: "beta", title: "Beta", type: "agent", dependsOn: ["alpha"] },
  { id: "gamma", title: "Gamma", type: "agent" },
  { id: "delta", title: "Delta", type: "agent", dependsOn: ["gamma"] },
]);
const graph = buildWorkflowGraphModel(steps);
const edgeId = (source: string, target: string) => graph.edges.find(
  (edge) => edge.source === source && edge.target === target,
)!.id;
const alphaBetaEdgeId = edgeId("alpha", "beta");
const gammaDeltaEdgeId = edgeId("gamma", "delta");

let root: Root | undefined;
let container: HTMLDivElement;

function props(selectedStepId: string | null = null, selectedEdgeId: string | null = null): GraphCanvasProps {
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
    selectedStep: steps.find((step) => step.id === selectedStepId) ?? null,
    selectedEdgeId,
    selectedEdgeActionAnchor: null,
    graphContextMenu: null,
    selectedContainerSummary: null,
    selectedPathNodeIds: new Set(selectedStepId ? [selectedStepId] : []),
    matchingNodeIds: new Set(),
    availableTools: [],
    workbenchSummary: buildWorkflowGraphWorkbenchSummary(steps, selectedStepId ?? ""),
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

async function render(nextProps: GraphCanvasProps) {
  await act(async () => root!.render(<GraphCanvas {...nextProps} />));
}

async function mount(selectedStepId: string | null = null, selectedEdgeId: string | null = null) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(props(selectedStepId, selectedEdgeId));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

function edgeHit(id: string): Element {
  const hit = container.querySelector(`[data-graph-edge="true"][data-edge-id="${id}"]`);
  expect(hit, `missing hit path for ${id}`).not.toBeNull();
  return hit!;
}

function emphasis(id: string): string | null {
  return edgeHit(id).getAttribute("data-edge-emphasis");
}

function node(id: string): HTMLElement {
  const handle = container.querySelector<HTMLElement>(`[data-step-id="${id}"][data-graph-handle-kind]`);
  const button = handle?.closest("button[data-graph-node='true']");
  expect(button, `missing graph node ${id}`).not.toBeNull();
  return button as HTMLElement;
}

async function pointer(target: Element, type: "pointerover" | "pointerout" | "mouseover" | "mouseout") {
  await act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true })));
}

describe("GraphCanvas connector hover emphasis", () => {
  it("highlights edges connected to a hovered node, dims unrelated edges, and clears on pointer out", async () => {
    await mount();
    expect(emphasis(alphaBetaEdgeId)).toBeNull();
    expect(emphasis(gammaDeltaEdgeId)).toBeNull();

    await pointer(node("alpha"), "pointerover");
    expect(emphasis(alphaBetaEdgeId)).toBe("highlighted");
    expect(emphasis(gammaDeltaEdgeId)).toBe("dimmed");
    const highlightedLine = edgeHit(alphaBetaEdgeId).parentElement!.querySelector("[data-graph-edge-line]")!;
    const dimmedLine = edgeHit(gammaDeltaEdgeId).parentElement!.querySelector("[data-graph-edge-line]")!;
    expect(Number(highlightedLine.getAttribute("stroke-width"))).toBeGreaterThan(3);
    expect(Number(dimmedLine.getAttribute("opacity"))).toBeLessThan(0.5);

    await pointer(node("alpha"), "pointerout");
    expect(emphasis(alphaBetaEdgeId)).toBeNull();
    expect(emphasis(gammaDeltaEdgeId)).toBeNull();
  });

  it("highlights a hovered edge only, dims unrelated edges, and clears on mouse leave", async () => {
    await mount();
    await pointer(edgeHit(alphaBetaEdgeId), "mouseover");
    expect(emphasis(alphaBetaEdgeId)).toBe("highlighted");
    expect(emphasis(gammaDeltaEdgeId)).toBe("dimmed");

    await pointer(edgeHit(alphaBetaEdgeId), "mouseout");
    expect(emphasis(alphaBetaEdgeId)).toBeNull();
    expect(emphasis(gammaDeltaEdgeId)).toBeNull();
  });

  it("uses the selected node as the emphasis focus and resets when deselected", async () => {
    await mount("alpha");
    expect(emphasis(alphaBetaEdgeId)).toBe("highlighted");
    expect(emphasis(gammaDeltaEdgeId)).toBe("dimmed");

    await render(props());
    expect(emphasis(alphaBetaEdgeId)).toBeNull();
    expect(emphasis(gammaDeltaEdgeId)).toBeNull();
  });

  it("uses the selected edge as the emphasis focus and resets when deselected", async () => {
    await mount(null, alphaBetaEdgeId);
    expect(emphasis(alphaBetaEdgeId)).toBe("highlighted");
    expect(emphasis(gammaDeltaEdgeId)).toBe("dimmed");

    await render(props());
    expect(emphasis(alphaBetaEdgeId)).toBeNull();
    expect(emphasis(gammaDeltaEdgeId)).toBeNull();
  });
});

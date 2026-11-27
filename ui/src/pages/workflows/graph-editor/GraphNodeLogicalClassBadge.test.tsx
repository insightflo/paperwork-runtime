// @vitest-environment jsdom
// [파일 목적] 그래프 캔버스 노드 카드에 렌더되는 논리 클래스 배지(Function / AI Agent / Human Wait)의
// 초점 테스트. resolveNodeLogicalClass + nodeLogicalClassBadgeStyle 오버레이가 카드마다 정확히
// 하나씩, 토큰 전용 색으로 깔끔히 렌더되는지 확인한다.
// [주요 흐름] 정적 마크업 렌더 → data-node-logical-class 배지 조회 → 클래스별 라벨·일시정지 게이트·
// 토큰 색 단정.
// [외부 연결] ../step-draft.js, ../workflow-graph.js, ./GraphCanvas.js, ./node-logical-class.js.
// [수정시 주의] human_wait 노드는 현재 StepDraft 유니언에 type:"human_wait"이 없으므로
// graphApprovalRequired 읽기 승격으로 만든다(기존 wiring 테스트와 동일 관례).
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { jsonToSteps, type StepDraft } from "../step-draft.js";
import {
  buildWorkflowGraphModel,
  buildWorkflowGraphWorkbenchSummary,
  type WorkflowGraphModel,
} from "../workflow-graph.js";
import { GraphCanvas, type GraphCanvasProps } from "./GraphCanvas.js";

const steps = jsonToSteps([
  { id: "compute", title: "Compute", type: "tool" },
  { id: "draft", title: "Draft", type: "agent", dependsOn: ["compute"] },
  { id: "approve", title: "Approve", type: "agent", dependsOn: ["draft"], graphApprovalRequired: true },
]);
const graph = buildWorkflowGraphModel(steps);

function canvasProps(nextGraph: WorkflowGraphModel, nextSteps: StepDraft[]): GraphCanvasProps {
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
  };
}

function renderCanvas(): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<GraphCanvas {...canvasProps(graph, steps)} />);
  return container;
}

function nodeCardByTitle(container: ParentNode, title: string): HTMLElement {
  const card = Array.from(container.querySelectorAll('[data-graph-node="true"]')).find((node) =>
    node.textContent?.includes(title),
  );
  expect(card, `missing node card for ${title}`).not.toBeNull();
  return card as HTMLElement;
}

describe("GraphCanvas node card logical class badges", () => {
  it("renders exactly one compact logical class badge per node card with the class label", () => {
    const container = renderCanvas();
    const cards = container.querySelectorAll('[data-graph-node="true"]');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelectorAll("[data-node-logical-class]")).toHaveLength(1);
    }
    const badges = new Map(
      Array.from(container.querySelectorAll("[data-node-logical-class]")).map((badge) => [
        badge.getAttribute("data-node-logical-class"),
        badge,
      ]),
    );
    expect(badges.get("function")?.textContent).toBe("Function");
    expect(badges.get("ai_agent")?.textContent).toBe("AI Agent");
    expect(badges.get("human_wait")?.textContent).toBe("Human Wait");
    expect(nodeCardByTitle(container, "Compute").querySelector("[data-node-logical-class]")?.getAttribute("data-node-logical-class")).toBe("function");
    expect(nodeCardByTitle(container, "Draft").querySelector("[data-node-logical-class]")?.getAttribute("data-node-logical-class")).toBe("ai_agent");
    expect(nodeCardByTitle(container, "Approve").querySelector("[data-node-logical-class]")?.getAttribute("data-node-logical-class")).toBe("human_wait");
  });

  it("marks human_wait as the structural pause gate and leaves other classes ungated", () => {
    const container = renderCanvas();
    const gate = nodeCardByTitle(container, "Approve").querySelector("[data-node-logical-class]");
    expect(gate?.getAttribute("data-pause-gate")).toBe("true");
    expect(gate?.getAttribute("title")).toContain("pause gate");
    for (const title of ["Compute", "Draft"]) {
      const badge = nodeCardByTitle(container, title).querySelector("[data-node-logical-class]");
      expect(badge?.getAttribute("data-pause-gate")).toBeNull();
      expect(badge?.getAttribute("title")).toBeNull();
    }
  });

  it("colors badges with semantic pw tokens only (no raw hex)", () => {
    const container = renderCanvas();
    for (const badge of container.querySelectorAll("[data-node-logical-class]")) {
      const style = badge.getAttribute("style") ?? "";
      expect(style).toContain("var(--pw-");
      expect(style).not.toContain("#");
    }
  });
});

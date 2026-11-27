// @vitest-environment jsdom
// [파일 목적] 문제-우선 라우팅 가드의 4가지 모드 판정·규칙 우선순위(순수 평가기)와 안내 카드 렌더링
//   (모드 배지, Q1/Q2 필, 비차단 권고 태그, 숨기기 버튼 상호작용)를 검증한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { evaluateWorkflowRoutingGuard, ProblemFirstRoutingBanner } from "./ProblemFirstRoutingBanner.js";
import type { WorkflowRoutingGuardInput } from "./ProblemFirstRoutingBanner.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.restoreAllMocks();
});

async function mountBanner(props: WorkflowRoutingGuardInput & { onDismiss?: () => void }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ProblemFirstRoutingBanner {...props} />);
  });
  unmounts.push(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

const text = (container: HTMLElement) => container.textContent ?? "";

const NO_FLAGS: WorkflowRoutingGuardInput = {
  stepCount: 1,
  hasHumanWaitOrApproval: false,
  hasBranchingOrParallel: false,
  needsMultiHopDataContext: false,
};

describe("evaluateWorkflowRoutingGuard", () => {
  it("recommends a single agent for one step with no structural control and no multi-hop need", () => {
    const result = evaluateWorkflowRoutingGuard(NO_FLAGS);
    expect(result.mode).toBe("single_agent");
    expect(result.advisoryLevel).toBe("hint");
    expect(result.q1StructuralControl).toBe(false);
    expect(result.q2MultiHopContext).toBe(false);
    expect(result.headlineKo).toBe("단일 에이전트 실행을 권장합니다");
    expect(result.detailKo).toBe("구조적 멈춤·분기·다중 홉 관계가 없으면 그래프를 만들지 않는 편이 단순합니다.");
  });

  it("treats an empty draft (stepCount 0) like a single step", () => {
    const result = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, stepCount: 0 });
    expect(result.mode).toBe("single_agent");
    expect(result.advisoryLevel).toBe("hint");
  });

  it("cautions a multi-step graph without Q1 even when Q2 is set (rule 2 precedes rule 5)", () => {
    const multiStep = { ...NO_FLAGS, stepCount: 3 };
    expect(evaluateWorkflowRoutingGuard(multiStep)).toMatchObject({
      mode: "workflow_graph",
      advisoryLevel: "caution",
      q1StructuralControl: false,
      q2MultiHopContext: false,
    });
    const multiStepWithQ2 = { ...multiStep, needsMultiHopDataContext: true };
    expect(evaluateWorkflowRoutingGuard(multiStepWithQ2)).toMatchObject({
      mode: "workflow_graph",
      advisoryLevel: "caution",
      headlineKo: "구조적 승인(human_wait)이나 분기 없이 다단계 그래프가 구성되었습니다",
      detailKo: "단순 순차 작업이라면 단일 에이전트로 충분할 수 있습니다.",
    });
  });

  it("routes approval-only Q1 to workflow_graph regardless of step count", () => {
    const multiStep = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, stepCount: 3, hasHumanWaitOrApproval: true });
    expect(multiStep.mode).toBe("workflow_graph");
    expect(multiStep.advisoryLevel).toBe("none");
    expect(multiStep.q1StructuralControl).toBe(true);
    expect(multiStep.q2MultiHopContext).toBe(false);
    const singleStep = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, hasHumanWaitOrApproval: true });
    expect(singleStep.mode).toBe("workflow_graph");
    expect(singleStep.advisoryLevel).toBe("none");
  });

  it("counts branching/parallel edges alone as Q1 structural control", () => {
    const result = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, stepCount: 4, hasBranchingOrParallel: true });
    expect(result.mode).toBe("workflow_graph");
    expect(result.advisoryLevel).toBe("none");
    expect(result.q1StructuralControl).toBe(true);
  });

  it("combines workflow graph and data graph when both Q1 and Q2 hold", () => {
    const result = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, stepCount: 5, hasHumanWaitOrApproval: true, needsMultiHopDataContext: true });
    expect(result.mode).toBe("two_graph");
    expect(result.advisoryLevel).toBe("none");
    expect(result.q1StructuralControl).toBe(true);
    expect(result.q2MultiHopContext).toBe(true);
  });

  it("suggests a data graph query for a single step that only needs multi-hop context", () => {
    const result = evaluateWorkflowRoutingGuard({ ...NO_FLAGS, needsMultiHopDataContext: true });
    expect(result.mode).toBe("data_graph_rag");
    expect(result.advisoryLevel).toBe("hint");
    expect(result.q1StructuralControl).toBe(false);
    expect(result.q2MultiHopContext).toBe(true);
    expect(result.headlineKo).toBe("관계 탐색(2-hop Data Graph)이 핵심이라면");
    expect(result.detailKo).toBe("워크플로 대신 Data Graph 질의를 권장합니다.");
  });
});

describe("ProblemFirstRoutingBanner", () => {
  it("renders the single-agent hint card with the advisory tag and negative Q pills", async () => {
    const container = await mountBanner(NO_FLAGS);
    const banner = container.querySelector('[data-testid="problem-first-routing-banner"]');
    expect(banner?.getAttribute("data-mode")).toBe("single_agent");
    expect(banner?.getAttribute("data-advisory-level")).toBe("hint");
    expect(text(container)).toContain("단일 에이전트");
    expect(text(container)).toContain("단일 에이전트 실행을 권장합니다");
    expect(text(container)).toContain("비차단 권고");
    expect(text(container)).toContain("Q1 · 구조적 제어: 아니오");
    expect(text(container)).toContain("Q2 · 다중 홉 맥락: 아니오");
  });

  it("renders the caution copy for a multi-step graph built without Q1", async () => {
    const container = await mountBanner({ ...NO_FLAGS, stepCount: 3 });
    expect(container.querySelector('[data-advisory-level="caution"]')).not.toBeNull();
    expect(text(container)).toContain("구조적 승인(human_wait)이나 분기 없이 다단계 그래프가 구성되었습니다");
    expect(text(container)).toContain("단순 순차 작업이라면 단일 에이전트로 충분할 수 있습니다.");
    expect(text(container)).toContain("비차단 권고");
  });

  it("renders the data-graph hint for a single step that needs multi-hop context", async () => {
    const container = await mountBanner({ ...NO_FLAGS, needsMultiHopDataContext: true });
    expect(container.querySelector('[data-mode="data_graph_rag"]')).not.toBeNull();
    expect(text(container)).toContain("관계 탐색(2-hop Data Graph)이 핵심이라면");
    expect(text(container)).toContain("워크플로 대신 Data Graph 질의를 권장합니다.");
    expect(text(container)).toContain("Q2 · 다중 홉 맥락: 예");
  });

  it("renders a neutral two-graph card without the advisory tag", async () => {
    const container = await mountBanner({ ...NO_FLAGS, stepCount: 5, hasHumanWaitOrApproval: true, needsMultiHopDataContext: true });
    const banner = container.querySelector('[data-testid="problem-first-routing-banner"]');
    expect(banner?.getAttribute("data-mode")).toBe("two_graph");
    expect(banner?.getAttribute("data-advisory-level")).toBe("none");
    expect(text(container)).toContain("두 그래프 조합");
    expect(text(container)).not.toContain("비차단 권고");
    expect(text(container)).toContain("Q1 · 구조적 제어: 예");
    expect(text(container)).toContain("Q2 · 다중 홉 맥락: 예");
  });

  it("renders a neutral workflow-graph card when only Q1 holds", async () => {
    const container = await mountBanner({ ...NO_FLAGS, stepCount: 3, hasBranchingOrParallel: true });
    const banner = container.querySelector('[data-testid="problem-first-routing-banner"]');
    expect(banner?.getAttribute("data-mode")).toBe("workflow_graph");
    expect(banner?.getAttribute("data-advisory-level")).toBe("none");
    expect(text(container)).not.toContain("비차단 권고");
    expect(text(container)).toContain("Q1 · 구조적 제어: 예");
    expect(text(container)).toContain("Q2 · 다중 홉 맥락: 아니오");
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    const container = await mountBanner({ ...NO_FLAGS, onDismiss });
    const button = container.querySelector('button[aria-label="라우팅 가드 안내 숨기기"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("omits the dismiss button when onDismiss is not provided", async () => {
    const container = await mountBanner(NO_FLAGS);
    expect(container.querySelector("button")).toBeNull();
  });
});

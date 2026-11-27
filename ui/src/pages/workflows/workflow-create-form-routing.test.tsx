// @vitest-environment jsdom
// [파일 목적] WorkflowCreateForm에 마운트된 문제-우선 라우팅 배너(s26-two-graph-architecture §3)를 검증한다:
//   스텝 초안→가드 입력 유도, 단일·다단계(무Q1)·승인 게이트 스텝에서의 배너 렌더, 숨기기→스텝 수 변경 시
//   재등장, 그리고 배너가 워크플로 생성(저장)을 차단하지 않음을 확인한다. 배너는 표시 전용이다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StepWorkspaceGraphEditorProps } from "./step-workspace-editor.js";
import { emptyStep, type StepDraft } from "./step-draft.js";
import { deriveRoutingGuardInput, WorkflowCreateForm } from "./workflow-create-form.js";

const { coreApiJsonMock } = vi.hoisted(() => ({ coreApiJsonMock: vi.fn() }));
vi.mock("./workflow-core-api.js", () => ({
  apiBaseUrl: () => "http://localhost:3100",
  coreApiJson: coreApiJsonMock,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let stubAppliedSteps: StepDraft[] = [];

// 그래프 캔버스 대신 스텝 초안을 주입하는 스텁 — onChange이 곧 폼의 newWorkflowSteps 갱신 경로다.
function StubGraphEditor(props: StepWorkspaceGraphEditorProps) {
  return (
    <button type="button" data-testid="stub-graph-apply-steps" onClick={() => props.onChange(stubAppliedSteps)}>
      apply-steps
    </button>
  );
}

function draftStep(id: string, overrides: Partial<StepDraft> = {}): StepDraft {
  return { ...emptyStep(), id, title: id, ...overrides };
}

function chainedSteps(count: number, overrides: Partial<StepDraft>[] = []): StepDraft[] {
  return Array.from({ length: count }, (_, index) =>
    draftStep(`s${index + 1}`, { ...(index === 0 ? {} : { dependsOn: `s${index}` }), ...overrides[index] }),
  );
}

async function mountForm(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkflowCreateForm
        companyId="co-1"
        projects={[]}
        toolSystem={{ available: true }}
        availableTools={[]}
        availableToolGrants={[]}
        renderGraphEditor={StubGraphEditor}
        onCreated={() => {}}
        onCancel={() => {}}
        onLabelsRefresh={async () => []}
      />,
    );
  });
  return container;
}

async function clickApplySteps(container: HTMLElement): Promise<void> {
  const button = container.querySelector('[data-testid="stub-graph-apply-steps"]');
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const banner = (container: HTMLElement) => container.querySelector('[data-testid="problem-first-routing-banner"]');
const text = (container: HTMLElement) => container.textContent ?? "";

describe("deriveRoutingGuardInput", () => {
  it("yields an all-false guard for an empty draft or a single plain step", () => {
    expect(deriveRoutingGuardInput([], false)).toEqual({ stepCount: 0, hasHumanWaitOrApproval: false, hasBranchingOrParallel: false, needsMultiHopDataContext: false });
    expect(deriveRoutingGuardInput(chainedSteps(1), false)).toEqual({ stepCount: 1, hasHumanWaitOrApproval: false, hasBranchingOrParallel: false, needsMultiHopDataContext: false });
  });

  it("flags human wait via approval flag, human_wait type, or decision template", () => {
    expect(deriveRoutingGuardInput(chainedSteps(1, [{ graphApprovalRequired: true }]), false).hasHumanWaitOrApproval).toBe(true);
    expect(deriveRoutingGuardInput([draftStep("s1", { type: "human_wait" as StepDraft["type"] })], false).hasHumanWaitOrApproval).toBe(true);
    expect(deriveRoutingGuardInput(chainedSteps(1, [{ decisionTemplatePrompt: "승인 사유를 남겨라" }]), false).hasHumanWaitOrApproval).toBe(true);
  });

  it("flags branching via if type, parallel container, join fan-in, or multiple roots", () => {
    expect(deriveRoutingGuardInput(chainedSteps(1, [{ type: "if" }]), false).hasBranchingOrParallel).toBe(true);
    expect(deriveRoutingGuardInput(chainedSteps(1, [{ graphContainerRunInParallel: true }]), false).hasBranchingOrParallel).toBe(true);
    expect(deriveRoutingGuardInput([draftStep("a"), draftStep("b"), draftStep("join", { dependsOn: "a, b" })], false).hasBranchingOrParallel).toBe(true);
    expect(deriveRoutingGuardInput([draftStep("root1"), draftStep("root2")], false).hasBranchingOrParallel).toBe(true);
  });

  it("keeps a chained multi-step draft free of Q1 and passes the multi-hop flag through", () => {
    const chained = deriveRoutingGuardInput(chainedSteps(3), true);
    expect(chained).toEqual({ stepCount: 3, hasHumanWaitOrApproval: false, hasBranchingOrParallel: false, needsMultiHopDataContext: true });
  });
});

describe("WorkflowCreateForm routing banner", () => {
  beforeEach(() => {
    stubAppliedSteps = [];
    coreApiJsonMock.mockReset();
    coreApiJsonMock.mockResolvedValue({ id: "wf-1" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("shows the single-agent hint for an empty draft", async () => {
    const container = await mountForm();
    expect(banner(container)?.getAttribute("data-mode")).toBe("single_agent");
    expect(banner(container)?.getAttribute("data-advisory-level")).toBe("hint");
    expect(text(container)).toContain("단일 에이전트 실행을 권장합니다");
    expect(container.querySelector('button[aria-label="라우팅 가드 안내 숨기기"]')).not.toBeNull();
  });

  it("shows the no-Q1 caution once a chained multi-step draft exists", async () => {
    stubAppliedSteps = chainedSteps(3);
    const container = await mountForm();
    await clickApplySteps(container);
    expect(banner(container)?.getAttribute("data-mode")).toBe("workflow_graph");
    expect(banner(container)?.getAttribute("data-advisory-level")).toBe("caution");
    expect(text(container)).toContain("구조적 승인(human_wait)이나 분기 없이 다단계 그래프가 구성되었습니다");
  });

  it("shows the neutral workflow-graph mode for approval-gated steps", async () => {
    stubAppliedSteps = chainedSteps(3, [{ graphApprovalRequired: true }]);
    const container = await mountForm();
    await clickApplySteps(container);
    expect(banner(container)?.getAttribute("data-mode")).toBe("workflow_graph");
    expect(banner(container)?.getAttribute("data-advisory-level")).toBe("none");
    expect(text(container)).not.toContain("비차단 권고");
    expect(text(container)).toContain("Q1 · 구조적 제어: 예");
  });

  it("hides on dismiss and reappears when the step count changes", async () => {
    const container = await mountForm();
    await act(async () => {
      container.querySelector('button[aria-label="라우팅 가드 안내 숨기기"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(banner(container)).toBeNull();
    stubAppliedSteps = chainedSteps(1);
    await clickApplySteps(container);
    expect(banner(container)?.getAttribute("data-mode")).toBe("single_agent");
  });

  it("never blocks submission while the banner is visible", async () => {
    stubAppliedSteps = chainedSteps(3);
    const container = await mountForm();
    await clickApplySteps(container);
    expect(banner(container)).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const nameInput = container.querySelector('input[placeholder="Daily market signal digest"]')!;
    await act(async () => {
      setter.call(nameInput, "routing-banner-wf");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(coreApiJsonMock).toHaveBeenCalledTimes(1);
    const [path, init] = coreApiJsonMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/companies/co-1/workflows");
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "routing-banner-wf" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

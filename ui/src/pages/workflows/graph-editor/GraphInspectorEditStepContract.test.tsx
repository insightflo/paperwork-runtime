// @vitest-environment jsdom
// [B안 스텝 계약] 그래프 인스펙터 EDIT 블록의 Step contract 섹션 렌더 검증.
// agent 스텝에만 3개 계약 입력(사전/사후/미정의)이 노출되고, if 제어노드에는 노출되지 않는다.
// [stage26 human_wait] 승인(human_wait) 스텝의 decisionTemplate 승인 카드 섹션 표시/수정 검증도 함께.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GraphInspectorEditStep } from "./GraphInspectorEditStep.js";
import { jsonToSteps, type StepDraft } from "../step-draft.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const pointerNoop = (_event: unknown) => {};

function renderSteps(drafts: StepDraft[], updateSelected: (patch: Partial<StepDraft>) => void = noop): string {
  return renderToStaticMarkup(
    <GraphInspectorEditStep
      showEditInspector={true}
      steps={drafts}
      selectedStep={drafts[0]!}
      availableTools={[]}
      availableToolGrants={[]}
      graphAgents={[]}
      renameSelectedStep={noop}
      updateSelected={updateSelected}
      updateSelectedDataFlow={noop}
      updateSelectedResources={noop}
      addAfter={noop}
      duplicateSelectedStep={noop}
      handleDeleteGraphObjectPointerDown={pointerNoop}
    />,
  );
}

function renderInspector(stepOverrides: Record<string, unknown>): string {
  return renderSteps(jsonToSteps([{ id: "s1", title: "Step 1", type: "agent", ...stepOverrides } as never]));
}

describe("GraphInspectorEditStep step contract section", () => {
  it("shows the three contract inputs for agent steps with hydrated values", () => {
    const html = renderInspector({
      contract: {
        preconditions: ["Data source brief is registered"],
        postconditions: ["Report registers a workProduct"],
        undefinedBehaviors: ["If the source is unreachable the content is undefined"],
      },
    });
    expect(html).toContain("Step contract");
    expect(html).toContain("Preconditions");
    expect(html).toContain("Postconditions");
    expect(html).toContain("Undefined behaviors");
    expect(html).toContain("Data source brief is registered");
    expect(html).toContain("Report registers a workProduct");
    expect(html).toContain("If the source is unreachable the content is undefined");
  });

  it("does not show the contract section for if control-node steps", () => {
    const html = renderInspector({
      type: "if",
      conditionGroup: {
        combinator: "all",
        conditions: [
          {
            source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          },
        ],
      },
    });
    expect(html).not.toContain("Step contract");
  });
});

describe("GraphInspectorEditStep decision template card", () => {
  it("shows the decisionTemplate card fields for approval (human_wait) steps", () => {
    const html = renderInspector({ graphApprovalRequired: true });
    expect(html).toContain("Human Wait · 승인 카드 설정 (decisionTemplate)");
    expect(html).toContain("Card title");
    expect(html).toContain("Card prompt");
    expect(html).toContain("Required role");
    expect(html).toContain("Timeout minutes");
    expect(html).toContain("Allow reject");
  });

  it("renders hydrated decisionTemplate draft values on the card", () => {
    const drafts = jsonToSteps([{ id: "s1", title: "Step 1", type: "agent", graphApprovalRequired: true } as never]);
    drafts[0]!.decisionTemplateTitle = "Deploy approval";
    drafts[0]!.decisionTemplatePrompt = "Deploy to production?";
    drafts[0]!.decisionTemplateRequiredRole = "release-manager";
    drafts[0]!.decisionTemplateTimeoutMinutes = 30;
    const html = renderSteps(drafts);
    expect(html).toContain('value="Deploy approval"');
    expect(html).toContain("Deploy to production?");
    expect(html).toContain('value="release-manager"');
    expect(html).toContain('value="30"');
  });

  it("does not show the decisionTemplate card for plain agent steps", () => {
    const html = renderInspector({});
    expect(html).not.toContain("승인 카드 설정");
    expect(html).not.toContain("Allow reject");
  });

  it("updates the decisionTemplate draft fields through the inspector controls", async () => {
    const updateSelected = vi.fn();
    const drafts = jsonToSteps([{ id: "s1", title: "Step 1", type: "agent", graphApprovalRequired: true } as never]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <GraphInspectorEditStep
            showEditInspector={true}
            steps={drafts}
            selectedStep={drafts[0]!}
            availableTools={[]}
            availableToolGrants={[]}
            graphAgents={[]}
            renameSelectedStep={noop}
            updateSelected={updateSelected}
            updateSelectedDataFlow={noop}
            updateSelectedResources={noop}
            addAfter={noop}
            duplicateSelectedStep={noop}
            handleDeleteGraphObjectPointerDown={pointerNoop}
          />,
        );
      });
      // [주의] value 직접 할당은 React 값 추적기가 변경으로 보지 않아 onChange가 무시된다 —
      // 저장소 관례대로 네이티브 prototype setter로 값을 넣고 input 이벤트를 발생시킨다.
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const typeInto = (label: string, value: string) => {
        const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
        expect(input, label).toBeTruthy();
        inputSetter.call(input!, value);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => typeInto("Card title", "Deploy approval"));
      await act(async () => typeInto("Timeout minutes", "90"));
      expect(updateSelected).toHaveBeenNthCalledWith(1, { decisionTemplateTitle: "Deploy approval" });
      expect(updateSelected).toHaveBeenNthCalledWith(2, { decisionTemplateTimeoutMinutes: "90" });
      const reject = host.querySelector<HTMLInputElement>('input[aria-label="Allow reject"]');
      expect(reject, "Allow reject").toBeTruthy();
      await act(async () => reject!.click());
      expect(updateSelected).toHaveBeenNthCalledWith(3, { decisionTemplateAllowReject: true });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

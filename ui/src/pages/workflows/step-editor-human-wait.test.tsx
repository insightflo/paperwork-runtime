// @vitest-environment jsdom
// [stage26 human_wait Wave 2] 스텝 편집기의 human_wait 타입 옵션과 초안 타당성을 검증한다.
// 1) StepEditor Type select 에 human_wait 옵션이 노출된다.
// 2) human_wait 선택 시 resolveNodeLogicalClass === "human_wait" 인 유효한 초안이 만들어진다.
// 3) jsonToSteps 임포트가 human_wait 타입을 agent 로 침묵 강등하지 않는다(왕복 보존).
// 4) human_wait 초안은 STEP_TYPE_META 배지(Human Wait)로 렌더된다.
// [주의] 타입 select 은 펼친 카드 본문에만 있다(기본 접힘). jsdom 에서 React 값 반영을 위해
// HTMLSelectElement.prototype 네이티브 value 세터를 사용한다(직접 .value= 대입은 무시됨).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepEditor } from "./step-editor.js";
import { emptyStep, jsonToSteps, stepsToJson, type StepDraft } from "./step-draft.js";
import { resolveNodeLogicalClass } from "./graph-editor/node-logical-class.js";

const { useCompanyMock } = vi.hoisted(() => ({
  useCompanyMock: vi.fn(() => ({ selectedCompanyId: "co-1" })),
}));

vi.mock("../../context/CompanyContext.js", () => ({
  useCompany: useCompanyMock,
}));

const { apiBaseUrlMock, useWorkflowOverviewMock } = vi.hoisted(() => ({
  apiBaseUrlMock: vi.fn(() => "http://localhost:3100"),
  useWorkflowOverviewMock: vi.fn(() => ({ data: undefined, loading: false, error: null })),
}));

vi.mock("./workflow-page-api.js", () => ({
  apiBaseUrl: apiBaseUrlMock,
  useWorkflowOverview: useWorkflowOverviewMock,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;

beforeEach(() => {
  // StepEditor 마운트 시 에이전트 목록 fetch — 실패해도 컴포넌트는 catch 로 무시한다.
  globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => [] }) as unknown as Response);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

function agentDraft(): StepDraft {
  return { ...emptyStep(), id: "hw-1", title: "사람 승인 대기" };
}

function renderStatic(initial: StepDraft[]): string {
  return renderToStaticMarkup(
    <StepEditor steps={initial} onChange={() => {}} availableTools={[]} availableToolGrants={[]} />,
  );
}

async function mountEditor(initial: StepDraft[], onChange: (steps: StepDraft[]) => void): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StepEditor steps={initial} onChange={onChange} availableTools={[]} availableToolGrants={[]} />);
  });
  return container;
}

/** 펼친 카드 본문의 Type select — option[value="complete"] 는 Type select 에만 존재한다. */
function findTypeSelect(container: HTMLElement): HTMLSelectElement {
  const selects = Array.from(container.querySelectorAll("select"));
  const typeSelect = selects.find((select) => select.querySelector('option[value="complete"]'));
  if (!typeSelect) throw new Error("Type select not found");
  return typeSelect;
}

async function expandFirstStep(container: HTMLElement): Promise<void> {
  const expandButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Expand",
  );
  if (!expandButton) throw new Error("Expand button not found");
  await act(async () => {
    expandButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function selectType(container: HTMLElement, value: string): Promise<void> {
  const typeSelect = findTypeSelect(container);
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(typeSelect, value);
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("step editor human_wait type option", () => {
  it("exposes the human_wait option in the step editor Type select", async () => {
    // 스텝 카드는 기본 접힘이라 Type select 은 펼친 뒤 DOM 에서 확인한다.
    const container = await mountEditor([agentDraft()], vi.fn());
    await expandFirstStep(container);
    const option = findTypeSelect(container).querySelector('option[value="human_wait"]');
    expect(option?.textContent ?? "").toContain("Human Wait");
  });

  it("creates a valid human_wait draft whose logical class resolves to human_wait", async () => {
    const onChange = vi.fn();
    const container = await mountEditor([agentDraft()], onChange);
    await expandFirstStep(container);
    await selectType(container, "human_wait");

    expect(onChange).toHaveBeenCalled();
    const updatedSteps = onChange.mock.calls.at(-1)?.[0] as StepDraft[];
    expect(updatedSteps[0]?.type).toBe("human_wait");
    expect(resolveNodeLogicalClass(updatedSteps[0])).toBe("human_wait");
  });

  it("preserves the human_wait type through import and save roundtrip without silent agent demotion", () => {
    const drafts = jsonToSteps([{ id: "hw-1", title: "사람 승인 대기", type: "human_wait" }]);
    expect(drafts[0]?.type).toBe("human_wait");
    expect(resolveNodeLogicalClass(drafts[0])).toBe("human_wait");

    const saved = stepsToJson(drafts) as Array<Record<string, unknown>>;
    expect(saved[0]?.type).toBe("human_wait");
  });

  it("renders the Human Wait type badge for a human_wait draft", () => {
    const html = renderStatic([
      { ...emptyStep(), id: "hw-1", title: "사람 승인 대기", type: "human_wait" as StepDraft["type"] },
    ]);
    expect(html).toContain("Human Wait");
  });
});

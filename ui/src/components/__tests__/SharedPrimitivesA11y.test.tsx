/** @vitest-environment jsdom */
// [purpose] SharedPrimitivesA11y: 공유 프리미티브(ToggleField, Field)와 워크플로 에러 상태
//   (WorkflowErrorState)의 접근성 계약을 검증한다. ToggleField는 role=switch + aria-checked +
//   접근 가능한 이름 + type=button을, Field는 label과 컨트롤의 htmlFor/id 연결을,
//   WorkflowErrorState는 에러 배너 role=alert와 Retry 버튼 type=button을 만족해야 한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, ToggleField } from "../agent-config-primitives";
import { WorkflowErrorState } from "../../pages/workflows/workflow-page-states.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

describe("ToggleField accessibility", () => {
  it("exposes role=switch, aria-checked, accessible name, and explicit type=button", async () => {
    await mount(<ToggleField label="Heartbeat" checked={true} onChange={() => {}} />);
    const button = host!.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("type")).toBe("button");
    expect(button!.getAttribute("role")).toBe("switch");
    expect(button!.getAttribute("aria-checked")).toBe("true");
    expect(button!.getAttribute("aria-label")).toBe("Heartbeat");

    await mount(<ToggleField label="Heartbeat" checked={false} onChange={() => {}} />);
    const unchecked = host!.querySelector("button");
    expect(unchecked!.getAttribute("aria-checked")).toBe("false");
  });

  it("reports the new state through onChange on click", async () => {
    const onChange = vi.fn();
    await mount(<ToggleField label="Wake on demand" checked={false} onChange={onChange} />);
    const button = host!.querySelector("button")!;
    await act(async () => {
      button.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Field accessibility", () => {
  it("associates the label with its single child control via htmlFor/id", async () => {
    await mount(
      <Field label="Display name">
        <input defaultValue="alpha" />
      </Field>,
    );
    const label = host!.querySelector("label");
    const input = host!.querySelector("input");
    expect(label).not.toBeNull();
    expect(input).not.toBeNull();
    expect(input!.id).not.toBe("");
    expect(label!.getAttribute("for")).toBe(input!.id);
  });

  it("keeps a caller-provided control id and points the label at it", async () => {
    await mount(
      <Field label="Model">
        <input id="model-input" defaultValue="gpt" />
      </Field>,
    );
    const label = host!.querySelector("label")!;
    const input = host!.querySelector("input")!;
    expect(input.id).toBe("model-input");
    expect(label.getAttribute("for")).toBe("model-input");
  });
});

describe("WorkflowErrorState accessibility", () => {
  it("marks the error banner as role=alert and keeps the retry button type=button", async () => {
    const onRetry = vi.fn();
    await mount(
      <WorkflowErrorState
        pluginId="wf-a11y-test"
        isRefreshing={false}
        refreshButtonLabel="Refresh"
        onRefresh={() => {}}
        message="Failed to load workflows: boom"
        onRetry={onRetry}
      />,
    );

    const alert = host!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Failed to load workflows: boom");

    const retryButton = Array.from(host!.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).toBeDefined();
    expect(retryButton!.getAttribute("type")).toBe("button");

    await act(async () => {
      retryButton!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

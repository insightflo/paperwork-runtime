// @vitest-environment jsdom
// Front-End-Checklist accessibility audit for the workspace & onboarding panels:
// AgentSharedTablesPanel, AgentOpenWaitsBanner, QuickStartChecklist.
// Contract: icon-only buttons carry type/aria-label, inputs are labelled,
// status/error content is announced (role="status"/"alert"), table headers scope columns.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSharedTablesPanel } from "../AgentSharedTablesPanel";
import { AgentOpenWaitsBanner, type AgentOpenWaitItem } from "../AgentOpenWaitsBanner";
import { QuickStartChecklist } from "../QuickStartChecklist";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Icon-only buttons (no visible text) must expose an aria-label; every button must declare type.
function expectButtonsLabelled() {
  for (const button of Array.from(host.querySelectorAll("button"))) {
    expect(button.getAttribute("type"), `button ${button.textContent} needs type`).not.toBeNull();
    if (!button.textContent?.trim()) {
      expect(button.getAttribute("aria-label"), `icon-only button needs aria-label`).toBeTruthy();
    }
  }
}
function expectInputsLabelled() {
  for (const control of host.querySelectorAll("input, select, textarea")) {
    const label = control.getAttribute("aria-label")
      ?? (control.id ? host.querySelector(`label[for="${control.id}"]`)?.textContent : null);
    expect(label, `control ${control.tagName} needs a label`).toBeTruthy();
  }
}

describe("workspace panels accessibility (Front-End-Checklist)", () => {
  it("AgentSharedTablesPanel: labelled controls, scoped headers, submit type, and error alert", async () => {
    const onCreateTable = vi.fn().mockRejectedValue(new Error("table failed"));
    await render(
      <AgentSharedTablesPanel
        tables={[{ id: "t1", name: "고객 목록", columns: ["이름", "상태"], rows: [{ "이름": "김철수", "상태": "활성" }] }]}
        onCreateTable={onCreateTable}
      />,
    );
    expectButtonsLabelled();
    expectInputsLabelled();
    expect(host.querySelectorAll("th[scope='col']").length).toBe(2);
    expect(host.querySelector("button[type='submit']")?.textContent).toContain("만들기");

    await typeInto(host.querySelector<HTMLInputElement>("input[aria-label='표 이름']")!, "신규 표");
    await typeInto(host.querySelector<HTMLInputElement>("input[aria-label='열 이름']")!, "이름, 상태");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(onCreateTable).toHaveBeenCalledExactlyOnceWith({ name: "신규 표", columns: ["이름", "상태"] });
    expect(host.querySelector("[role='alert']")?.textContent).toContain("만들지 못했습니다");
  });

  it("AgentOpenWaitsBanner: announces the wait count politely and keeps resolve buttons typed", async () => {
    const waits: AgentOpenWaitItem[] = [{
      id: "w1", kind: "external-approval", summary: "승인 대기", createdAt: "2026-01-01T00:00:00Z",
    }];
    await render(<AgentOpenWaitsBanner waits={waits} onResolve={vi.fn()} />);
    expectButtonsLabelled();
    const count = host.querySelector("[role='status']");
    expect(count?.getAttribute("aria-live")).toBe("polite");
    expect(count?.textContent).toContain("대기 중인 요청 1건");
    expect(host.querySelector("button")?.getAttribute("type")).toBe("button");
  });

  it("QuickStartChecklist: labelled dismiss/step buttons and a polite progress status", async () => {
    await render(
      <QuickStartChecklist
        hasAgent={false}
        hasChannel={false}
        hasEndpointBot={false}
        storageKey="paperwork.quickstart.a11y-test"
      />,
    );
    expectButtonsLabelled();
    expectInputsLabelled();
    expect(host.querySelector("button[aria-label='닫기']")).not.toBeNull();
    const stepButtons = Array.from(host.querySelectorAll("ol button"));
    expect(stepButtons.length).toBe(3);
    for (const button of stepButtons) {
      expect(button.getAttribute("aria-label")).toContain("시작");
    }
    expect(host.querySelector("[role='status']")?.textContent).toContain("0 / 3 완료");
  });
});

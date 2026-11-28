// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphInspectorPolicyRuntime } from "../GraphInspectorPolicyRuntime.js";
import { GraphInspectorRawStep } from "../GraphInspectorRawStep.js";
import { WorkflowGraphExecutionEvidenceDrawer } from "../GraphDrawers.js";
import { jsonToSteps } from "../../step-draft.js";

// Front-End-Checklist: accessible control names, keyboard focus, live feedback.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;

async function render(node: ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(node));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
});

function expectNamedControls() {
  const controls = host.querySelectorAll("input, select, textarea");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.getAttribute("aria-label")?.trim()).toBeTruthy();
  for (const button of host.querySelectorAll<HTMLButtonElement>("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
  }
}

const noop = () => {};
describe("graph editor accessibility", () => {
  it("names approval and scheduling fields and keeps their handlers connected", async () => {
    const steps = jsonToSteps([{ id: "draft", title: "Draft", type: "agent" }]);
    const approval = vi.fn();
    const execution = vi.fn();
    await render(<GraphInspectorPolicyRuntime selectedStep={steps[0]!}
      updateSelectedApproval={approval} updateSelectedExecution={execution} />);
    expectNamedControls();
    for (const label of ["Suspend until approved", "Approval prompt", "Approvers",
      "Approval timeout seconds", "Approval timeout action", "Concurrency key",
      "Concurrency limit", "Priority", "Cache step result", "Cache TTL seconds",
      "Delete logs and results after use"]) {
      expect(host.querySelector(`[aria-label="${label}"]`), label).toBeTruthy();
    }
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Approval prompt"]')!;
    prompt.focus();
    expect(document.activeElement).toBe(prompt);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Review draft");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      host.querySelector<HTMLInputElement>('input[aria-label="Cache step result"]')!.click();
    });
    expect(approval).toHaveBeenCalledWith({ graphApprovalPrompt: "Review draft" });
    expect(execution).toHaveBeenCalledWith({ graphCacheEnabled: true });
  });

  it("names raw JSON and its icon button, and announces validation errors and success", async () => {
    const validate = vi.fn();
    const apply = vi.fn();
    const props: ComponentProps<typeof GraphInspectorRawStep> = {
      showRawInspector: true, rawStepJsonText: '{"id":"draft"}', rawStepJsonFeedback: null,
      selectedStepId: "draft", setRawStepJsonText: noop, setRawStepJsonFeedback: noop,
      validateRawSelectedStepJson: validate, applyRawSelectedStepJson: apply,
    };
    await render(<GraphInspectorRawStep {...props} />);
    expectNamedControls();
    expect(host.querySelector('textarea[aria-label="Raw step JSON"]')).toBeTruthy();
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copy JSON"]')!;
    expect(copy.getAttribute("type")).toBe("button");
    copy.focus();
    expect(document.activeElement).toBe(copy);
    const feedback = host.querySelector('[role="status"]')!;
    expect(feedback.getAttribute("aria-live")).toBe("polite");
    await act(async () => {
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Validate")!.click();
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Apply")!.click();
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    await render(<GraphInspectorRawStep {...props} rawStepJsonFeedback={{ tone: "error", message: "Invalid JSON" }} />);
    expect(host.querySelector('[role="alert"]')).toBe(feedback);
    expect(feedback.textContent).toBe("Invalid JSON");
    await render(<GraphInspectorRawStep {...props} rawStepJsonFeedback={{ tone: "success", message: "Applied" }} />);
    expect(host.querySelector('[role="status"]')).toBe(feedback);
    expect(feedback.getAttribute("aria-live")).toBe("polite");
    expect(feedback.textContent).toBe("Applied");
  });

  it("announces evidence summary updates without including logs or outputs, and keeps Close working", async () => {
    const onClose = vi.fn();
    const summary: ComponentProps<typeof WorkflowGraphExecutionEvidenceDrawer>["summary"] = {
      selectedStepId: "draft", title: "Draft evidence", tone: "neutral", available: true,
      summary: "Waiting for evidence", badges: [], metrics: [], resultPreview: "Result details",
      logPreview: "Verbose log", workProducts: [],
    };
    await render(<WorkflowGraphExecutionEvidenceDrawer summary={summary} onClose={onClose} />);
    const status = host.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.textContent).toBe("Waiting for evidence");
    await render(<WorkflowGraphExecutionEvidenceDrawer summary={{ ...summary, summary: "Evidence ready" }} onClose={onClose} />);
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status.textContent).toBe("Evidence ready");
    const close = host.querySelector("button")!;
    expect(close.getAttribute("type")).toBe("button");
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});

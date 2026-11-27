// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { WorkflowRunGraphPreview } from "./GraphRunPreview.js";
import type { WorkflowGraphStep } from "../workflow-graph.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

it("does not inherit editor-only native scrolling or viewport height bounds in run preview", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunGraphPreview steps={[
    { id: "collect", title: "Collect", type: "agent", graphPositionX: 0, graphPositionY: 0 },
  ]} />));
  const tools = container.querySelector<HTMLElement>("[data-graph-toolbar='true']")!;
  const viewport = tools.parentElement!.parentElement!;
  // This consumer has no native-scroll coordinate/reset support: preserve its original viewport.
  expect(viewport.style.overflow).toBe("hidden");
  expect(viewport.style.height).toBe("100%");
  expect(viewport.style.minHeight).toBe("260px");
  expect(viewport.style.maxHeight).toBe("");
  const content = [...viewport.querySelectorAll<HTMLElement>("div")].find((div) => div.style.transform)!;
  await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 160,
  })));
  const values = content.style.transform.match(/-?[\d.]+/g)!.map(Number);
  expect(values[0]).toBeCloseTo(-20);
  expect(values[1]).toBeCloseTo(-16);
  expect(values[2]).toBe(1.1);
  await act(async () => container.querySelector("button[aria-label='Reset zoom']")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
});

function previewTimelineFixture(): WorkflowGraphStep[] {
  return [
    {
      id: "draft",
      title: "Draft outline",
      type: "agent",
      dependsOn: [],
      graphRunStatus: "succeeded",
      graphRunStartedAt: "2026-02-14T09:00:00.000Z",
      graphRunCompletedAt: "2026-02-14T09:00:04.000Z",
    },
    {
      id: "fetch",
      title: "Fetch sources",
      type: "tool",
      dependsOn: [],
      graphRunStatus: "succeeded",
      graphRunStartedAt: "2026-02-14T09:00:00.000Z",
      graphRunCompletedAt: "2026-02-14T09:00:02.000Z",
    },
    {
      id: "merge",
      title: "Merge results",
      type: "tool",
      dependsOn: ["draft", "fetch"],
      graphRunStatus: "running",
      graphRunStartedAt: "2026-02-14T09:00:04.000Z",
    },
  ];
}

it("renders the existing graph preview by default with the graph option pressed", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunGraphPreview steps={previewTimelineFixture()} />));
  expect(container.querySelector("[data-run-preview-view-toggle='true']")).toBeTruthy();
  expect(container.querySelector("button[data-view-option='graph']")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("button[data-view-option='timeline']")?.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("[data-graph-toolbar='true']")).toBeTruthy();
  expect(container.querySelector("[data-graph-run-timeline='true']")).toBeNull();
});

it("mounts GraphRunTimeline with logical class and status badges when the timeline option is clicked", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunGraphPreview steps={previewTimelineFixture()} />));
  const timelineButton = container.querySelector("button[data-view-option='timeline']")!;
  await act(async () => timelineButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector("button[data-view-option='timeline']")!.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("[data-graph-run-timeline='true']")).toBeTruthy();
  expect(container.querySelector("[data-graph-toolbar='true']")).toBeNull();
  const badgeOf = (stepId: string) =>
    container.querySelector(`[data-timeline-step='${stepId}'] [data-node-logical-class]`);
  expect(badgeOf("draft")?.getAttribute("data-node-logical-class")).toBe("ai_agent");
  expect(badgeOf("draft")?.textContent).toBe("AI Agent");
  expect(badgeOf("fetch")?.getAttribute("data-node-logical-class")).toBe("function");
  expect(badgeOf("merge")?.getAttribute("data-node-logical-class")).toBe("function");
  expect(container.querySelector("[data-timeline-step='draft']")?.textContent).toContain("succeeded");
  expect(container.querySelector("[data-timeline-step='merge']")?.textContent).toContain("running");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  nodeLogicalClassBadgeLabel,
  nodeLogicalClassLabels,
  resolveNodeLogicalClass,
} from "./graph-editor/node-logical-class.js";
import {
  buildGraphRunTimelineSegments,
  formatGraphRunStepDuration,
  type GraphRunTimelineStepInput,
} from "./graph-run-timeline-segments.js";
import { GraphRunTimeline } from "./GraphRunTimeline.js";
import type { WorkflowGraphStep } from "./workflow-graph.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function renderTimeline(steps: WorkflowGraphStep[]): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<GraphRunTimeline steps={steps} />));
  return container;
}

function timelineFixture(): WorkflowGraphStep[] {
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
      graphRunStatus: "succeeded",
      graphRunStartedAt: "2026-02-14T09:00:04.000Z",
      graphRunCompletedAt: "2026-02-14T09:00:05.000Z",
    },
    {
      id: "approve",
      title: "Approve publication",
      type: "agent",
      dependsOn: ["merge"],
      graphApprovalRequired: true,
      graphRunStatus: "paused",
      graphRunStepRunId: "sr-approve",
      graphRunDecisionId: "dec-1",
      graphRunStartedAt: "2026-02-14T09:00:05.000Z",
      graphRunUpdatedAt: "2026-02-14T09:00:06.000Z",
    },
    {
      id: "publish",
      title: "Publish post",
      type: "tool",
      dependsOn: ["approve"],
      graphRunStatus: "succeeded",
      graphRunStartedAt: "2026-02-14T09:05:00.000Z",
      graphRunCompletedAt: "2026-02-14T09:05:03.000Z",
    },
  ];
}

it("maps deterministic step types onto the function logical class", () => {
  for (const type of ["tool", "if", "complete"]) {
    expect(resolveNodeLogicalClass({ type })).toBe("function");
  }
});

it("maps agent and child-workflow delegation onto the ai_agent logical class", () => {
  expect(resolveNodeLogicalClass({ type: "agent" })).toBe("ai_agent");
  expect(resolveNodeLogicalClass({ type: "workflow" })).toBe("ai_agent");
});

it("promotes human_wait type and graphApprovalRequired onto the human_wait logical class", () => {
  expect(resolveNodeLogicalClass({ type: "human_wait" })).toBe("human_wait");
  expect(resolveNodeLogicalClass({ type: "agent", graphApprovalRequired: true })).toBe("human_wait");
  expect(resolveNodeLogicalClass({ type: "tool", graphApprovalRequired: "true" })).toBe("human_wait");
  expect(resolveNodeLogicalClass({ type: "agent", graphApprovalRequired: false })).toBe("ai_agent");
  expect(resolveNodeLogicalClass({ type: "agent", graphApprovalRequired: "false" })).toBe("ai_agent");
});

it("exposes bilingual labels and English badge text for all three classes", () => {
  expect(nodeLogicalClassBadgeLabel("function")).toBe("Function");
  expect(nodeLogicalClassBadgeLabel("ai_agent")).toBe("AI Agent");
  expect(nodeLogicalClassBadgeLabel("human_wait")).toBe("Human Wait");
  expect(nodeLogicalClassLabels.function.ko).toContain("코드");
  expect(nodeLogicalClassLabels.ai_agent.ko).toContain("AI 에이전트");
  expect(nodeLogicalClassLabels.human_wait.ko).toContain("사람 대기");
});

it("formats step durations deterministically", () => {
  expect(formatGraphRunStepDuration("2026-02-14T09:00:00.000Z", "2026-02-14T09:00:04.000Z")).toBe("4.0s");
  expect(formatGraphRunStepDuration("2026-02-14T09:00:00.000Z", "2026-02-14T09:02:05.000Z")).toBe("2m 05s");
  expect(formatGraphRunStepDuration("2026-02-14T09:00:00.000Z", "not-a-date")).toBe("");
  expect(formatGraphRunStepDuration("2026-02-14T09:00:04.000Z", "2026-02-14T09:00:04.000Z")).toBe("0.0s");
});

it("computes parallel, join, human wait and resume segments in execution order", () => {
  const segments = buildGraphRunTimelineSegments(timelineFixture());
  expect(segments.map((segment) => segment.kind)).toEqual(["parallel", "join", "human_wait", "resume"]);
  if (segments[0]?.kind !== "parallel") throw new Error("expected parallel segment");
  expect(segments[0].stepIds).toEqual(["draft", "fetch"]);
  if (segments[1]?.kind !== "join") throw new Error("expected join segment");
  expect(segments[1].stepId).toBe("merge");
  expect(segments[1].inboundStepIds).toEqual(expect.arrayContaining(["draft", "fetch"]));
  if (segments[2]?.kind !== "human_wait") throw new Error("expected human_wait segment");
  expect(segments[2].stepId).toBe("approve");
  expect(segments[2].stepRunId).toBe("sr-approve");
  expect(segments[2].decisionId).toBe("dec-1");
  expect(segments[2].pausedAt).toBe("2026-02-14T09:00:05.000Z");
  expect(segments[2].resolvedAt).toBeNull();
  if (segments[3]?.kind !== "resume") throw new Error("expected resume segment");
  expect(segments[3].stepIds).toEqual(["publish"]);
  expect(segments[3].afterStepId).toBe("approve");
});

it("renders parallel wave, join, pause indicator and resumed continuation", async () => {
  const rendered = await renderTimeline(timelineFixture());
  expect(rendered.querySelector("[data-graph-run-timeline='true']")).toBeTruthy();
  const parallel = rendered.querySelector("[data-timeline-segment='parallel']");
  expect(parallel?.querySelectorAll("[data-timeline-step]").length).toBe(2);
  expect(rendered.querySelector("[data-timeline-segment='join']")).toBeTruthy();
  expect(rendered.querySelector("[data-timeline-segment='resume']")).toBeTruthy();

  const badgeOf = (stepId: string) =>
    rendered.querySelector(`[data-timeline-step='${stepId}'] [data-node-logical-class]`);
  expect(badgeOf("draft")?.getAttribute("data-node-logical-class")).toBe("ai_agent");
  expect(badgeOf("draft")?.textContent).toBe("AI Agent");
  expect(badgeOf("fetch")?.getAttribute("data-node-logical-class")).toBe("function");
  expect(badgeOf("fetch")?.textContent).toBe("Function");
  expect(badgeOf("approve")?.getAttribute("data-node-logical-class")).toBe("human_wait");
  expect(badgeOf("approve")?.textContent).toBe("Human Wait");

  const wait = rendered.querySelector("[data-timeline-segment='human_wait']")!;
  expect(wait).toBeTruthy();
  expect(wait.querySelector("[data-pause-indicator='true']")?.textContent).toContain("Paused · awaiting approval");
  expect(wait.querySelector("[data-pause-indicator='true']")?.getAttribute("data-wait-state")).toBe("pending");
  expect(wait.querySelector("[data-decision-id-pill='true']")?.textContent).toBe("#dec-1");
  expect(wait.textContent).toContain("paused");

  const resume = rendered.querySelector("[data-timeline-segment='resume']")!;
  expect(resume.querySelector("[data-timeline-step='publish']")).toBeTruthy();
  expect(resume.textContent).toContain("after Approve publication");

  expect(rendered.textContent).toContain("4.0s");
  expect(rendered.textContent).toContain("Parallel wave");
});

function timelineFixtureWithOverlay(approveOverrides: Record<string, unknown>): GraphRunTimelineStepInput[] {
  return timelineFixture().map((step) => (step.id === "approve" ? { ...step, ...approveOverrides } : step));
}

it("maps the live humanWaitDecision overlay onto a pending pause segment", async () => {
  const steps = timelineFixtureWithOverlay({
    graphRunDecisionId: "dec-legacy",
    humanWaitDecision: {
      decisionId: "dec-live-pending",
      status: "pending",
      pausedAt: "2026-02-14T09:00:07.500Z",
      resolvedAt: null,
    },
  });
  const segments = buildGraphRunTimelineSegments(steps);
  if (segments[2]?.kind !== "human_wait") throw new Error("expected human_wait segment");
  expect(segments[2].decisionId).toBe("dec-live-pending");
  expect(segments[2].pausedAt).toBe("2026-02-14T09:00:07.500Z");
  expect(segments[2].resolvedAt).toBeNull();
  expect(segments[2].outcome).toBe("pending");

  const rendered = await renderTimeline(steps);
  const wait = rendered.querySelector("[data-timeline-segment='human_wait']")!;
  expect(wait).toBeTruthy();
  const pendingIndicator = wait.querySelector("[data-pause-indicator='true']");
  expect(pendingIndicator?.textContent).toBe("Paused · awaiting approval");
  expect(pendingIndicator?.getAttribute("data-wait-state")).toBe("pending");
  expect(wait.querySelector("[data-decision-id-pill='true']")?.textContent).toBe("#dec-live-pen…");
});

it("maps the live humanWaitDecision overlay onto a resolved resume segment", async () => {
  const steps = timelineFixtureWithOverlay({
    graphRunStatus: "succeeded",
    graphRunCompletedAt: "2026-02-14T09:06:30.000Z",
    humanWaitDecision: {
      decisionId: "dec-live-resolved",
      status: "approved",
      pausedAt: "2026-02-14T09:00:07.500Z",
      resolvedAt: "2026-02-14T09:05:00.000Z",
    },
  });
  const segments = buildGraphRunTimelineSegments(steps);
  if (segments[2]?.kind !== "human_wait") throw new Error("expected human_wait segment");
  expect(segments[2].decisionId).toBe("dec-live-resolved");
  expect(segments[2].pausedAt).toBe("2026-02-14T09:00:07.500Z");
  expect(segments[2].resolvedAt).toBe("2026-02-14T09:05:00.000Z");
  expect(segments[2].outcome).toBe("approved");
  if (segments[3]?.kind !== "resume") throw new Error("expected resume segment");
  expect(segments[3].afterStepId).toBe("approve");

  const rendered = await renderTimeline(steps);
  const wait = rendered.querySelector("[data-timeline-segment='human_wait']")!;
  expect(wait).toBeTruthy();
  const approvedIndicator = wait.querySelector("[data-pause-indicator='true']");
  expect(approvedIndicator?.textContent).toBe("Approved · resumed");
  expect(approvedIndicator?.getAttribute("data-wait-state")).toBe("approved");
  expect(approvedIndicator?.getAttribute("style")).toContain("var(--pw-emerald)");
  expect(wait.querySelector("[data-decision-id-pill='true']")?.textContent).toBe("#dec-live-res…");
  const resume = rendered.querySelector("[data-timeline-segment='resume']")!;
  expect(resume.querySelector("[data-timeline-step='publish']")).toBeTruthy();
});

it("renders a rejected human_wait decision as a halted crimson state", async () => {
  const steps = timelineFixtureWithOverlay({
    graphRunStatus: "failed",
    humanWaitDecision: {
      decisionId: "dec-live-rejected",
      status: "rejected",
      pausedAt: "2026-02-14T09:00:07.500Z",
      resolvedAt: "2026-02-14T09:04:00.000Z",
    },
  });
  const rendered = await renderTimeline(steps);
  const wait = rendered.querySelector("[data-timeline-segment='human_wait']")!;
  const indicator = wait.querySelector("[data-pause-indicator='true']")!;
  expect(indicator.getAttribute("data-wait-state")).toBe("rejected");
  expect(indicator.textContent).toBe("Rejected · halted");
  expect(indicator.getAttribute("style")).toContain("var(--pw-crimson)");
  expect(wait.querySelector("[data-decision-id-pill='true']")?.textContent).toBe("#dec-live-rej…");
  expect(wait.textContent).not.toContain("Paused · awaiting approval");
  expect(wait.textContent).not.toContain("Approved · resumed");
});

it("renders an expired human_wait decision as a halted crimson state distinct from pending", async () => {
  const steps = timelineFixtureWithOverlay({
    graphRunStatus: "failed",
    humanWaitDecision: {
      decisionId: "dec-x9",
      status: "expired",
      pausedAt: "2026-02-14T09:00:07.500Z",
      resolvedAt: "2026-02-14T09:08:00.000Z",
    },
  });
  const rendered = await renderTimeline(steps);
  const wait = rendered.querySelector("[data-timeline-segment='human_wait']")!;
  const indicator = wait.querySelector("[data-pause-indicator='true']")!;
  expect(indicator.getAttribute("data-wait-state")).toBe("expired");
  expect(indicator.textContent).toBe("Expired · halted");
  expect(indicator.getAttribute("style")).toContain("var(--pw-crimson)");
  expect(wait.querySelector("[data-decision-id-pill='true']")?.textContent).toBe("#dec-x9");
  expect(wait.textContent).not.toContain("Paused · awaiting approval");
});

it("renders nothing without steps", async () => {
  const rendered = await renderTimeline([]);
  expect(rendered.querySelector("[data-graph-run-timeline='true']")).toBeNull();
});

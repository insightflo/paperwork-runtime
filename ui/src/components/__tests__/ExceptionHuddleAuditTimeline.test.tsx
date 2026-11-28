/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExceptionHuddleAuditTimeline,
  type ExceptionHuddleAuditTimelineItem,
  type ExceptionHuddleAuditTimelineProps,
} from "../ExceptionHuddleAuditTimeline";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const entries: ExceptionHuddleAuditTimelineItem[] = [
  {
    id: "entry-escalate",
    threadId: "thread-escalate",
    decisionKind: "escalate",
    decidedByAgentId: "agent-owner",
    createdAt: "2026-03-01T12:03:00.000Z",
    summary: "Owner escalation preserved the audit evidence.",
  },
  {
    id: "entry-retry",
    threadId: "thread-retry",
    decisionKind: "retry_with_guidance",
    decidedByAgentId: "agent-owner",
    createdAt: "2026-03-01T12:00:00.000Z",
    summary: "Attach missing validator evidence before retrying.",
  },
  {
    id: "entry-replan",
    threadId: null,
    decisionKind: "replan_remaining",
    decidedByAgentId: "agent-owner",
    createdAt: "2026-03-01T12:02:00.000Z",
    summary: null,
  },
  {
    id: "entry-waiver",
    threadId: "thread-waiver",
    decisionKind: "accept_with_waiver",
    decidedByAgentId: null,
    createdAt: "2026-03-01T12:01:00.000Z",
    summary: "Waiver is limited to this release candidate.",
  },
];

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderTimeline(props: Partial<ExceptionHuddleAuditTimelineProps> = {}) {
  await mount(<ExceptionHuddleAuditTimeline entries={[]} {...props} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("ExceptionHuddleAuditTimeline", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = "";
  });

  it("renders an accessible empty status without a timeline list", async () => {
    await renderTimeline({ entries: [] });

    const status = host.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("No exception huddle audit entries yet.");
    expect(host.querySelector("ol")).toBeNull();
  });

  it("renders all decision labels, summaries, timestamps, and entries in chronological order", async () => {
    await renderTimeline({ entries });

    const list = host.querySelector("ol");
    expect(list).toBeTruthy();
    expect(list!.querySelectorAll("li")).toHaveLength(4);

    expect(host.textContent).toContain("재시도 (가이드 포함)");
    expect(host.textContent).toContain("면책 승인");
    expect(host.textContent).toContain("잔여 단계 재계획");
    expect(host.textContent).toContain("상위 에스컬레이션");
    expect(host.textContent).toContain("Attach missing validator evidence before retrying.");
    expect(host.textContent).toContain("Waiver is limited to this release candidate.");
    expect(host.textContent).toContain("Owner escalation preserved the audit evidence.");

    expect([...list!.querySelectorAll("time")].map((time) => time.getAttribute("dateTime"))).toEqual([
      "2026-03-01T12:00:00.000Z",
      "2026-03-01T12:01:00.000Z",
      "2026-03-01T12:02:00.000Z",
      "2026-03-01T12:03:00.000Z",
    ]);
  });

  it("uses explicit button types and invokes onOpenThread only for entries with a thread", async () => {
    const onOpenThread = vi.fn();
    await renderTimeline({ entries, onOpenThread });

    const buttons = [...host.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.getAttribute("type") === "button")).toBe(true);

    click(buttons[0]!);
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith("thread-retry");
  });

  it("does not render thread actions when onOpenThread is absent", async () => {
    await renderTimeline({ entries });

    expect(host.querySelector("button")).toBeNull();
  });
});

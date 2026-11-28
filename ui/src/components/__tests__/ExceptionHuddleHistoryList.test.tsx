/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  ExceptionHuddleHistoryList,
  type ExceptionHuddleHistoryItem,
  type ExceptionHuddleHistoryListProps,
} from "../ExceptionHuddleHistoryList";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function huddle(
  status: ExceptionHuddleMetadata["status"],
  overrides: Partial<ExceptionHuddleMetadata> = {},
): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "workflow-run-1",
    sourceStepId: "step-1",
    sourceIssueId: "issue-1",
    workProductLinks: [],
    participants: {
      ownerAgentId: "owner-agent",
      producerAgentId: "producer-agent",
      validatorAgentId: "validator-agent",
    },
    maxRounds: 2,
    currentRound: status === "open" ? 1 : 2,
    timeoutAt: "2026-01-01T00:05:00.000Z",
    status,
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function item(
  threadId: string,
  title: string,
  status: ExceptionHuddleMetadata["status"],
  updatedAt: string,
): ExceptionHuddleHistoryItem {
  const decision =
    status === "decided"
      ? {
          kind: "retry_with_guidance" as const,
          rationale: "Validator evidence was incomplete.",
          guidance: "Add the missing QA evidence.",
          forcedByChair: false,
        }
      : null;
  return {
    threadId,
    channelId: "channel-1",
    title,
    updatedAt,
    huddle: huddle(status, {
      decision,
      decidedByAgentId: decision ? "owner-agent" : null,
      decidedAt: decision ? "2026-01-01T00:03:00.000Z" : null,
    }),
  };
}

const ITEMS: ExceptionHuddleHistoryItem[] = [
  item("thread-open-1", "Open escalation review", "open", "2026-01-01T12:00:00.000Z"),
  item("thread-timeout", "Timed-out validator conflict", "timed_out", "2026-01-02T12:00:00.000Z"),
  item("thread-decided", "Decision follow-up", "decided", "2026-01-03T12:00:00.000Z"),
  item("thread-cancelled", "Cancelled duplicate huddle", "cancelled", "2026-01-04T12:00:00.000Z"),
  item("thread-open-2", "Second open escalation", "open", "2026-01-05T12:00:00.000Z"),
];

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderList(props: Partial<ExceptionHuddleHistoryListProps> = {}) {
  const merged: ExceptionHuddleHistoryListProps = { items: ITEMS, ...props };
  await mount(<ExceptionHuddleHistoryList {...merged} />);
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function tabs(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

function tabByLabel(label: string): HTMLButtonElement {
  const tab = tabs().find((candidate) => candidate.textContent?.startsWith(label));
  expect(tab, `${label} tab`).toBeTruthy();
  return tab!;
}

function tabCount(label: string): string | null {
  const spans = tabByLabel(label).querySelectorAll("span");
  return spans[spans.length - 1]?.textContent ?? null;
}

function rows(): HTMLLIElement[] {
  return [...host.querySelectorAll<HTMLLIElement>("ul > li")];
}

function visibleTitles(): Array<string | null> {
  return rows().map((row) => row.querySelector("h3")?.textContent ?? null);
}

describe("ExceptionHuddleHistoryList", () => {
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

  it("renders exact count badges for all statuses in an accessible tab strip", async () => {
    await renderList();

    expect(host.querySelector('[role="tablist"]')).toBeTruthy();
    expect(tabs()).toHaveLength(5);
    for (const tab of tabs()) {
      expect(tab.getAttribute("type")).toBe("button");
      expect(tab.hasAttribute("aria-selected")).toBe(true);
    }
    expect(tabCount("All")).toBe("5");
    expect(tabCount("Open")).toBe("2");
    expect(tabCount("Timed Out")).toBe("1");
    expect(tabCount("Decided")).toBe("1");
    expect(tabCount("Cancelled")).toBe("1");
    expect(host.querySelector("ul")).toBeTruthy();
    expect(rows()).toHaveLength(5);
  });

  it("clicking each filter tab narrows the displayed rows accurately", async () => {
    await renderList();

    const expectations: Array<[string, string[]]> = [
      ["Open", ["Open escalation review", "Second open escalation"]],
      ["Timed Out", ["Timed-out validator conflict"]],
      ["Decided", ["Decision follow-up"]],
      ["Cancelled", ["Cancelled duplicate huddle"]],
    ];

    for (const [label, titles] of expectations) {
      await click(tabByLabel(label));
      expect(tabByLabel(label).getAttribute("aria-selected")).toBe("true");
      expect(visibleTitles()).toEqual(titles);
    }

    await click(tabByLabel("All"));
    expect(visibleTitles()).toEqual(ITEMS.map((entry) => entry.title));
  });

  it("fires onOpenHuddle with the clicked item", async () => {
    const onOpenHuddle = vi.fn();
    await renderList({ onOpenHuddle });

    const row = rows().find((candidate) => candidate.textContent?.includes("Decision follow-up"));
    expect(row, "decided row").toBeTruthy();
    const button = row!.querySelector("button");
    expect(button, "huddle open button").toBeTruthy();
    expect(button!.getAttribute("type")).toBe("button");
    await click(button!);

    expect(onOpenHuddle).toHaveBeenCalledTimes(1);
    expect(onOpenHuddle).toHaveBeenCalledWith(ITEMS[2]);
  });

  it("renders an accessible empty state when no items match the selected filter", async () => {
    await renderList({ items: [ITEMS[0]!], initialFilter: "decided" });

    const status = host.querySelector('[role="status"]');
    expect(status, "empty state role=status").toBeTruthy();
    expect(status!.textContent).toContain("No exception huddles match the Decided filter");
    expect(status!.textContent).toContain("필터에 맞는 예외 허들이 없습니다");
    expect(host.querySelector("ul")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("shows the decided guidance snippet and a machine-readable timestamp", async () => {
    await renderList({ items: [ITEMS[2]!] });

    expect(host.textContent).toContain("Decision summary · 결정 요약");
    expect(host.textContent).toContain("Validator evidence was incomplete.");
    expect(host.textContent).toContain("Add the missing QA evidence.");
    const timestamp = host.querySelector("time");
    expect(timestamp).toBeTruthy();
    expect(timestamp!.getAttribute("dateTime")).toBe(ITEMS[2]!.updatedAt);
    expect(timestamp!.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("supports arrow-key movement across the status filter tabs", async () => {
    await renderList();

    const allTab = tabByLabel("All");
    allTab.focus();
    await act(async () => {
      allTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(tabByLabel("Open").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabByLabel("Open"));
    expect(visibleTitles()).toEqual(["Open escalation review", "Second open escalation"]);
  });
});

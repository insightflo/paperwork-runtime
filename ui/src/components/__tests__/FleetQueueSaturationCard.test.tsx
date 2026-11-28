/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FleetQueueSaturationCard,
  formatQueueWaitMs,
  type AgentQueueRow,
  type FleetQueueSummary,
} from "../FleetQueueSaturationCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function queueRow(overrides: Partial<AgentQueueRow> = {}): AgentQueueRow {
  return {
    agentId: "agent-alpha",
    agentName: "Executor Alpha",
    maxConcurrentRuns: 4,
    runningCount: 4,
    queuedCount: 3,
    utilizationRatio: 1,
    saturated: true,
    oldestQueuedWaitMs: 7_260_000,
    starvationWarning: true,
    distinctQueuedIssues: 2,
    ...overrides,
  };
}

function queueSummary(overrides: Partial<FleetQueueSummary> = {}): FleetQueueSummary {
  return {
    totalSlots: 6,
    totalRunning: 5,
    totalQueued: 4,
    saturatedAgents: 1,
    starvingAgents: 1,
    maxQueuedWaitMs: 7_260_000,
    byAgent: [
      queueRow(),
      queueRow({
        agentId: "agent-beta",
        agentName: "Executor Beta",
        runningCount: 1,
        queuedCount: 1,
        utilizationRatio: 0.25,
        saturated: false,
        oldestQueuedWaitMs: 45_000,
        starvationWarning: false,
        distinctQueuedIssues: 1,
      }),
    ],
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderCard(summary: FleetQueueSummary | null | undefined, onSelectAgent?: (agentId: string) => void) {
  await mount(<FleetQueueSaturationCard summary={summary} onSelectAgent={onSelectAgent} />);
}

describe("formatQueueWaitMs", () => {
  it("formats sub-minute, minute, and hour edge cases", () => {
    expect(formatQueueWaitMs(Number.NaN)).toBe("<1분");
    expect(formatQueueWaitMs(-1)).toBe("<1분");
    expect(formatQueueWaitMs(0)).toBe("<1분");
    expect(formatQueueWaitMs(59_999)).toBe("<1분");
    expect(formatQueueWaitMs(60_000)).toBe("1분");
    expect(formatQueueWaitMs(3_599_999)).toBe("59분");
    expect(formatQueueWaitMs(3_600_000)).toBe("1시간 0분");
    expect(formatQueueWaitMs(7_260_000)).toBe("2시간 1분");
  });
});

describe("FleetQueueSaturationCard", () => {
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

  it("returns null when summary is missing or completely empty", async () => {
    await renderCard(null);
    expect(host.innerHTML).toBe("");

    await renderCard(undefined);
    expect(host.innerHTML).toBe("");

    await renderCard(queueSummary({ totalSlots: 0, totalQueued: 0, byAgent: [] }));
    expect(host.innerHTML).toBe("");
  });

  it("renders slot metrics and a high-contrast starving warning badge", async () => {
    await renderCard(queueSummary());

    const region = host.querySelector('[role="region"]');
    expect(region).toBeTruthy();
    expect(region!.getAttribute("aria-label")).toBe("실행 슬롯 및 큐 현황");
    expect(region!.className).toContain("tactile-card");
    expect(region!.className).toContain("tabular-nums");

    expect(host.textContent).toContain("실행 슬롯");
    expect(host.textContent).toContain("5 / 6");
    expect(host.textContent).toContain("대기 큐");
    expect(host.textContent).toContain("포화 에이전트");
    expect(host.textContent).toContain("장기 대기 경보");
    expect(host.textContent).toContain("4 / 4 · 큐 3");
    expect(host.textContent).toContain("최장 대기 2시간 1분");

    const badge = [...host.querySelectorAll("span")].find((candidate) => candidate.textContent === "장기 대기");
    expect(badge, "starving agent badge").toBeTruthy();
    expect(badge!.className).toContain("amber");
    expect(badge!.className).toContain("rose");

    const progress = host.querySelector('[role="progressbar"]');
    expect(progress).toBeTruthy();
    expect(progress!.getAttribute("aria-valuenow")).toBe("100");
  });

  it("invokes onSelectAgent with the agent id when an agent button is clicked", async () => {
    const onSelectAgent = vi.fn();
    await renderCard(queueSummary(), onSelectAgent);

    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Executor Alpha"));
    expect(button, "agent selection button").toBeTruthy();
    expect(button!.getAttribute("type")).toBe("button");

    act(() => {
      button!.click();
    });

    expect(onSelectAgent).toHaveBeenCalledTimes(1);
    expect(onSelectAgent).toHaveBeenCalledWith("agent-alpha");
  });
});

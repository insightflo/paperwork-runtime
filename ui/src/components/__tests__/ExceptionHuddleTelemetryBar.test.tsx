/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExceptionHuddleTelemetryBar, type ExceptionHuddleTelemetryBarData } from "../ExceptionHuddleTelemetryBar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const populatedSummary: ExceptionHuddleTelemetryBarData = {
  total: 8,
  byStatus: { open: 2, timed_out: 1, decided: 4, cancelled: 1 },
  averageRoundsOnDecided: 1.5,
  timeoutRate: 0.125,
  chairForcedDecisionCount: 2,
  resolutionRate: 0.625,
};

const emptySummary: ExceptionHuddleTelemetryBarData = {
  total: 0,
  byStatus: { open: 0, timed_out: 0, decided: 0, cancelled: 0 },
  averageRoundsOnDecided: null,
  timeoutRate: 0,
  chairForcedDecisionCount: 0,
  resolutionRate: 0,
};

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderBar(summary: ExceptionHuddleTelemetryBarData) {
  await mount(<ExceptionHuddleTelemetryBar summary={summary} />);
}

function metricValue(label: string) {
  const term = [...host.querySelectorAll("dt")].find((candidate) => candidate.textContent === label);
  expect(term, `${label} metric label`).toBeTruthy();
  const value = term!.parentElement?.querySelector("dd")?.textContent;
  expect(value, `${label} metric value`).toBeTruthy();
  return value!;
}

describe("ExceptionHuddleTelemetryBar", () => {
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

  it("renders the zero-total empty state as a status", async () => {
    await renderBar(emptySummary);

    const status = host.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toBe("No exception huddles recorded");
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Exception huddle telemetry");
    expect(host.querySelector("dl")).toBeNull();
  });

  it("renders populated counts, rounded percentage, average rounds, and chair-forced total", async () => {
    await renderBar(populatedSummary);

    expect(metricValue("Total huddles")).toBe("8");
    expect(metricValue("Open")).toBe("2");
    expect(metricValue("Timed Out")).toBe("1");
    expect(metricValue("Resolution Rate")).toBe("63%");
    expect(metricValue("Avg Rounds")).toBe("1.5");
    expect(metricValue("Chair Forced")).toBe("2");

    const timedOutLabel = [...host.querySelectorAll("dt")].find((candidate) => candidate.textContent === "Timed Out");
    expect(timedOutLabel?.parentElement?.className).toContain("amber");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("renders an em dash when average rounds on decided huddles is null", async () => {
    await renderBar({ ...populatedSummary, averageRoundsOnDecided: null });

    expect(metricValue("Avg Rounds")).toBe("—");
  });
});

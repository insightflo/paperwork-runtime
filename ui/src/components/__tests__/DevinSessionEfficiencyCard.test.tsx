/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DevinSessionEfficiencyCard,
  type DevinSessionMetricsView,
} from "../DevinSessionEfficiencyCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function makeMetrics(overrides: Partial<DevinSessionMetricsView> = {}): DevinSessionMetricsView {
  return {
    totalRuns: 12,
    successRatePercent: 91.7,
    resumeHitRatePercent: 66.7,
    freshRetryCount: 2,
    freeTierRunSharePercent: 33.3,
    avgDurationMs: 61_000,
    totalTokens: 12_345,
    ...overrides,
  };
}

async function renderCard(metrics: DevinSessionMetricsView | null | undefined) {
  await mount(<DevinSessionEfficiencyCard metrics={metrics} />);
}

describe("DevinSessionEfficiencyCard", () => {
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

  it("renders nothing when metrics are missing or there are no runs", async () => {
    await renderCard(null);
    expect(host.innerHTML).toBe("");

    await renderCard(undefined);
    expect(host.innerHTML).toBe("");

    await renderCard(makeMetrics({ totalRuns: 0 }));
    expect(host.innerHTML).toBe("");
  });

  it("renders all five Korean metrics with the accessible region label", async () => {
    await renderCard(makeMetrics());

    const card = host.querySelector("[data-testid='devin-session-efficiency-card']");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("role")).toBe("region");
    expect(card!.getAttribute("aria-label")).toBe("Devin 세션 효율 요약");

    expect(host.textContent).toContain("총 실행 12건");
    expect(host.textContent).toContain("성공률 91.7%");
    expect(host.textContent).toContain("세션 재개율 66.7%");
    expect(host.textContent).toContain("무료 티어 비중 33.3%");
    expect(host.textContent).toContain("평균 소요 61초");

    const metricItems = host.querySelectorAll("li");
    expect(metricItems).toHaveLength(5);
    expect(Array.from(metricItems).every((item) => item.className.includes("tabular-nums"))).toBe(true);
  });
});

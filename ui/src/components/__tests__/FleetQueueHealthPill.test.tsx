// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FleetQueueHealthPill,
  formatQueueHealthLevelLabel,
  type FleetQueueHealthLevel,
} from "../FleetQueueHealthPill";

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const baseProps = {
  level: "healthy" as const,
  headline: "실행 슬롯 4개 중 2개 사용",
  utilizationPercent: 50,
};

describe("formatQueueHealthLevelLabel", () => {
  const cases: Array<[FleetQueueHealthLevel, string]> = [
    ["healthy", "큐 정상"],
    ["degraded", "큐 혼잡"],
    ["critical", "큐 경보"],
  ];

  it.each(cases)("formats %s as %s", (level, label) => {
    expect(formatQueueHealthLevelLabel(level)).toBe(label);
  });
});

describe("FleetQueueHealthPill", () => {
  it("renders as a status span with an accessible headline and joined signals when onClick is absent", async () => {
    await render(
      <FleetQueueHealthPill {...baseProps} signals={["대기 2개", "재시도 증가"]} />,
    );

    const status = host.querySelector<HTMLSpanElement>('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.tagName).toBe("SPAN");
    expect(host.querySelector("button")).toBeNull();
    expect(status?.textContent).toContain("큐 정상");
    expect(status?.textContent).toContain("50%");

    const accessibilityLabel = status?.getAttribute("aria-label") ?? "";
    expect(accessibilityLabel).toContain(baseProps.headline);
    expect(accessibilityLabel).toContain("대기 2개, 재시도 증가");
    expect(status?.getAttribute("title")).toBe(accessibilityLabel);
  });

  it("renders as an interactive type=button and fires onClick when provided", async () => {
    const onClick = vi.fn();
    await render(
      <FleetQueueHealthPill
        {...baseProps}
        level="degraded"
        utilizationPercent={87}
        onClick={onClick}
      />,
    );

    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();
    expect(button?.type).toBe("button");
    expect(button?.textContent).toContain("큐 혼잡");
    expect(button?.textContent).toContain("87%");
    expect(button?.getAttribute("aria-label")).toContain(baseProps.headline);
    expect(host.querySelector('[role="status"]')).toBeNull();

    await act(async () => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("clamps utilization percentages to the inclusive 0..100 range", async () => {
    const cases = [
      [-25, "0%"],
      [0, "0%"],
      [55, "55%"],
      [100, "100%"],
      [125, "100%"],
    ] as const;

    for (const [utilizationPercent, expected] of cases) {
      await render(
        <FleetQueueHealthPill {...baseProps} utilizationPercent={utilizationPercent} />,
      );
      expect(host.querySelector('[role="status"]')?.textContent).toContain(expected);
    }
  });
});

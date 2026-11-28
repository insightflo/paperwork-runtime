/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSlotBadge, getSlotUtilizationTone } from "../AgentSlotBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function badge(): HTMLElement {
  const element = host.querySelector<HTMLElement>('[role="status"]');
  expect(element).not.toBeNull();
  return element!;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("getSlotUtilizationTone", () => {
  it("classifies idle, active, saturated, and starving states", () => {
    expect(getSlotUtilizationTone(0, 4)).toBe("idle");
    expect(getSlotUtilizationTone(2, 4)).toBe("active");
    expect(getSlotUtilizationTone(4, 4)).toBe("saturated");
    expect(getSlotUtilizationTone(2, 4, true)).toBe("starving");
  });

  it("treats a non-positive maximum as one available slot", () => {
    expect(getSlotUtilizationTone(1, 0)).toBe("saturated");
  });
});

describe("AgentSlotBadge", () => {
  it("renders the slot ratio and queue backlog with an accessible label", async () => {
    await render(<AgentSlotBadge runningCount={2} maxConcurrentRuns={4} queuedCount={3} />);

    expect(badge().textContent).toContain("슬롯 2/4");
    expect(badge().textContent).toContain("+대기 3");
    expect(badge().getAttribute("aria-label")).toBe("실행 슬롯 2/4, 대기 3건");
    expect(badge().className).toContain("tabular-nums");
  });

  it("omits queue text when the backlog is zero", async () => {
    await render(<AgentSlotBadge runningCount={1} maxConcurrentRuns={4} queuedCount={0} />);

    expect(badge().textContent).toContain("슬롯 1/4");
    expect(badge().textContent).not.toContain("+대기");
    expect(badge().getAttribute("aria-label")).toBe("실행 슬롯 1/4, 대기 0건");
  });

  it("uses one as the displayed maximum when maxConcurrentRuns is non-positive", async () => {
    await render(<AgentSlotBadge runningCount={1} maxConcurrentRuns={0} />);

    expect(badge().textContent).toContain("슬롯 1/1");
    expect(badge().getAttribute("aria-label")).toBe("실행 슬롯 1/1, 대기 0건");
  });
});

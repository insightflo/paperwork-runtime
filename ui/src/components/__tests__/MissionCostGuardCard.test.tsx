/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionCostGuardCard, type MissionCostGuardView } from "../MissionCostGuardCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function makeView(overrides: Partial<MissionCostGuardView> = {}): MissionCostGuardView {
  return {
    missionTitle: "Apollo migration",
    spentUsd: 12.34,
    budgetUsd: 50,
    utilizationPercent: 42,
    burnUsdPerHour: 2.5,
    projectedRunwayMinutes: 120,
    shouldThrottleSlots: false,
    reason: "예산 소진 속도가 안정적입니다.",
    ...overrides,
  };
}

async function renderCard(view: MissionCostGuardView | null | undefined, onThrottleMission?: () => void) {
  await mount(<MissionCostGuardCard view={view} onThrottleMission={onThrottleMission} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("MissionCostGuardCard", () => {
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

  it("renders nothing when the view is empty", async () => {
    await renderCard(null);
    expect(host.innerHTML).toBe("");

    await renderCard(undefined);
    expect(host.innerHTML).toBe("");
  });

  it("renders a normal region without a throttle button", async () => {
    await renderCard(makeView(), vi.fn());

    const card = host.querySelector("[data-testid='mission-cost-guard-card']");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("role")).toBe("region");
    expect(card!.getAttribute("aria-label")).toBe("Apollo migration 예산 가드");
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("$12.34 / $50.00");
    expect(host.textContent).toContain("42%");
    expect(host.textContent).toContain("$2.50/시간");
    expect(host.textContent).toContain("잔여 120분");
    expect(host.textContent).toContain("예산 소진 속도가 안정적입니다.");
  });

  it("renders an alert with a throttle button that invokes the callback", async () => {
    const onThrottleMission = vi.fn();
    await renderCard(
      makeView({
        shouldThrottleSlots: true,
        projectedRunwayMinutes: null,
        reason: "시간당 소진 속도가 예산 대비 높습니다.",
      }),
      onThrottleMission,
    );

    const card = host.querySelector("[data-testid='mission-cost-guard-card']");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("role")).toBe("alert");
    expect(host.textContent).toContain("시간당 소진 속도가 예산 대비 높습니다.");
    expect(host.textContent).not.toContain("예상 잔여 시간");

    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    expect(button!.getAttribute("type")).toBe("button");
    expect(button!.textContent).toContain("슬롯 제한 적용");

    click(button!);
    expect(onThrottleMission).toHaveBeenCalledTimes(1);
  });
});

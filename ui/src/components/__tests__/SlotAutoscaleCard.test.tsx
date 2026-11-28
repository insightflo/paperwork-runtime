/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAutoscaleActionLabel,
  SlotAutoscaleCard,
  type SlotAutoscaleAction,
  type SlotAutoscaleRecommendationView,
} from "../SlotAutoscaleCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function recommendation(action: SlotAutoscaleAction): SlotAutoscaleRecommendationView {
  const targetSlots = action === "scale_up" ? 4 : action === "scale_down" ? 1 : 2;
  return {
    action,
    currentSlots: 2,
    targetSlots,
    delta: targetSlots - 2,
    reason: "최근 대기열 길이와 실행 중인 작업 수를 기준으로 계산했습니다.",
  };
}

function applyButton() {
  return host.querySelector<HTMLButtonElement>('button[type="button"]');
}

describe("formatAutoscaleActionLabel", () => {
  it("formats all autoscale actions", () => {
    expect(formatAutoscaleActionLabel("scale_up")).toBe("슬롯 증설 권장");
    expect(formatAutoscaleActionLabel("scale_down")).toBe("슬롯 축소 권장");
    expect(formatAutoscaleActionLabel("hold")).toBe("현재 슬롯 유지");
  });
});

describe("SlotAutoscaleCard", () => {
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

  it("renders nothing when the recommendation is empty", async () => {
    await mount(<SlotAutoscaleCard recommendation={null} />);
    expect(host.childNodes).toHaveLength(0);

    await mount(<SlotAutoscaleCard recommendation={undefined} />);
    expect(host.childNodes).toHaveLength(0);
  });

  it("renders the region label, slot transition, and reason", async () => {
    await mount(<SlotAutoscaleCard recommendation={recommendation("scale_up")} />);

    const card = host.querySelector('[data-testid="slot-autoscale-card"]');
    expect(card?.getAttribute("role")).toBe("region");
    expect(card?.getAttribute("aria-label")).toBe("슬롯 자동 조정 권고");
    expect(host.textContent).toContain("슬롯 증설 권장");
    expect(host.textContent).toContain("2 → 4");
    expect(host.textContent).toContain("최근 대기열 길이와 실행 중인 작업 수를 기준으로 계산했습니다.");
  });

  it("omits the apply button on hold even when a handler is provided", async () => {
    await mount(
      <SlotAutoscaleCard recommendation={recommendation("hold")} onApplyTargetSlots={vi.fn()} />,
    );

    expect(applyButton()).toBeNull();
  });

  it.each(["scale_up", "scale_down"] as const)("renders the apply button for %s", async (action) => {
    await mount(
      <SlotAutoscaleCard recommendation={recommendation(action)} onApplyTargetSlots={vi.fn()} />,
    );

    expect(applyButton()?.textContent).toBe("목표 슬롯 적용");
  });

  it("fires the apply handler with the target slots on click", async () => {
    const onApplyTargetSlots = vi.fn();
    await mount(
      <SlotAutoscaleCard recommendation={recommendation("scale_up")} onApplyTargetSlots={onApplyTargetSlots} />,
    );

    act(() => {
      applyButton()?.click();
    });

    expect(onApplyTargetSlots).toHaveBeenCalledTimes(1);
    expect(onApplyTargetSlots).toHaveBeenCalledWith(4);
  });
});

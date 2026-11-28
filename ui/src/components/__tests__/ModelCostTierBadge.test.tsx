/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatModelCostTierLabel,
  ModelCostTierBadge,
  type ModelCostTierBadgeProps,
} from "../ModelCostTierBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function renderBadge(props: ModelCostTierBadgeProps) {
  await act(async () => {
    root.render(<ModelCostTierBadge {...props} />);
  });
}

function statusPill(): HTMLElement {
  const pill = host.querySelector<HTMLElement>("[role='status']");
  expect(pill, "role=status pill").toBeTruthy();
  return pill!;
}

describe("formatModelCostTierLabel", () => {
  it("formats every model cost tier", () => {
    expect(formatModelCostTierLabel("economy")).toBe("절약형");
    expect(formatModelCostTierLabel("balanced")).toBe("균형형");
    expect(formatModelCostTierLabel("frontier")).toBe("고성능");
  });
});

describe("ModelCostTierBadge", () => {
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

  it("renders the tier and selected model without the budget tag by default", async () => {
    await renderBadge({ tier: "balanced", selectedModel: "gpt-5.2" });

    const pill = statusPill();
    expect(pill.textContent).toContain("균형형");
    expect(pill.textContent).toContain("gpt-5.2");
    expect(pill.textContent).not.toContain("예산 전환");
    expect(pill.getAttribute("aria-label")).toBe("모델 비용 등급 균형형, 선택 모델 gpt-5.2");
  });

  it("omits the budget tag when downgradedForBudget is false", async () => {
    await renderBadge({
      tier: "frontier",
      selectedModel: "claude-opus-4.5",
      downgradedForBudget: false,
    });

    const pill = statusPill();
    expect(pill.textContent).toContain("고성능");
    expect(pill.textContent).toContain("claude-opus-4.5");
    expect(pill.textContent).not.toContain("예산 전환");
    expect(pill.getAttribute("aria-label")).not.toContain("예산 보호 전환");
  });

  it("renders the budget tag and updated aria-label when downgraded for budget", async () => {
    await renderBadge({
      tier: "economy",
      selectedModel: "gpt-5.2-mini",
      downgradedForBudget: true,
    });

    const pill = statusPill();
    expect(pill.textContent).toContain("절약형");
    expect(pill.textContent).toContain("gpt-5.2-mini");
    expect(pill.textContent).toContain("예산 전환");
    expect(pill.getAttribute("aria-label")).toBe(
      "모델 비용 등급 절약형, 선택 모델 gpt-5.2-mini, 예산 보호 전환",
    );
  });
});

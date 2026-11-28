// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRemediationActionLabel,
  QueueRemediationStrip,
  type QueueRemediationItem,
} from "../QueueRemediationStrip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function remediationItem(overrides: Partial<QueueRemediationItem> = {}): QueueRemediationItem {
  return {
    agentId: "agent-1",
    agentName: "에이전트 1",
    action: "recommend_slot_increase",
    suggestedSlots: 3,
    reason: "대기 중인 실행이 동시 슬롯 수를 초과했습니다.",
    ...overrides,
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

describe("formatRemediationActionLabel", () => {
  it("formats every remediation action type", () => {
    expect(formatRemediationActionLabel("recommend_slot_increase", 4)).toBe("슬롯 4개 증설 권장");
    expect(formatRemediationActionLabel("recommend_slot_increase")).toBe("슬롯 증설 권장");
    expect(formatRemediationActionLabel("promote_aged_run")).toBe("장기 대기 우선 승격");
    expect(formatRemediationActionLabel("provider_cooldown_wait")).toBe("프로바이더 쿨다운 대기");
    expect(formatRemediationActionLabel("none")).toBe("정상");
  });
});

describe("QueueRemediationStrip", () => {
  it("returns null when only none actions exist", async () => {
    await mount(
      <QueueRemediationStrip
        items={[
          remediationItem({ action: "none", agentId: "agent-none-1", reason: "정상 범위입니다." }),
          remediationItem({ action: "none", agentId: "agent-none-2", reason: "대기열이 비어 있습니다." }),
        ]}
      />,
    );
    expect(host!.innerHTML).toBe("");
  });

  it("renders actionable recommendations and filters none actions", async () => {
    await mount(
      <QueueRemediationStrip
        items={[
          remediationItem({ action: "none", agentId: "agent-normal", agentName: "정상 에이전트" }),
          remediationItem({ agentId: "agent-slots", agentName: "슬롯 에이전트" }),
          remediationItem({
            agentId: "agent-cooldown",
            agentName: "쿨다운 에이전트",
            action: "provider_cooldown_wait",
            reason: "프로바이더 쿨다운이 아직 남아 있습니다.",
          }),
        ]}
      />,
    );

    const region = host!.querySelector('[data-testid="queue-remediation-strip"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe("큐 기아 해소 권고");
    expect(region?.className).toContain("tabular-nums");
    expect(host!.textContent).toContain("2건");
    expect(host!.textContent).toContain("슬롯 에이전트");
    expect(host!.textContent).toContain("슬롯 3개 증설 권장");
    expect(host!.textContent).toContain("쿨다운 에이전트");
    expect(host!.textContent).toContain("프로바이더 쿨다운 대기");
    expect(host!.textContent).toContain("프로바이더 쿨다운이 아직 남아 있습니다.");
    expect(host!.textContent).not.toContain("정상 에이전트");
  });

  it("caps the display at 5 items and summarizes the remainder", async () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      remediationItem({
        agentId: `agent-${index + 1}`,
        agentName: `에이전트 ${index + 1}`,
        action: index % 2 === 0 ? "recommend_slot_increase" : "promote_aged_run",
      }),
    );

    await mount(<QueueRemediationStrip items={items} />);

    expect(host!.querySelectorAll("li")).toHaveLength(5);
    expect(host!.textContent).toContain("+2건 더 있음");
    expect(host!.textContent).toContain("에이전트 5");
    expect(host!.textContent).not.toContain("에이전트 6");
    expect(host!.textContent).not.toContain("에이전트 7");
  });

  it("invokes onOpenAgent with the exact agent id when clicked", async () => {
    const onOpenAgent = vi.fn();
    await mount(
      <QueueRemediationStrip
        items={[remediationItem({ agentId: "agent-exact-id", agentName: "열기 대상" })]}
        onOpenAgent={onOpenAgent}
      />,
    );

    const button = host!.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("type")).toBe("button");
    await act(async () => {
      button!.click();
    });

    expect(onOpenAgent).toHaveBeenCalledTimes(1);
    expect(onOpenAgent).toHaveBeenCalledWith("agent-exact-id");
  });
});

/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FleetSlotRebalanceTable,
  type FleetSlotRebalanceRow,
  type FleetSlotRebalanceTableProps,
} from "../FleetSlotRebalanceTable";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

function row(overrides: Partial<FleetSlotRebalanceRow> = {}): FleetSlotRebalanceRow {
  return {
    agentId: "agent-1",
    currentSlots: 2,
    recommendedSlots: 3,
    delta: 1,
    ...overrides,
  };
}

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderTable(
  rows: readonly FleetSlotRebalanceRow[],
  onApplyAll?: FleetSlotRebalanceTableProps["onApplyAll"],
) {
  await mount(<FleetSlotRebalanceTable rows={rows} onApplyAll={onApplyAll} />);
}

describe("FleetSlotRebalanceTable", () => {
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
  });

  it("renders null when rows are empty", async () => {
    await renderTable([]);

    expect(host.innerHTML).toBe("");
  });

  it("renders the region and formatted positive, negative, and unchanged deltas", async () => {
    await renderTable([
      row({ agentId: "agent-a", agentName: "Alpha", currentSlots: 2, recommendedSlots: 4, delta: 2 }),
      row({ agentId: "agent-b", agentName: "Beta", currentSlots: 3, recommendedSlots: 2, delta: -1 }),
      row({ agentId: "agent-c", agentName: "Gamma", currentSlots: 2, recommendedSlots: 2, delta: 0 }),
    ]);

    expect(host.querySelector('[role="region"][aria-label="플리트 슬롯 재배분 제안"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="fleet-slot-rebalance-table"]')).not.toBeNull();
    expect(host.textContent).toContain("Alpha");
    expect(host.textContent).toContain("Beta");
    expect(host.textContent).toContain("Gamma");
    expect(host.textContent).toContain("+2");
    expect(host.textContent).toContain("-1");
    expect(host.textContent).toContain("유지");
    expect(host.querySelectorAll("td.tabular-nums")).toHaveLength(9);
  });

  it("hides the apply button when every delta is zero", async () => {
    await renderTable(
      [row({ agentId: "agent-a", recommendedSlots: 2, delta: 0 })],
      vi.fn(),
    );

    expect(host.querySelector("button")).toBeNull();
  });

  it("calls onApplyAll with only changed rows when the apply button is clicked", async () => {
    const onApplyAll = vi.fn();
    const increased = row({ agentId: "agent-a", currentSlots: 2, recommendedSlots: 4, delta: 2 });
    const unchanged = row({ agentId: "agent-b", currentSlots: 2, recommendedSlots: 2, delta: 0 });
    const decreased = row({ agentId: "agent-c", currentSlots: 4, recommendedSlots: 2, delta: -2 });
    await renderTable([increased, unchanged, decreased], onApplyAll);

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("type")).toBe("button");
    expect(button!.textContent).toContain("변경 2건 일괄 적용");
    await act(async () => {
      button!.click();
    });

    expect(onApplyAll).toHaveBeenCalledTimes(1);
    expect(onApplyAll).toHaveBeenCalledWith([increased, decreased]);
  });
});

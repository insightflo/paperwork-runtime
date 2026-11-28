/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDeadlockCycleChain,
  QueueDeadlockAlert,
  type DeadlockCycleView,
} from "../QueueDeadlockAlert";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function cycle(overrides: Partial<DeadlockCycleView> = {}): DeadlockCycleView {
  return {
    nodes: ["agent-a", "agent-b"],
    recommendedBreakTarget: {
      waiterId: "agent-a",
      targetId: "agent-b",
      runId: "run-1",
      waitedMs: 1500,
    },
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

describe("formatDeadlockCycleChain", () => {
  it("formats a one-node self-loop", () => {
    expect(formatDeadlockCycleChain(["A"])).toBe("A → A");
  });

  it("formats a multi-node cycle by returning to the first node", () => {
    expect(formatDeadlockCycleChain(["A", "B", "C"])).toBe("A → B → C → A");
  });
});

describe("QueueDeadlockAlert", () => {
  it("returns empty DOM when cycles is empty", async () => {
    await mount(<QueueDeadlockAlert cycles={[]} />);

    expect(host!.innerHTML).toBe("");
  });

  it("renders the alert, cycle chain, and recommended break target", async () => {
    await mount(<QueueDeadlockAlert cycles={[cycle()]} />);

    const alert = host!.querySelector('[data-testid="queue-deadlock-alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.getAttribute("role")).toBe("alert");
    expect(host!.textContent).toContain("순환 대기 감지 1건");
    expect(host!.textContent).toContain("agent-a → agent-b → agent-a");
    expect(host!.textContent).toContain("권장 해제 대상");
    expect(host!.textContent).toContain("agent-a → agent-b");
  });

  it("fires onInspectRun with the recommended target run id on button click", async () => {
    const onInspectRun = vi.fn();
    await mount(<QueueDeadlockAlert cycles={[cycle()]} onInspectRun={onInspectRun} />);

    const button = host!.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("type")).toBe("button");

    await act(async () => {
      button!.click();
    });

    expect(onInspectRun).toHaveBeenCalledTimes(1);
    expect(onInspectRun).toHaveBeenCalledWith("run-1");
  });
});

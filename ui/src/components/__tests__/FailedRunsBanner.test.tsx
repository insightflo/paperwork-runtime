/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailedRunsBanner, type FailedRunAlertItem } from "../FailedRunsBanner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function run(overrides: Partial<FailedRunAlertItem> = {}): FailedRunAlertItem {
  return {
    runId: "run-1",
    agentId: "agent-1",
    agentName: "Agent Alpha",
    status: "failed",
    title: "Failed mission run",
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

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

function buttons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button"));
}

describe("FailedRunsBanner", () => {
  it("returns null when runs is empty", async () => {
    await mount(<FailedRunsBanner runs={[]} />);
    expect(host.innerHTML).toBe("");
  });

  it("renders role=alert with the count, up to 3 newest runs, and the overflow note", async () => {
    const oldest = run({ runId: "run-old", title: "Oldest failure", finishedAt: "2026-01-01T00:00:00.000Z" });
    const middle = run({ runId: "run-middle", title: "Middle failure", status: "timed_out", finishedAt: "2026-01-03T00:00:00.000Z" });
    const newest = run({ runId: "run-new", title: "Newest failure", finishedAt: "2026-01-04T00:00:00.000Z" });
    const older = run({ runId: "run-older", title: "Older failure", finishedAt: "2026-01-02T00:00:00.000Z" });

    await mount(<FailedRunsBanner runs={[oldest, middle, newest, older]} />);

    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("4 failed or timed-out runs");
    expect(alert!.textContent).toContain("+1 more");

    const renderedButtons = buttons();
    expect(renderedButtons).toHaveLength(3);
    expect(renderedButtons.every((button) => button.type === "button")).toBe(true);
    expect(renderedButtons[0].textContent).toContain("Newest failure");
    expect(renderedButtons[1].textContent).toContain("Middle failure");
    expect(renderedButtons[2].textContent).toContain("Older failure");
    expect(alert!.textContent).toContain("timed out");
    expect(alert!.textContent).not.toContain("Oldest failure");
  });

  it("calls onOpenRun with the clicked run object", async () => {
    const first = run({ runId: "run-first", title: "First failure" });
    const second = run({ runId: "run-second", title: "Second failure", agentName: "Agent Beta" });
    const onOpenRun = vi.fn();
    await mount(<FailedRunsBanner runs={[first, second]} onOpenRun={onOpenRun} />);

    const target = buttons().find((button) => button.textContent?.includes("Second failure"));
    expect(target).toBeTruthy();
    await act(async () => {
      target!.click();
    });

    expect(onOpenRun).toHaveBeenCalledTimes(1);
    expect(onOpenRun).toHaveBeenCalledWith(second);
  });
});

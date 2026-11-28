/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExceptionHuddleTimeoutBanner, type TimedOutHuddleAlertItem } from "../ExceptionHuddleTimeoutBanner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function item(overrides: Partial<TimedOutHuddleAlertItem> = {}): TimedOutHuddleAlertItem {
  return {
    threadId: "thread-1",
    channelId: "channel-1",
    title: "Release evidence mismatch",
    round: 2,
    maxRounds: 3,
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

function buttonByText(text: string): HTMLButtonElement {
  const button = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(text));
  expect(button, `${text} button`).toBeTruthy();
  return button!;
}

describe("ExceptionHuddleTimeoutBanner", () => {
  it("returns empty DOM when items is empty", async () => {
    await mount(<ExceptionHuddleTimeoutBanner items={[]} />);

    expect(host!.innerHTML).toBe("");
  });

  it("renders an assertive alert with the singular count, first title, round, and a typed primary button", async () => {
    await mount(<ExceptionHuddleTimeoutBanner items={[item()]} />);

    const alert = host!.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.getAttribute("aria-live")).toBe("assertive");
    expect(host!.textContent).toContain("1 timed-out huddle requires Chair decision");
    expect(host!.textContent).toContain("Release evidence mismatch");
    expect(host!.textContent).toContain("R2/3");

    const openButton = buttonByText("의장 결정 열기 / Open Chair Decision");
    expect(openButton.getAttribute("type")).toBe("button");
    expect([...host!.querySelectorAll("button")].some((button) => button.textContent?.includes("Dismiss"))).toBe(false);
  });

  it("renders the plural count for multiple timed-out huddles while featuring only the first huddle", async () => {
    await mount(
      <ExceptionHuddleTimeoutBanner
        items={[
          item(),
          item({ threadId: "thread-2", channelId: "channel-2", title: "Validator quorum expired" }),
        ]}
      />,
    );

    expect(host!.textContent).toContain("2 timed-out huddles require Chair decision");
    expect(host!.textContent).toContain("Release evidence mismatch");
    expect(host!.textContent).not.toContain("Validator quorum expired");
  });

  it("clicking Open Chair Decision invokes onOpenHuddle with items[0]", async () => {
    const items = [
      item(),
      item({ threadId: "thread-2", channelId: "channel-2", title: "Validator quorum expired" }),
    ];
    const onOpenHuddle = vi.fn();
    await mount(<ExceptionHuddleTimeoutBanner items={items} onOpenHuddle={onOpenHuddle} />);

    await act(async () => {
      buttonByText("의장 결정 열기 / Open Chair Decision").click();
    });

    expect(onOpenHuddle).toHaveBeenCalledTimes(1);
    expect(onOpenHuddle).toHaveBeenCalledWith(items[0]!);
  });

  it("clicking Dismiss invokes onDismiss", async () => {
    const onDismiss = vi.fn();
    await mount(<ExceptionHuddleTimeoutBanner items={[item()]} onDismiss={onDismiss} />);

    const dismissButton = buttonByText("Dismiss");
    expect(dismissButton.getAttribute("type")).toBe("button");
    await act(async () => {
      dismissButton.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

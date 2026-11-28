/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionExceptionHuddleDrawer } from "../MissionExceptionHuddleDrawer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type DrawerProps = Parameters<typeof MissionExceptionHuddleDrawer>[0];

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderDrawer({ open = true, onClose = vi.fn(), ...props }: Partial<DrawerProps> = {}) {
  await mount(<MissionExceptionHuddleDrawer open={open} onClose={onClose} {...props} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function dialog() {
  const element = host.querySelector<HTMLElement>('[role="dialog"]');
  expect(element, "dialog").toBeTruthy();
  return element!;
}

function closeButton() {
  const element = host.querySelector<HTMLButtonElement>('button[aria-label="닫기"]');
  expect(element, "close button").toBeTruthy();
  return element!;
}

function tabByText(text: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent?.includes(text));
  expect(element, `${text} tab`).toBeTruthy();
  return element!;
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("MissionExceptionHuddleDrawer", () => {
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

  it("returns null when open is false", async () => {
    await renderDrawer({ open: false });

    expect(host.innerHTML).toBe("");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders an accessible dialog with timeout, telemetry, and the default history tab", async () => {
    await renderDrawer({
      missionTitle: "Mission Alpha",
      timeoutBannerSlot: <div>Timeout banner slot</div>,
      telemetrySlot: <div>Telemetry slot</div>,
      historySlot: <div>History slot</div>,
      auditSlot: <div>Audit slot</div>,
    });

    const drawer = dialog();
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    const labelledBy = drawer.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Mission Alpha");

    const close = closeButton();
    expect(close.getAttribute("type")).toBe("button");

    const tablist = host.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabs = [...(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab.getAttribute("type")).toBe("button");
      expect(tab.getAttribute("aria-selected")).toBeTruthy();
    }
    expect(tabByText("이력 / History").getAttribute("aria-selected")).toBe("true");
    expect(tabByText("감사 기록 / Audit").getAttribute("aria-selected")).toBe("false");

    expect(host.textContent).toContain("Timeout banner slot");
    expect(host.textContent).toContain("Telemetry slot");
    expect(host.textContent).toContain("History slot");
    expect(host.textContent).not.toContain("Audit slot");
  });

  it("uses the default title when missionTitle is absent", async () => {
    await renderDrawer();

    const labelledBy = dialog().getAttribute("aria-labelledby");
    expect(document.getElementById(labelledBy!)?.textContent).toBe("예외 허들 / Exception Huddles");
  });

  it("switches between historySlot and auditSlot with the tab buttons", async () => {
    await renderDrawer({
      historySlot: <div>History slot</div>,
      auditSlot: <div>Audit slot</div>,
    });

    click(tabByText("감사 기록 / Audit"));
    expect(tabByText("감사 기록 / Audit").getAttribute("aria-selected")).toBe("true");
    expect(tabByText("이력 / History").getAttribute("aria-selected")).toBe("false");
    expect(host.textContent).toContain("Audit slot");
    expect(host.textContent).not.toContain("History slot");

    click(tabByText("이력 / History"));
    expect(tabByText("이력 / History").getAttribute("aria-selected")).toBe("true");
    expect(tabByText("감사 기록 / Audit").getAttribute("aria-selected")).toBe("false");
    expect(host.textContent).toContain("History slot");
    expect(host.textContent).not.toContain("Audit slot");
  });

  it("honors initialTab=audit", async () => {
    await renderDrawer({
      initialTab: "audit",
      historySlot: <div>History slot</div>,
      auditSlot: <div>Audit slot</div>,
    });

    expect(tabByText("감사 기록 / Audit").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("Audit slot");
    expect(host.textContent).not.toContain("History slot");
  });

  it("invokes onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    await renderDrawer({ onClose });

    click(closeButton());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose on Escape and removes the keydown listener when closed", async () => {
    const onClose = vi.fn();
    await renderDrawer({ onClose });

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);

    await renderDrawer({ open: false, onClose });
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

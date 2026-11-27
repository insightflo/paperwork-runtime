// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickStartChecklist } from "./QuickStartChecklist";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const dismissalKey = "paperwork.quickstart.dismissed";
const cleanups: Array<() => Promise<void>> = [];
const empty = { hasAgent: false, hasChannel: false, hasEndpointBot: false };

async function mount(props: Partial<ComponentProps<typeof QuickStartChecklist>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<QuickStartChecklist {...empty} {...props} />));
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return container;
}

async function click(button: Element | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("QuickStartChecklist", () => {
  it("shows progress, exact Korean steps, and completed versus incomplete states", async () => {
    const container = await mount({ hasAgent: true });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 3 완료");
    const steps = container.querySelectorAll("li");
    expect(steps).toHaveLength(3);
    expect(steps[0].textContent).toContain("① 첫 에이전트 만들기");
    expect(steps[0].querySelector('[aria-label="완료"]')?.textContent).toBe("✓");
    expect(steps[0].querySelector("button")).toBeNull();
    expect(steps[1].textContent).toContain("② 협업 채널에서 @멘션으로 일 시키기");
    expect(steps[2].textContent).toContain("③ 내 PC 개인 단말 봇 연결하기 (선택)");
    for (const step of [steps[1], steps[2]]) {
      expect(step.querySelector('[aria-label="완료"]')).toBeNull();
      expect(step.querySelectorAll("button")).toHaveLength(1);
    }
    expect(container.textContent).not.toMatch(/paperclip/i);
  });

  it.each(["/agents", "/channels", "/enterprise-bots"])("navigates exactly to %s", async (path) => {
    const onNavigate = vi.fn();
    const container = await mount({ onNavigate });
    const index = ["/agents", "/channels", "/enterprise-bots"].indexOf(path);
    await click(container.querySelectorAll("li button")[index]);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("dismisses immediately, persists 1, and stays hidden on remount", async () => {
    const container = await mount();
    await click(container.querySelector('button[aria-label="닫기"]'));
    expect(container.childElementCount).toBe(0);
    expect(localStorage.getItem(dismissalKey)).toBe("1");
    await cleanups.pop()!();
    expect((await mount()).childElementCount).toBe(0);
  });

  it("starts hidden when already dismissed", async () => {
    localStorage.setItem(dismissalKey, "1");
    expect((await mount()).childElementCount).toBe(0);
  });

  it("uses a custom dismissal key independently of the default", async () => {
    localStorage.setItem(dismissalKey, "1");
    const container = await mount({ storageKey: "paperwork.test.quickstart.dismissed" });
    expect(container.querySelector("section")).not.toBeNull();
    await click(container.querySelector('button[aria-label="닫기"]'));
    expect(localStorage.getItem("paperwork.test.quickstart.dismissed")).toBe("1");
    expect((await mount({ storageKey: "paperwork.test.quickstart.dismissed" })).childElementCount).toBe(0);
  });

  it("shows full progress without step actions when everything is complete", async () => {
    const container = await mount({ hasAgent: true, hasChannel: true, hasEndpointBot: true });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("3 / 3 완료");
    expect(container.querySelectorAll('li [aria-label="완료"]')).toHaveLength(3);
    expect(container.querySelectorAll("li button")).toHaveLength(0);
  });

  it("works without a navigation callback or available storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("restricted"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("restricted"); });
    const container = await mount();
    await click(container.querySelector("li button"));
    await click(container.querySelector('button[aria-label="닫기"]'));
    expect(container.childElementCount).toBe(0);
  });
});

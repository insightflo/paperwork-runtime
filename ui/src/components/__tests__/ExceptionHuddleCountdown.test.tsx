/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExceptionHuddleCountdown, formatHuddleRemainingMs } from "../ExceptionHuddleCountdown";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const timeoutAt = "2026-03-01T12:05:00.000Z";
const timeoutMs = Date.parse(timeoutAt);

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderCountdown(props: Partial<Parameters<typeof ExceptionHuddleCountdown>[0]> = {}) {
  await mount(<ExceptionHuddleCountdown timeoutAt={timeoutAt} status="open" {...props} />);
}

function timer() {
  return host.querySelector<HTMLElement>('[role="timer"]');
}

describe("formatHuddleRemainingMs", () => {
  it("clamps negative values and formats zero, seconds, and minutes as M:SS", () => {
    expect(formatHuddleRemainingMs(-1)).toBe("0:00");
    expect(formatHuddleRemainingMs(0)).toBe("0:00");
    expect(formatHuddleRemainingMs(59_000)).toBe("0:59");
    expect(formatHuddleRemainingMs(245_000)).toBe("4:05");
    expect(formatHuddleRemainingMs(300_000)).toBe("5:00");
  });
});

describe("ExceptionHuddleCountdown", () => {
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

  it("returns null for decided and cancelled huddles", async () => {
    await renderCountdown({ status: "decided", nowMs: timeoutMs - 180_000 });
    expect(host.innerHTML).toBe("");
    expect(timer()).toBeNull();

    await renderCountdown({ status: "cancelled", nowMs: timeoutMs - 180_000 });
    expect(host.innerHTML).toBe("");
    expect(timer()).toBeNull();
  });

  it("renders an open normal countdown when more than two minutes remain", async () => {
    await renderCountdown({ nowMs: timeoutMs - 180_000 });

    expect(timer()).toBeTruthy();
    expect(timer()!.textContent).toBe("3:00");
    expect(timer()!.getAttribute("aria-label")).toBe("Huddle time remaining 3:00");
    expect(timer()!.className).toContain("normal");
    expect(timer()!.className).toContain("border-blue-600/30");
  });

  it("renders an open warning countdown when two minutes or less remain", async () => {
    await renderCountdown({ nowMs: timeoutMs - 120_000 });

    expect(timer()!.textContent).toBe("2:00");
    expect(timer()!.className).toContain("warning");
    expect(timer()!.className).toContain("border-amber-600/30");
  });

  it("renders an open critical countdown when one minute or less remains", async () => {
    await renderCountdown({ nowMs: timeoutMs - 60_000 });

    expect(timer()!.textContent).toBe("1:00");
    expect(timer()!.className).toContain("critical");
    expect(timer()!.className).toContain("border-red-600/30");
  });

  it("renders the urgent timeout pill when an open huddle reaches its deadline", async () => {
    await renderCountdown({ nowMs: timeoutMs });

    expect(timer()!.textContent).toBe("0:00 · Timeout");
    expect(timer()!.getAttribute("aria-label")).toBe("Huddle timed out");
    expect(timer()!.className).toContain("critical");
    expect(timer()!.className).toContain("border-red-600/30");
  });

  it("renders the urgent timeout pill for timed_out even when time remains on the clock", async () => {
    await renderCountdown({ status: "timed_out", nowMs: timeoutMs - 180_000 });

    expect(timer()!.textContent).toBe("0:00 · Timeout");
    expect(timer()!.getAttribute("aria-label")).toBe("Huddle timed out");
    expect(timer()!.className).toContain("critical");
  });
});

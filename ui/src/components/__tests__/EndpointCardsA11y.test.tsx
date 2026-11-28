/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityMatrix, type BotCapabilityRule } from "../enterprise-bots/CapabilityMatrix";
import { TerminalPairingBanner } from "../enterprise-bots/TerminalPairingBanner";
import { TerminalTelemetryCard } from "../enterprise-bots/TerminalTelemetryCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement;
const capabilities: BotCapabilityRule[] = [
  { capabilityKey: "docs.search", callableBy: "team", dataScope: "team", requiresApproval: false },
];
const pairing = {
  terminalId: "terminal-1", terminalName: "Test terminal", oneTimeToken: "test-token",
  serverUrl: "https://example.test", onDismiss: vi.fn(),
};

async function render(element: ReactElement) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(element));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
});

describe("Endpoint card accessibility", () => {
  it("keeps icon actions and form fields named, with explicit button types", async () => {
    await render(<CapabilityMatrix capabilities={capabilities} canAdmin onSave={vi.fn()} />);
    const fields = [...container.querySelectorAll("input, select, textarea")];
    expect(fields).toHaveLength(5);
    for (const field of fields) expect(field.getAttribute("aria-label")?.trim()).toBeTruthy();
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove docs.search"]')!;
    expect(remove.textContent?.trim()).toBe("");
    for (const button of container.querySelectorAll("button")) {
      expect(button.getAttribute("type")).toBe(button.textContent?.trim() === "Add" ? "submit" : "button");
    }
    remove.focus();
    expect(document.activeElement).toBe(remove);
    expect(remove.tabIndex).toBe(0);
    await act(async () => remove.click());
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("1 unsaved change");
    expect(container.querySelector('[data-capability-row="docs.search"]')).toBeNull();
  });

  it("announces unsaved changes through an already mounted live region", async () => {
    await render(<CapabilityMatrix capabilities={capabilities} canAdmin onSave={vi.fn()} />);
    const region = container.querySelector('[aria-live="polite"]')!;
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).not.toContain("unsaved");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
    });
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toContain("1 unsaved change");
  });

  it("announces form validation errors", async () => {
    await render(<CapabilityMatrix capabilities={capabilities} canAdmin onSave={vi.fn()} />);
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a capability key.");
  });

  it("announces pairing and copy feedback without including the token in the status region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await render(<TerminalPairingBanner {...pairing} />);
      const status = container.querySelector('[role="status"]')!;
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.textContent).toContain("첫 신호 대기 중");
      expect(status.textContent).not.toContain(pairing.oneTimeToken);
      const close = container.querySelector<HTMLButtonElement>('button[aria-label="연결 안내 닫기"]')!;
      expect(close.getAttribute("type")).toBe("button");
      for (const selector of ["[data-copy-daemon]", "[data-copy-doctor]"]) {
        const copy = container.querySelector<HTMLButtonElement>(selector)!;
        expect(copy.getAttribute("type")).toBe("button");
        expect(copy.getAttribute("aria-live")).toBe("polite");
        await act(async () => copy.click());
        expect(copy.textContent).toContain("복사됨");
      }
      expect(writeText).toHaveBeenCalledTimes(2);
      await render(<TerminalPairingBanner {...pairing} lastSeenAt="2026-11-28T00:00:00Z" />);
      expect(container.querySelector('[role="status"]')).toBe(status);
      expect(status.textContent).toBe("연결됨");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("announces heartbeat changes without replacing the live region", async () => {
    const telemetry = { transport: "outbound_wss", lastHeartbeatAt: "2026-11-28T00:00:00Z" };
    await render(<TerminalTelemetryCard telemetry={telemetry} now="2026-11-28T00:00:15Z" />);
    const status = container.querySelector("[data-heartbeat-badge]")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.textContent).toContain("정상");
    await render(<TerminalTelemetryCard telemetry={telemetry} now="2026-11-28T00:03:00Z" />);
    expect(container.querySelector("[data-heartbeat-badge]")).toBe(status);
    expect(status.textContent).toContain("오프라인");
  });
});

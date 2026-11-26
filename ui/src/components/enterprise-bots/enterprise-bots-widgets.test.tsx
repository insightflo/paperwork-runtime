/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotHealthSparkline, type BotHealthSample } from "./BotHealthSparkline";
import { CapabilityMatrix, type BotCapabilityRule } from "./CapabilityMatrix";
import {
  TerminalPairingBanner,
  buildDaemonPairingSnippet,
  buildDoctorSnippet,
} from "./TerminalPairingBanner";
import { TerminalTelemetryCard } from "./TerminalTelemetryCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
const container = document.createElement("div");

async function render(ui: ReactElement) {
  if (!root) {
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(ui);
  });
}

async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe("TerminalPairingBanner", () => {
  it("renders secret-safe env-var daemon snippet without --token in CLI args and copies daemon + doctor snippets", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onDismiss = vi.fn();

    await render(
      <TerminalPairingBanner
        terminalId="term-01"
        terminalName="maya-macbook"
        oneTimeToken="pcp_term_secret_123"
        serverUrl="https://ops.paperwork.local"
        onDismiss={onDismiss}
      />,
    );

    const snippetEl = container.querySelector("[data-pairing-snippet]")!;
    expect(snippetEl.textContent).toContain("export PAPERWORK_TERMINAL_TOKEN='pcp_term_secret_123'");
    expect(snippetEl.textContent).toContain(
      'paperwork-bot daemon --server "https://ops.paperwork.local" --terminal-id "term-01"',
    );
    expect(snippetEl.textContent).not.toContain("--token");

    const indicator = container.querySelector("[data-heartbeat-indicator]")!;
    expect(indicator.textContent).toContain("Waiting for first heartbeat...");
    expect(
      container.querySelector("[data-terminal-pairing-banner]")?.getAttribute("data-pairing-status"),
    ).toBe("waiting");

    await click(container.querySelector("[data-copy-daemon]"));
    expect(writeText).toHaveBeenCalledWith(
      buildDaemonPairingSnippet("pcp_term_secret_123", "https://ops.paperwork.local", "term-01"),
    );

    await click(container.querySelector("[data-copy-doctor]"));
    expect(writeText).toHaveBeenCalledWith(
      buildDoctorSnippet("https://ops.paperwork.local", "term-01"),
    );

    await click(container.querySelector('button[aria-label="Dismiss pairing banner"]'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("flips status indicator to Connected once lastSeenAt is populated", async () => {
    await render(
      <TerminalPairingBanner
        terminalId="term-01"
        terminalName="maya-macbook"
        oneTimeToken="pcp_term_secret_123"
        serverUrl="https://ops.paperwork.local"
        lastSeenAt="2026-11-26T16:45:00.000Z"
        onDismiss={() => {}}
      />,
    );

    expect(
      container.querySelector("[data-terminal-pairing-banner]")?.getAttribute("data-pairing-status"),
    ).toBe("connected");
    expect(container.querySelector("[data-heartbeat-indicator]")?.textContent).toContain(
      "Connected",
    );
  });
});

describe("BotHealthSparkline", () => {
  it("renders 20 bars with ok/slow/error color coding and accessible tooltips", async () => {
    const samples: BotHealthSample[] = [
      { ts: "2026-11-26T16:40:00Z", ok: true, rttMs: 42, statusCode: 200 },
      { ts: "2026-11-26T16:41:00Z", ok: true, rttMs: 680, statusCode: 200 },
      { ts: "2026-11-26T16:42:00Z", ok: false, rttMs: 1200, statusCode: 503, errorRef: "E_UPSTREAM" },
    ];

    await render(<BotHealthSparkline samples={samples} />);

    const bars = [...container.querySelectorAll("svg[data-health-sparkline] rect")];
    expect(bars).toHaveLength(20);
    expect(bars.filter((b) => b.getAttribute("data-bar-tone") === "empty")).toHaveLength(17);

    const last3 = bars.slice(-3);
    expect(last3.map((b) => b.getAttribute("data-bar-tone"))).toEqual(["ok", "slow", "error"]);
    expect(last3[0]?.getAttribute("fill")).toContain("--openbot-success");
    expect(last3[1]?.getAttribute("fill")).toContain("--openbot-warning");
    expect(last3[2]?.getAttribute("fill")).toContain("--openbot-danger");
    expect(last3[0]?.querySelector("title")?.textContent).toContain("42ms");
    expect(last3[2]?.querySelector("title")?.textContent).toContain("ref:E_UPSTREAM");
  });
});

describe("TerminalTelemetryCard", () => {
  const baseNow = "2026-11-26T16:45:00.000Z";

  it("renders compact telemetry badges, sparkline, and fresh heartbeat state", async () => {
    await render(
      <TerminalTelemetryCard
        now={baseNow}
        telemetry={{
          transport: "outbound_wss",
          os: "macos",
          arch: "arm64",
          daemonVersion: "v0.4.2",
          rttMs: 23,
          cpuPercent: 4,
          memoryMb: 18,
          lastHeartbeatAt: "2026-11-26T16:44:45.000Z",
          samples: [{ ts: "2026-11-26T16:44:45Z", ok: true, rttMs: 23 }],
        }}
      />,
    );

    expect(container.querySelector('[data-metric="transport"]')?.textContent).toContain("outbound_wss");
    expect(container.querySelector('[data-metric="os-arch"]')?.textContent).toContain("macos/arm64");
    expect(container.querySelector('[data-metric="version"]')?.textContent).toContain("v0.4.2");
    expect(container.querySelector('[data-metric="rtt"]')?.textContent).toContain("23ms");
    expect(container.querySelector('[data-metric="cpu-mem"]')?.textContent).toContain("4% · 18MB");
    const hb = container.querySelector("[data-heartbeat-badge]")!;
    expect(hb.getAttribute("data-heartbeat-state")).toBe("fresh");
    expect(hb.textContent).toContain("15s ago");
    expect(container.querySelectorAll("svg[data-health-sparkline] rect")).toHaveLength(20);
  });

  it("flags >45s heartbeat as stale amber and >120s heartbeat as offline rose", async () => {
    await render(
      <TerminalTelemetryCard
        now={baseNow}
        telemetry={{
          transport: "tailscale_direct",
          lastHeartbeatAt: "2026-11-26T16:43:50.000Z",
        }}
      />,
    );
    expect(container.querySelector("[data-heartbeat-badge]")?.getAttribute("data-heartbeat-state")).toBe("stale");
    expect(container.querySelector("[data-heartbeat-badge]")?.textContent).toContain("stale");

    await render(
      <TerminalTelemetryCard
        now={baseNow}
        telemetry={{
          transport: "tailscale_direct",
          lastHeartbeatAt: "2026-11-26T16:41:00.000Z",
        }}
      />,
    );
    expect(container.querySelector("[data-heartbeat-badge]")?.getAttribute("data-heartbeat-state")).toBe("offline");
    expect(container.querySelector("[data-heartbeat-badge]")?.textContent).toContain("offline");
  });
});

describe("CapabilityMatrix", () => {
  const initialRules: BotCapabilityRule[] = [
    { capabilityKey: "web.search", callableBy: "company", dataScope: "company", requiresApproval: false },
    { capabilityKey: "mail.triage", callableBy: "self_only", dataScope: "self", requiresApproval: true },
  ];

  it("supports inline edits, adding a capability, dirty diff badge, and Save Matrix callback", async () => {
    const onSave = vi.fn();
    await render(<CapabilityMatrix capabilities={initialRules} canAdmin={true} onSave={onSave} />);

    const saveBtn = container.querySelector<HTMLButtonElement>("[data-save-matrix]")!;
    expect(saveBtn.disabled).toBe(true);
    expect(container.querySelector("[data-dirty-badge]")).toBeNull();

    // Edit callableBy on web.search
    const callableSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Callable by for web.search"]',
    )!;
    await setInputValue(callableSelect, "team");

    // Toggle requiresApproval on web.search
    await click(container.querySelector('button[aria-label="Requires approval for web.search"]'));

    // Add a new capability row
    const addInput = container.querySelector<HTMLInputElement>('input[aria-label="New capability key"]')!;
    await setInputValue(addInput, "docs.summarize");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector("[data-dirty-badge]")?.textContent).toContain("2 unsaved changes");
    expect(saveBtn.disabled).toBe(false);

    await click(saveBtn);
    expect(onSave).toHaveBeenCalledWith([
      { capabilityKey: "web.search", callableBy: "team", dataScope: "company", requiresApproval: true },
      { capabilityKey: "mail.triage", callableBy: "self_only", dataScope: "self", requiresApproval: true },
      { capabilityKey: "docs.summarize", callableBy: "team", dataScope: "team", requiresApproval: false },
    ]);
  });

  it("disables controls and Save Matrix when canAdmin is false", async () => {
    const onSave = vi.fn();
    await render(<CapabilityMatrix capabilities={initialRules} canAdmin={false} onSave={onSave} />);

    expect(container.querySelector("[data-readonly-hint]")?.textContent).toContain("Admin only");
    expect(container.querySelector<HTMLButtonElement>("[data-save-matrix]")?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Callable by for web.search"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="New capability key"]')?.disabled,
    ).toBe(true);
  });
});

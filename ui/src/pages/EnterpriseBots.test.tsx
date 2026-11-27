/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnterpriseBots, EXEC_OWNER_ONLY_REASON, execPolicy, type EnterpriseBotsData } from "./EnterpriseBots";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DATA: EnterpriseBotsData = {
  now: "2026-11-26T01:00:00.000Z",
  bots: [
    { id: "b1", name: "Research Copilot", kind: "company", status: "active", callableBy: "company", dataScope: "company", capabilities: ["web.search"], ownerName: "Ops" },
    { id: "b2", name: "Standup Scribe", kind: "team", status: "active", callableBy: "team", dataScope: "team", capabilities: [], ownerName: "Platform" },
    { id: "b3", name: "Inbox Triage", kind: "personal", status: "paused", callableBy: "owner", dataScope: "self", capabilities: [], ownerName: "Maya" },
  ],
  terminals: [
    { id: "t1", name: "maya-macbook", kind: "personal_terminal", status: "online", ownerId: "u-maya", ownerName: "Maya", lastHeartbeatAt: "2026-11-26T00:59:48.000Z" },
    { id: "t2", name: "build-node-01", kind: "worker_node", status: "online", ownerId: "u-ops", ownerName: "Ops", lastHeartbeatAt: "2026-11-26T00:59:30.000Z" },
  ],
  channels: [{ id: "c1", name: "eng-alerts", members: ["Maya", "Dev", "Ops"] }],
  pendingApprovals: [
    { id: "pa1", channelId: "c1", botId: "b3", botName: "Inbox Triage", fromUserName: "Dev", toTerminalId: "t1", toTerminalName: "maya-macbook", toOwnerName: "Maya", action: "run mail.triage on owner terminal", requestedAt: "2026-11-26T00:58:10.000Z" },
  ],
};

let root: Root | null = null;
const container = document.createElement("div");

async function render(ui: ReactElement) {
  if (!root) { document.body.appendChild(container); root = createRoot(container); }
  await act(async () => { root!.render(ui); });
}
async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(name));
const tabButton = (key: string) => container.querySelector<HTMLButtonElement>(`button[data-tab="${key}"]`);
const detail = () => container.querySelector('section[aria-label$="detail"]')!;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe("EnterpriseBots cockpit", () => {
  it("renders the 1-row telemetry strip and 2-axis callableBy × dataScope badges on the Bots tab", async () => {
    await render(<EnterpriseBots initialData={DATA} />);
    const strip = container.querySelector('[aria-label="Enterprise bot telemetry"]')!;
    expect(strip.textContent).toContain("Active Bots");
    expect(strip.textContent).toContain("Online Terminals");
    expect(strip.textContent).toContain("Shared Channels");
    expect(strip.textContent).toContain("Pending Owner Approvals");
    expect([...strip.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["2", "2", "1", "1"]);
    expect(tabButton("bots")?.getAttribute("aria-pressed")).toBe("true");
    expect(tabButton("bots")?.textContent).toContain("커넥터 · 권한");
    const badges = [...container.querySelectorAll('[role="button"] [data-security-badge]')].map((b) => b.textContent);
    expect(badges).toEqual(["company × company", "team × team", "owner × self"]);
    expect(detail().querySelector("[data-security-badge]")?.textContent).toBe("company × company");
    expect(detail().textContent).toContain("Research Copilot");
    expect(detail().textContent).toContain("web.search");
  });

  it("switches tabs through the segmented toolbar and shows the matching detail pane", async () => {
    await render(<EnterpriseBots initialData={DATA} />);
    await click(tabButton("terminals"));
    expect(tabButton("terminals")?.getAttribute("aria-pressed")).toBe("true");
    expect(tabButton("bots")?.getAttribute("aria-pressed")).toBe("false");
    expect(tabButton("terminals")?.textContent).toContain("런타임 노드");
    expect(detail().getAttribute("aria-label")).toBe("런타임 노드 detail");
    expect(container.textContent).toContain("maya-macbook");
    expect(container.textContent).toContain("12s ago");
    await click(tabButton("channels"));
    expect(tabButton("channels")?.textContent).toContain("채널 · 멘션");
    expect(detail().getAttribute("aria-label")).toBe("채널 · 멘션 detail");
    expect(container.textContent).toContain("eng-alerts");
    expect(container.querySelector("[data-security-badge]")).toBeNull();
  });

  it("disables Exec for a non-owner admin on a personal_terminal but keeps Stop and Revoke enabled", async () => {
    await render(<EnterpriseBots initialData={DATA} viewerId="u-admin" viewerRole="admin" />);
    await click(tabButton("terminals"));
    await click(container.querySelector('[data-selected]'));
    const exec = button("Exec")!;
    expect(exec.hasAttribute("disabled")).toBe(true);
    expect(exec.getAttribute("title")).toBe(EXEC_OWNER_ONLY_REASON);
    expect(exec.textContent).toContain("Exec");
    expect(button("Stop")!.hasAttribute("disabled")).toBe(false);
    expect(button("Revoke")!.hasAttribute("disabled")).toBe(false);
    expect(detail().querySelector('[role="note"]')?.textContent).toContain("owner-only");
    // Owner of the personal terminal and shared worker nodes still execute.
    expect(execPolicy(DATA.terminals[0], "u-maya").enabled).toBe(true);
    expect(execPolicy(DATA.terminals[1], "u-admin")).toEqual({ enabled: true, reason: null });
  });

  it("keeps Exec enabled on worker nodes for admins", async () => {
    await render(<EnterpriseBots initialData={DATA} viewerId="u-admin" viewerRole="admin" />);
    await click(tabButton("terminals"));
    const rows = [...container.querySelectorAll('[role="button"]')];
    await click(rows[1]);
    expect(rows[1].getAttribute("data-selected")).toBe("true");
    expect(button("Exec")!.hasAttribute("disabled")).toBe(false);
    expect(detail().querySelector('[role="note"]')).toBeNull();
  });

  it("lists channel members and the pending owner-approval queue for cross-user invocations", async () => {
    const onApprovalDecision = vi.fn();
    await render(<EnterpriseBots initialData={DATA} onApprovalDecision={onApprovalDecision} />);
    await click(tabButton("channels"));
    const pending = container.querySelector("[data-pending-approval='pa1']")!;
    expect(pending.textContent).toContain("Inbox Triage");
    expect(pending.textContent).toContain("Dev");
    expect(pending.textContent).toContain("maya-macbook (Maya)");
    for (const m of ["Maya", "Dev", "Ops"]) expect(detail().textContent).toContain(m);
    await click(button("Approve"));
    expect(onApprovalDecision).toHaveBeenCalledWith("pa1", "approve");
  });

  it("falls back to demo data when nothing is injected and to empty states for empty data", async () => {
    await render(<EnterpriseBots />);
    expect(container.textContent).toContain("Research Copilot");
    expect(button("Register Terminal")).toBeTruthy();
    const empty: EnterpriseBotsData = { bots: [], terminals: [], channels: [], pendingApprovals: [] };
    await render(<EnterpriseBots initialData={empty} />);
    expect(container.textContent).toContain("No bots registered.");
    expect(detail().textContent).toContain("Select a bot");
  });

  it("uses Combo 1 Tactile Cockpit primitives and defaults viewerRole safely to member", async () => {
    await render(<EnterpriseBots initialData={DATA} />);
    expect(container.querySelector(".cockpit-strip")).toBeTruthy();
    expect(container.querySelectorAll(".cockpit-strip .cockpit-cell").length).toBe(4);
    expect(container.querySelector(".cockpit-toolbar.tactile-card")).toBeTruthy();
    expect(container.querySelectorAll(".tactile-card").length).toBeGreaterThanOrEqual(3);
    // Page-owned markup only: components/enterprise-bots/* tokens are Wave 3b scope.
    for (const sel of [".cockpit-strip", ".cockpit-toolbar"]) expect(container.querySelector(sel)!.outerHTML).not.toMatch(/openbot|#a3e635|#2563eb|#60a5fa|lime-/i);
    await click(tabButton("terminals"));
    const dds = [...detail().querySelectorAll("dd")].map((d) => d.textContent?.trim());
    expect(dds).toContain("member");
    expect(dds).not.toContain("admin");
  });

  it("opens 커넥터 연결 dialog, submits bot creation, and shows one-time pcp_bot_ token banner", async () => {
    const onCreateBot = vi.fn().mockResolvedValue({
      bot: {
        id: "b-new",
        name: "Release Assistant",
        kind: "team",
        status: "active",
        callableBy: "team",
        dataScope: "team",
        capabilities: ["deploy.check"],
      },
      inboundToken: "pcp_bot_secret_once_123",
    });

    await render(<EnterpriseBots initialData={DATA} onCreateBot={onCreateBot} />);
    await click(button("커넥터 연결"));

    const dialog = container.querySelector('[role="dialog"][aria-label="커넥터 연결"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/openbot/i);

    const setInputValue = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
      await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    await setInputValue(dialog.querySelector<HTMLInputElement>('input[aria-label="Bot Name"]')!, "Release Assistant");
    await setInputValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="Bot Kind"]')!, "company");
    await setInputValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="Callable By"]')!, "company");
    await setInputValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="Data Scope"]')!, "team");
    await setInputValue(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Webhook URL"]')!,
      "https://bots.example.com/hook",
    );
    await setInputValue(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Capabilities"]')!,
      "deploy.check, logs.read",
    );

    const form = dialog.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Release Assistant",
        kind: "company",
        callableBy: "company",
        dataScope: "team",
        webhookUrl: "https://bots.example.com/hook",
        capabilities: ["deploy.check", "logs.read"],
      }),
    );
    expect(container.querySelector("[data-issued-token]")?.textContent).toBe("pcp_bot_secret_once_123");
  });

  it("opens Register Terminal dialog and shows TerminalPairingBanner with env-var daemon & doctor commands on submit", async () => {
    const onRegisterTerminalSubmit = vi.fn().mockResolvedValue({
      terminal: {
        id: "t-new",
        companyId: "c-1",
        kind: "worker_node",
        name: "gpu-worker-01",
        ownerUserId: null,
        teamId: null,
        botId: null,
        transport: "tailscale_direct",
        status: "offline",
        lastSeenAt: null,
        revokedAt: null,
      },
      token: "pcp_term_once_999",
    });

    await render(<EnterpriseBots initialData={DATA} onRegisterTerminalSubmit={onRegisterTerminalSubmit} />);
    await click(button("Register Terminal"));

    const dialog = container.querySelector('[role="dialog"][aria-label="Register Terminal"]')!;
    expect(dialog).toBeTruthy();

    const nameInput = dialog.querySelector<HTMLInputElement>('input[aria-label="Terminal Name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(nameInput, "gpu-worker-01");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const form = dialog.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onRegisterTerminalSubmit).toHaveBeenCalledWith({
      name: "gpu-worker-01",
      kind: "personal_terminal",
      transport: "outbound_wss",
    });
    const banner = container.querySelector("[data-terminal-pairing-banner]")!;
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-pairing-status")).toBe("waiting");
    const snippet = banner.querySelector("[data-pairing-snippet]")?.textContent ?? "";
    expect(snippet).toContain("export PAPERWORK_TERMINAL_TOKEN='pcp_term_once_999'");
    expect(snippet).toContain('paperwork-bot daemon --server');
    expect(banner.querySelector("[data-doctor-snippet]")?.textContent).toContain("paperwork-bot doctor");
  });

  it("wires Bot Test Ping, Pause, Revoke and Terminal Stop/Revoke live action callbacks", async () => {
    const onPingBot = vi.fn().mockResolvedValue({ ok: true, status: 200, latencyMs: 38 });
    const onUpdateBot = vi.fn().mockResolvedValue(undefined);
    const onDeleteBot = vi.fn().mockResolvedValue(undefined);
    const onCommandTerminal = vi.fn().mockResolvedValue(undefined);

    await render(
      <EnterpriseBots
        initialData={DATA}
        viewerId="u-admin"
        viewerRole="admin"
        onPingBot={onPingBot}
        onUpdateBot={onUpdateBot}
        onDeleteBot={onDeleteBot}
        onCommandTerminal={onCommandTerminal}
      />,
    );

    await click(button("Test Ping"));
    expect(onPingBot).toHaveBeenCalledWith("b1");
    expect(detail().querySelector("[data-ping-result]")?.textContent).toContain("38ms");
    expect(detail().querySelector("[data-health-sparkline]")).toBeTruthy();

    await click(button("Pause"));
    expect(onUpdateBot).toHaveBeenCalledWith("b1", { status: "paused" });

    await click(button("Revoke"));
    expect(onDeleteBot).toHaveBeenCalledWith("b1");

    await click(tabButton("terminals"));
    expect(detail().querySelector("[data-terminal-telemetry-card]")).toBeTruthy();
    expect(detail().querySelector("[data-health-sparkline]")).toBeTruthy();
    await click(button("Stop"));
    expect(onCommandTerminal).toHaveBeenCalledWith("t1", "stop");

    await click(button("Revoke"));
    expect(onCommandTerminal).toHaveBeenCalledWith("t1", "revoke");
  });

  it("wires CapabilityMatrix in BotDetail, ChannelInvokePreview in ChannelDetail, and ApprovalQueueDrawer from telemetry strip", async () => {
    const onUpdateBotCapabilities = vi.fn().mockResolvedValue(undefined);
    const onPreviewChannelInvoke = vi.fn().mockResolvedValue({
      outcome: "allowed",
      forcedFilter: { companyId: "c1" },
      summary: "Allowed under company scope",
    });
    const onApprovalDecision = vi.fn().mockResolvedValue(undefined);

    await render(
      <EnterpriseBots
        initialData={DATA}
        viewerId="u-admin"
        viewerRole="admin"
        onUpdateBotCapabilities={onUpdateBotCapabilities}
        onPreviewChannelInvoke={onPreviewChannelInvoke}
        onApprovalDecision={onApprovalDecision}
        auditEntries={[
          {
            id: "ev-1",
            timestamp: "2026-11-26T00:59:00.000Z",
            actor: "u-maya",
            action: "bot.channel.invoke",
            outcome: "allowed",
            detail: "web.search",
          },
        ]}
      />,
    );

    // 1. CapabilityMatrix in BotDetail
    const matrix = detail().querySelector("[data-capability-matrix]")!;
    expect(matrix).toBeTruthy();
    const approvalSwitch = matrix.querySelector<HTMLButtonElement>('button[aria-label="Requires approval for web.search"]')!;
    await click(approvalSwitch);
    await click(matrix.querySelector<HTMLButtonElement>("[data-save-matrix]")!);
    expect(onUpdateBotCapabilities).toHaveBeenCalledWith("b1", [
      {
        capabilityKey: "web.search",
        callableBy: "company",
        dataScope: "company",
        requiresApproval: true,
      },
    ]);

    // 2. Open ApprovalQueueDrawer from 4th telemetry strip cell while on Bots tab
    const stripCells = [...container.querySelectorAll(".cockpit-strip .cockpit-cell")];
    await click(stripCells[3]);
    const drawer = container.querySelector('[role="dialog"][aria-label="Pending Owner Approvals"]')!;
    expect(drawer).toBeTruthy();
    expect(tabButton("bots")?.getAttribute("aria-pressed")).toBe("true");
    const approveBtn = [...drawer.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Approve");
    await click(approveBtn);
    expect(onApprovalDecision).toHaveBeenCalledWith("pa1", "approve");
    await click(drawer.querySelector('button[aria-label="Close approvals drawer"]'));
    expect(container.querySelector('[role="dialog"][aria-label="Pending Owner Approvals"]')).toBeNull();

    // 3. ChannelInvokePreview + audit timeline in ChannelDetail
    await click(tabButton("channels"));
    const preview = detail().querySelector('[data-channel-invoke-preview="c1"]')!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector('[data-audit-entry="ev-1"]')).toBeTruthy();
    const dryRunBtn = [...preview.querySelectorAll("button")].find((b) => b.textContent?.includes("Run Dry-Run"));
    await click(dryRunBtn);
    expect(onPreviewChannelInvoke).toHaveBeenCalledWith({
      channelId: "c1",
      targetBotId: "b1",
      capabilityKey: "web.search",
      executionTarget: "channel_only",
    });
    expect(preview.querySelector('[data-preview-outcome="allowed"]')).toBeTruthy();
  });
});

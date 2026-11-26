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
    expect(detail().getAttribute("aria-label")).toBe("Client Terminals detail");
    expect(container.textContent).toContain("maya-macbook");
    expect(container.textContent).toContain("12s ago");
    await click(tabButton("channels"));
    expect(detail().getAttribute("aria-label")).toBe("Channels & @mentions detail");
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

    await click(tabButton("terminals"));
    const dds = [...detail().querySelectorAll("dd")].map((d) => d.textContent?.trim());
    expect(dds).toContain("member");
    expect(dds).not.toContain("admin");
  });

  it("opens Attach OpenBot dialog, submits bot creation, and shows one-time pcp_bot_ token banner", async () => {
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
    await click(button("Attach OpenBot"));

    const dialog = container.querySelector('[role="dialog"][aria-label="Attach OpenBot"]')!;
    expect(dialog).toBeTruthy();

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

  it("opens Register Terminal dialog and shows one-time pcp_term_ token banner on submit", async () => {
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
    expect(container.querySelector("[data-issued-token]")?.textContent).toBe("pcp_term_once_999");
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

    await click(button("Pause"));
    expect(onUpdateBot).toHaveBeenCalledWith("b1", { status: "paused" });

    await click(button("Revoke"));
    expect(onDeleteBot).toHaveBeenCalledWith("b1");

    await click(tabButton("terminals"));
    await click(button("Stop"));
    expect(onCommandTerminal).toHaveBeenCalledWith("t1", "stop");

    await click(button("Revoke"));
    expect(onCommandTerminal).toHaveBeenCalledWith("t1", "revoke");
  });
});

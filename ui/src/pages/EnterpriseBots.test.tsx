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
});

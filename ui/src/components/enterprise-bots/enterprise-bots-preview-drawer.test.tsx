/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalQueueDrawer,
  type ApprovalQueueItem,
} from "./ApprovalQueueDrawer";
import {
  ChannelInvokePreview,
  type ChannelAuditEntry,
  type PreviewChannelBot,
} from "./ChannelInvokePreview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BOTS: PreviewChannelBot[] = [
  { id: "b1", name: "Research Copilot", kind: "company", capabilities: ["web.search", "doc.summarize"] },
  { id: "b3", name: "Inbox Triage", kind: "personal", capabilities: ["mail.triage"] },
];

const AUDIT_ENTRIES: ChannelAuditEntry[] = [
  {
    id: "aud-1",
    timestamp: "2026-11-26T00:58:10.000Z",
    actor: "Maya",
    action: "@Research Copilot web.search",
    outcome: "allowed",
    detail: "forcedFilter: owner_user_id = u-maya",
  },
  {
    id: "aud-2",
    timestamp: "2026-11-26T00:59:02.000Z",
    actor: "Dev",
    action: "@Inbox Triage mail.triage",
    outcome: "requires_approval",
    detail: "pending owner approval on maya-macbook",
  },
  {
    id: "aud-3",
    timestamp: "2026-11-26T00:59:45.000Z",
    actor: "Dev",
    action: "terminal.exec maya-macbook",
    outcome: "denied",
    detail: "personal_terminal_exec_denied",
  },
];

const APPROVALS: ApprovalQueueItem[] = [
  {
    id: "pa1",
    channelId: "c1",
    botId: "b3",
    botName: "Inbox Triage",
    fromUserName: "Dev",
    toTerminalId: "t1",
    toTerminalName: "maya-macbook",
    toOwnerName: "Maya",
    toOwnerUserId: "u-maya",
    capabilityKey: "mail.triage",
    action: "run mail.triage on owner terminal",
    requestedAt: "2026-11-26T00:58:10.000Z",
  },
  {
    id: "pa2",
    channelId: "c1",
    botId: "b3",
    botName: "Inbox Triage",
    fromUserName: "Sam",
    toTerminalId: "t2",
    toTerminalName: "sam-laptop",
    toOwnerName: "Sam",
    toOwnerUserId: "u-sam",
    capabilityKey: "calendar.sync",
    action: "sync calendar on owner terminal",
    requestedAt: "2026-11-26T00:55:00.000Z",
  },
];

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

function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe("ChannelInvokePreview", () => {
  it("runs dry-run previews and renders allowed (with forcedFilter), requires_approval, and denied badges", async () => {
    const onPreview = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "allowed",
        forcedFilter: { owner_user_id: "caller" },
      })
      .mockResolvedValueOnce({
        outcome: "requires_approval",
        reasonCode: "cross_user_personal_terminal",
      })
      .mockResolvedValueOnce({
        outcome: "denied",
        reasonCode: "cross_team_secrets_denied",
      });

    await render(
      <ChannelInvokePreview
        channelId="c1"
        channelName="eng-alerts"
        bots={BOTS}
        auditEntries={AUDIT_ENTRIES}
        onPreview={onPreview}
      />,
    );

    const runBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run Dry-Run"),
    );

    // 1) ALLOWED + forcedFilter
    await click(runBtn);
    expect(onPreview).toHaveBeenLastCalledWith({
      channelId: "c1",
      targetBotId: "b1",
      capabilityKey: "web.search",
      executionTarget: "channel_only",
    });
    expect(container.querySelector("[data-preview-outcome='allowed']")?.textContent).toContain("ALLOWED");
    expect(container.querySelector("[data-forced-filter]")?.textContent).toBe("owner_user_id = caller");

    // 2) REQUIRES OWNER APPROVAL + reasonCode
    const targetSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Execution target"]')!;
    await act(async () => {
      setInputValue(targetSelect, "personal_terminal");
    });
    await click(runBtn);
    expect(onPreview).toHaveBeenLastCalledWith({
      channelId: "c1",
      targetBotId: "b1",
      capabilityKey: "web.search",
      executionTarget: "personal_terminal",
    });
    expect(container.querySelector("[data-preview-outcome='requires_approval']")?.textContent).toContain(
      "REQUIRES OWNER APPROVAL",
    );
    expect(container.querySelector("[data-reason-code]")?.textContent).toBe("cross_user_personal_terminal");

    // 3) DENIED + reasonCode
    const capInput = container.querySelector<HTMLInputElement>('input[aria-label="Capability key"]')!;
    await act(async () => {
      setInputValue(capInput, "secrets.read");
    });
    await click(runBtn);
    expect(container.querySelector("[data-preview-outcome='denied']")?.textContent).toContain("DENIED");
    expect(container.querySelector("[data-reason-code]")?.textContent).toBe("cross_team_secrets_denied");
  });

  it("renders the compact Audit Timeline with actor, action, timestamp, and outcome badges", async () => {
    await render(
      <ChannelInvokePreview
        channelId="c1"
        bots={BOTS}
        auditEntries={AUDIT_ENTRIES}
      />,
    );

    const items = [...container.querySelectorAll("[data-audit-entry]")];
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Maya");
    expect(items[0].textContent).toContain("@Research Copilot web.search");
    expect(items[0].querySelector("[data-audit-outcome='allowed']")).toBeTruthy();
    expect(items[1].querySelector("[data-audit-outcome='requires_approval']")).toBeTruthy();
    expect(items[2].querySelector("[data-audit-outcome='denied']")).toBeTruthy();
  });
});

describe("ApprovalQueueDrawer", () => {
  it("renders approval cards, passes optional note on Approve/Deny, and closes on Esc", async () => {
    const onClose = vi.fn();
    const onDecision = vi.fn();
    await render(
      <ApprovalQueueDrawer
        open
        approvals={APPROVALS}
        canAdmin
        now={Date.parse("2026-11-26T01:00:00.000Z")}
        onClose={onClose}
        onDecision={onDecision}
      />,
    );

    const card = container.querySelector("[data-approval-card='pa1']")!;
    expect(card.textContent).toContain("Inbox Triage");
    expect(card.textContent).toContain("Dev");
    expect(card.textContent).toContain("maya-macbook");
    expect(card.textContent).toContain("mail.triage");
    expect(card.textContent).toContain("1m ago");

    const noteInput = card.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(noteInput, "verified with requester");
    });

    // Typing 'a' inside the note input must NOT trigger the keyboard approve shortcut
    await act(async () => {
      noteInput.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(onDecision).not.toHaveBeenCalled();

    const approveBtn = [...card.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Approve"),
    );
    await click(approveBtn);
    expect(onDecision).toHaveBeenCalledWith("pa1", "approve", "verified with requester");

    // Keyboard 'd' outside inputs triggers deny on focused item
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });
    expect(onDecision).toHaveBeenCalledWith("pa1", "deny", "verified with requester");

    // Esc closes the drawer
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("enforces owner/admin permissions per approval card", async () => {
    const onDecision = vi.fn();
    await render(
      <ApprovalQueueDrawer
        open
        approvals={APPROVALS}
        canAdmin={false}
        viewerId="u-maya"
        now={Date.parse("2026-11-26T01:00:00.000Z")}
        onClose={vi.fn()}
        onDecision={onDecision}
      />,
    );

    const ownedCard = container.querySelector("[data-approval-card='pa1']")!;
    const foreignCard = container.querySelector("[data-approval-card='pa2']")!;
    expect(ownedCard.querySelector("[data-permission-locked]")).toBeNull();
    expect(foreignCard.querySelector("[data-permission-locked]")?.textContent).toContain(
      "Owner or admin required",
    );
  });
});

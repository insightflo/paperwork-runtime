// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineEditor } from "../InlineEditor";
import { MissionGovernanceThreadPanel } from "../MissionGovernanceThreadPanel";
import { ExternalAutomationApprovals } from "../ExternalAutomationApprovals";
import { missionsApi } from "../../api/missions";
import { approvalsApi } from "../../api/approvals";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const autosave = vi.hoisted(() => ({ state: "idle" }));
// The shared markdown renderer and approval card are outside this audit's scope.
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("../../hooks/useAutosaveIndicator", () => ({
  useAutosaveIndicator: () => ({
    state: autosave.state, reset: vi.fn(), markDirty: vi.fn(), runSave: vi.fn(),
  }),
}));
vi.mock("../../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/CompanyContext")>()),
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../../api/missions", () => ({ missionsApi: { getGovernanceThread: vi.fn() } }));
vi.mock("../../api/approvals", () => ({
  approvalsApi: { list: vi.fn(), approve: vi.fn(), reject: vi.fn() },
}));
vi.mock("../ApprovalCard", () => ({
  ApprovalCard: ({ onApprove, onReject }: { onApprove: () => void; onReject: () => void }) => (
    <><button type="button" onClick={onApprove}>Approve</button><button type="button" onClick={onReject}>Reject</button></>
  ),
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const approval: Approval = {
  id: "approval-1", companyId: "company-1", type: "external_automation", status: "pending",
  payload: {}, requestedByAgentId: null, requestedByUserId: null, requestedByPluginId: null,
  decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.resetAllMocks();
  autosave.state = "idle";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(missionsApi.getGovernanceThread).mockResolvedValue({
    missionId: "mission-1", companyId: "company-1", events: [],
    summary: { totalEventCount: 0, latestEvents: [], openDecisions: [] },
  });
  vi.mocked(approvalsApi.list).mockResolvedValue([approval]);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  host.remove();
});
async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function key(element: Element, value: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  });
}

describe("Governance panels accessibility (Front-End-Checklist)", () => {
  it.each(["Enter", " "])("opens a named inline input with %j and restores focus on Escape", async (value) => {
    const onSave = vi.fn();
    await render(<InlineEditor as="h1" value="Mission title" placeholder="Mission title" onSave={onSave} />);
    const trigger = host.querySelector<HTMLElement>('[role="button"]')!;
    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("aria-label")).toBe("Edit Mission title");
    expect(host.querySelector("h1")?.contains(trigger)).toBe(true);
    trigger.focus();
    await key(trigger, value);
    const input = host.querySelector("textarea")!;
    expect(input.getAttribute("aria-label")).toBe("Mission title");
    expect(document.activeElement).toBe(input);
    await key(input, "Escape");
    expect(host.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[role="button"]'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps pointer editing and Enter-to-save without submitting a surrounding form", async () => {
    const onSave = vi.fn();
    const onSubmit = vi.fn((event) => event.preventDefault());
    await render(<form onSubmit={onSubmit}><InlineEditor value="Old" onSave={onSave} /></form>);
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    const input = host.querySelector("textarea")!;
    expect(input.getAttribute("aria-label")).toBe("Click to edit...");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "New");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key(input, "Enter");
    expect(onSave).toHaveBeenCalledExactlyOnceWith("New");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('[role="button"]'));
  });

  it.each([
    ["saving", "Autosaving..."], ["saved", "Saved"], ["error", "Could not save"],
  ])("announces the inline editor's %s feedback", async (state, message) => {
    autosave.state = state;
    await render(<InlineEditor multiline value="Description" onSave={vi.fn()} />);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe(message);
  });

  it("announces governance loading and empty results", async () => {
    let resolveThread!: (value: Awaited<ReturnType<typeof missionsApi.getGovernanceThread>>) => void;
    vi.mocked(missionsApi.getGovernanceThread).mockImplementationOnce(() => new Promise((resolve) => { resolveThread = resolve; }));
    await render(<MissionGovernanceThreadPanel missionId="mission-1" />);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("Loading governance thread");
    await act(async () => resolveThread({
      missionId: "mission-1", companyId: "company-1", events: [],
      summary: { totalEventCount: 0, latestEvents: [], openDecisions: [] },
    }));
    await settle();
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("No governance events observed yet.");
  });

  it("announces governance query failures as alerts", async () => {
    vi.mocked(missionsApi.getGovernanceThread).mockRejectedValueOnce(new Error("Thread unavailable"));
    await render(<MissionGovernanceThreadPanel missionId="mission-1" />);
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Thread unavailable");
  });

  it.each(["approve", "reject"] as const)("preserves the external %s failure alert", async (action) => {
    vi.mocked(approvalsApi[action]).mockRejectedValueOnce(new Error("Decision failed"));
    await render(<ExternalAutomationApprovals />);
    await settle();
    await act(async () => {
      host.querySelectorAll("button")[action === "approve" ? 0 : 1]!.click();
    });
    await settle();
    expect(approvalsApi[action]).toHaveBeenCalledExactlyOnceWith("approval-1");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Decision failed");
  });
});

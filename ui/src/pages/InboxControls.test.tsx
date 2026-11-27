/** @vitest-environment jsdom */
// Inbox controls: inline Retry on failed-run triage rows (RBAC-gated, no row
// selection) and the telemetry strip as interactive filter buttons with
// aria-pressed toggling that never zeroes the sibling counts.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import { agentsApi } from "../api/agents";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = {
  canWrite: true,
  canAdmin: true,
  pathname: "/inbox/all",
  attentionItems: [
    { runId: "run-1", agentId: "agent-1", status: "failed", issueId: "issue-1", createdAt: "2026-01-01T00:00:00Z", error: "boom", errorCode: "E_RUN" },
  ],
  liveIssueIds: new Set<string>(["issue-1"]),
};
const ISSUE = { id: "issue-1", identifier: "TST-1", title: "Issue A", status: "in_progress", priority: "high", updatedAt: "2026-01-01T02:00:00Z", lastExternalCommentAt: "2026-01-01T02:00:00Z", isUnreadForMe: false, assigneeAgentId: "agent-1", description: null, project: null };
const APPROVAL = { id: "appr-1", companyId: "company-1", type: "mission_plan", payload: {}, status: "pending", createdAt: "2026-01-01T03:00:00Z", updatedAt: "2026-01-01T03:00:00Z", requestedByAgentId: "agent-1", requestedByUserId: null, requestedByPluginId: null, decidedAt: null, decisionNote: null };
const navigateSpy = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateSpy,
  useLocation: () => ({ pathname: state.pathname, search: "", hash: "" }),
}));
vi.mock("../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/CompanyContext")>()),
  useCompany: () => ({ selectedCompanyId: "company-1", canWrite: state.canWrite, canAdmin: state.canAdmin }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/approvals", () => ({
  approvalsApi: { list: vi.fn(async () => [APPROVAL]), approve: vi.fn(), reject: vi.fn() },
}));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []), wakeup: vi.fn(async () => ({ id: "run-2", agentId: "agent-1", status: "queued" })) },
}));
vi.mock("../api/access", () => ({
  accessApi: { listJoinRequests: vi.fn(async () => []), approveJoinRequest: vi.fn(), rejectJoinRequest: vi.fn() },
}));
vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: vi.fn(async () => ({ agents: { error: 0 }, costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 } })) },
}));
vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  issuesApi: { list: vi.fn(async () => [ISSUE]), markRead: vi.fn(async () => undefined) },
}));
vi.mock("../hooks/useInboxHeartbeatData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useInboxHeartbeatData")>()),
  useInboxHeartbeatData: () => ({
    isLoading: false,
    attentionItems: state.attentionItems,
    liveRuns: [],
    liveIssueIds: state.liveIssueIds,
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
  }),
}));
vi.mock("../components/ApprovalPayload", () => ({
  ApprovalPayloadRenderer: () => null,
  approvalLabel: (type: string) => type,
}));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div data-tabs-root>{children}</div>,
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items, value }: { items: { value: string; label: ReactNode }[]; value?: string }) => (
    <div data-tabs>
      {items.map((item) => (
        <button key={item.value} type="button" data-tab={item.value} aria-pressed={value === item.value}>{item.label}</button>
      ))}
    </div>
  ),
}));

let root: Root | null = null;
const container = document.createElement("div");

beforeAll(() => {
  // jsdom lacks Element.scrollIntoView; the triage list auto-scrolls on selection.
  Element.prototype.scrollIntoView = vi.fn();
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render() {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);
  });
  await flush();
  await flush();
}
async function click(el: Element | null) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}
function triageKeys(): string[] {
  return [...container.querySelectorAll("[data-triage-key]")].map((el) => el.getAttribute("data-triage-key") ?? "");
}
function telemetry(label: string): HTMLButtonElement {
  return container.querySelector(`[data-testid="inbox-telemetry-${label}"]`) as HTMLButtonElement;
}

beforeEach(() => {
  state.canWrite = true;
  state.canAdmin = true;
  state.pathname = "/inbox/all";
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("Inbox failed-run row retry", () => {
  it("renders an inline Retry button on the failed run row and retries without selecting the row", async () => {
    await render();
    const retry = container.querySelector('[data-testid="inbox-row-retry"]') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    expect(retry.closest("li")?.querySelector('[data-triage-key="run:run-1"]')).toBeTruthy();
    expect(retry.textContent).toContain("Retry");
    await click(retry);
    expect(agentsApi.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({ reason: "retry_failed_run" }));
    expect(container.querySelector('[data-triage-key="approval:appr-1"]')?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector('[data-triage-key="run:run-1"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("disables the row Retry button for viewers without write access", async () => {
    state.canWrite = false;
    await render();
    const retry = container.querySelector('[data-testid="inbox-row-retry"]') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("title")).toContain("required");
    await click(retry);
    expect(agentsApi.wakeup).not.toHaveBeenCalled();
  });
});

describe("Inbox telemetry filter buttons", () => {
  it("renders every count cell as a toggle button with aria-pressed", async () => {
    await render();
    for (const label of ["unread", "approvals", "failed", "joins", "alerts", "live"]) {
      expect(telemetry(label)?.tagName, label).toBe("BUTTON");
      expect(telemetry(label)?.getAttribute("aria-pressed"), label).toBe("false");
    }
    // "Items" is the everything-view segment, pressed by default.
    expect(telemetry("items").getAttribute("aria-pressed")).toBe("true");
  });

  it("filters failed runs on click and toggles back on the second click without zeroing counts", async () => {
    await render();
    expect(triageKeys()).toEqual(["approval:appr-1", "issue:issue-1", "run:run-1"]);
    await click(telemetry("failed"));
    expect(telemetry("failed").getAttribute("aria-pressed")).toBe("true");
    expect(telemetry("items").getAttribute("aria-pressed")).toBe("false");
    expect(triageKeys()).toEqual(["run:run-1"]);
    expect(telemetry("items").textContent).toContain("3");
    expect(telemetry("approvals").textContent).toContain("1");
    await click(telemetry("failed"));
    expect(telemetry("failed").getAttribute("aria-pressed")).toBe("false");
    expect(telemetry("items").getAttribute("aria-pressed")).toBe("true");
    expect(triageKeys()).toEqual(["approval:appr-1", "issue:issue-1", "run:run-1"]);
  });

  it("filters approvals on click and resets via the Items button", async () => {
    await render();
    await click(telemetry("approvals"));
    expect(telemetry("approvals").getAttribute("aria-pressed")).toBe("true");
    expect(triageKeys()).toEqual(["approval:appr-1"]);
    await click(telemetry("items"));
    expect(telemetry("approvals").getAttribute("aria-pressed")).toBe("false");
    expect(triageKeys()).toEqual(["approval:appr-1", "issue:issue-1", "run:run-1"]);
  });

  it("navigates to the unread tab from the Unread cell", async () => {
    state.pathname = "/inbox/recent";
    await render();
    await click(telemetry("unread"));
    expect(navigateSpy).toHaveBeenCalledWith("/inbox/unread");
  });
});

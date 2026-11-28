/** @vitest-environment jsdom */
// Core pages a11y (Front-End-Checklist: forms/labels, ARIA, feedback banners).
// Asserts accessible names, landmarks and aria attributes for the remediated
// controls on Dashboard, Inbox and Agents. Visual layout and behavior unchanged.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { Inbox } from "../Inbox";
import { Agents } from "../Agents";
import { agentsApi } from "../../api/agents";
import { dashboardApi } from "../../api/dashboard";
import { approvalsApi } from "../../api/approvals";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const loc = { pathname: "/inbox/all" };
const AGENT = { id: "agent-1", name: "에이전트 알파", status: "running", role: "manager", adapterType: "pi" };
const ISSUE = { id: "issue-1", identifier: "TST-1", title: "Issue A", status: "in_progress", priority: "high", updatedAt: "2026-01-01T02:00:00Z", lastExternalCommentAt: "2026-01-01T02:00:00Z", isUnreadForMe: false, assigneeAgentId: "agent-1", description: null, project: null };
const APPROVAL = { id: "appr-1", companyId: "company-1", type: "mission_plan", payload: {}, status: "pending", createdAt: "2026-01-01T03:00:00Z", updatedAt: "2026-01-01T03:00:00Z", requestedByAgentId: "agent-1", requestedByUserId: null, requestedByPluginId: null, decidedAt: null, decisionNote: null };

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: loc.pathname, search: "", hash: "" }),
}));
vi.mock("../../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/CompanyContext")>()),
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1", name: "테스트" }], canWrite: true, canAdmin: true }),
}));
vi.mock("../../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn(), openNewAgent: vi.fn() }),
  useOptionalDialog: () => null,
}));
vi.mock("../../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/issues")>()),
  issuesApi: { list: vi.fn(async () => [ISSUE]), markRead: vi.fn(async () => undefined) },
}));
vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []), org: vi.fn(async () => []), wakeup: vi.fn(async () => ({ id: "run-2", agentId: "agent-1", status: "queued" })) },
}));
vi.mock("../../api/dashboard", () => ({
  dashboardApi: {
    summary: vi.fn(async () => ({ agents: { error: 0, running: 0 }, costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 }, pendingApprovals: 0, budgets: { pendingApprovals: 0 } })),
    telemetry: vi.fn(async () => null),
    dgate: vi.fn(async () => null),
  },
}));
vi.mock("../../api/costs", () => ({ costsApi: { quotaWindows: vi.fn(async () => []) } }));
vi.mock("../../api/missions", () => ({ missionsApi: { list: vi.fn(async () => []) } }));
vi.mock("../../api/approvals", () => ({
  approvalsApi: { list: vi.fn(async () => [APPROVAL]), approve: vi.fn(), reject: vi.fn() },
}));
vi.mock("../../api/access", () => ({
  accessApi: { listJoinRequests: vi.fn(async () => []), approveJoinRequest: vi.fn(), rejectJoinRequest: vi.fn() },
}));
vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn(async () => []), list: vi.fn(async () => []) },
}));
vi.mock("../../api/harnessRsi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/harnessRsi")>()),
  harnessRsiApi: {
    diagnose: vi.fn(async () => null),
    proposals: vi.fn(async () => null),
    ledger: vi.fn(async () => null),
    recordDecision: vi.fn(async () => ({})),
    evaluateEntry: vi.fn(async () => ({})),
  },
}));
vi.mock("../../hooks/useInboxHeartbeatData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useInboxHeartbeatData")>()),
  useInboxHeartbeatData: () => ({
    isLoading: false,
    attentionItems: [],
    liveRuns: [],
    liveIssueIds: new Set<string>(),
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
  }),
}));
vi.mock("../../components/ApprovalPayload", () => ({
  ApprovalPayloadRenderer: () => null,
  approvalLabel: (type: string) => type,
}));
vi.mock("../../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div data-tabs-root>{children}</div>,
}));
vi.mock("../../components/PageTabBar", () => ({
  PageTabBar: ({ items, value }: { items: { value: string; label: ReactNode }[]; value?: string }) => (
    <div data-tabs>
      {items.map((item) => (
        <button key={item.value} type="button" data-tab={item.value} aria-pressed={value === item.value}>{item.label}</button>
      ))}
    </div>
  ),
}));

const container = document.createElement("div");
let root: Root | null = null;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function mount(ui: ReactNode) {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  await flush();
  await flush();
}

beforeEach(() => {
  loc.pathname = "/inbox/all";
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("Dashboard a11y", () => {
  it("exposes the monitoring tablist and named tab controls", async () => {
    loc.pathname = "/dashboard";
    (agentsApi.list as Mock).mockResolvedValueOnce([AGENT]);
    await mount(<Dashboard />);
    const tablist = container.querySelector('[role="tablist"][aria-label="실시간 모니터링 탭"]');
    expect(tablist).toBeTruthy();
    const tabs = [...(tablist?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expect(tab.tagName).toBe("BUTTON");
      expect(tab.getAttribute("type")).toBe("button");
      expect(tab.getAttribute("aria-selected")).toBeTruthy();
    }
    expect(tabs[0]!.textContent).toContain("실행 중인 세션");
    expect(tabs[1]!.textContent).toContain("내부 통제 · 실행 관제");
  });

  it("announces query errors and the no-agents status banner", async () => {
    loc.pathname = "/dashboard";
    (dashboardApi.summary as Mock).mockRejectedValueOnce(new Error("대시보드 조회 실패"));
    await mount(<Dashboard />);
    const alert = container.querySelector('p[role="alert"]');
    expect(alert?.textContent).toContain("대시보드 조회 실패");
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain("You have no agents.");
  });
});

describe("Inbox a11y", () => {
  it("names filter selects, announces errors and alert banners", async () => {
    (dashboardApi.summary as Mock).mockResolvedValueOnce({ agents: { error: 2, running: 0 }, costs: { monthBudgetCents: 100_000, monthUtilizationPercent: 90 }, pendingApprovals: 0, budgets: { pendingApprovals: 0 } });
    (approvalsApi.list as Mock).mockRejectedValueOnce(new Error("승인 목록 조회 실패"));
    await mount(<Inbox />);
    expect(container.querySelector('button[aria-label="인박스 카테고리 필터"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="승인 상태 필터"]')).toBeTruthy();
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("승인 목록 조회 실패");
    const alerts = container.querySelector('[aria-live="polite"]');
    expect(alerts?.textContent).toContain("agents have errors");
    expect(container.querySelectorAll('button[aria-label="Dismiss"][type="button"]').length).toBe(2);
    expect(container.querySelector('[aria-label="Inbox detail"]')).toBeTruthy();
  });
});

describe("Agents a11y", () => {
  it("names search, filters, view toggle and option controls", async () => {
    loc.pathname = "/agents";
    await mount(<Agents />);
    expect(container.querySelector('input[aria-label="에이전트 검색"]')).toBeTruthy();
    expect(container.querySelector('select[aria-label="어댑터 필터"]')).toBeTruthy();
    expect(container.querySelector('select[aria-label="역할 필터"]')).toBeTruthy();
    const group = container.querySelector('[role="group"][aria-label="보기 전환"]');
    expect(group).toBeTruthy();
    expect(group?.querySelectorAll('button[aria-pressed][aria-label]').length).toBe(3);
    expect(container.querySelector('button[aria-label="텔레메트리 카드 보기"][aria-pressed="true"]')).toBeTruthy();
    const options = container.querySelector('button[aria-label="에이전트 필터 옵션"]');
    expect(options?.getAttribute("aria-expanded")).toBe("false");
    expect(options?.getAttribute("type")).toBe("button");
  });

  it("announces agent query errors", async () => {
    loc.pathname = "/agents";
    (agentsApi.list as Mock).mockRejectedValueOnce(new Error("에이전트 목록 조회 실패"));
    await mount(<Agents />);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("에이전트 목록 조회 실패");
  });
});

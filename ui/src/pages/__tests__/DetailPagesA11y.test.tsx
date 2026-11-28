/** @vitest-environment jsdom */
import { act, type ContextType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyContext } from "../../context/CompanyContext";
import { IssueDetail } from "../IssueDetail";
import { MissionDetail } from "../MissionDetail";
import { EnterpriseBots, type EnterpriseBotsData } from "../EnterpriseBots";

const harness = vi.hoisted(() => ({
  loading: false, error: null as Error | null, panelVisible: false,
  invalidateQueries: vi.fn(), setPanelVisible: vi.fn(), setBreadcrumbs: vi.fn(),
}));
const issue = {
  id: "issue-1", identifier: "ISS-1", title: "Accessible work", description: "Body",
  companyId: "company-1", status: "todo", priority: "medium", projectId: null,
  hiddenAt: "2026-11-28T00:00:00Z", ancestors: [], labels: [],
  createdAt: "2026-11-28T00:00:00Z", updatedAt: "2026-11-28T00:00:00Z",
};
const mission = { ...issue, id: "mission-1", ownerAgentId: "agent-1", status: "active" };
const data: EnterpriseBotsData = {
  bots: ["First", "Second"].map((name, i) => ({
    id: `bot-${i}`, name, kind: "team", status: "active", callableBy: "team",
    dataScope: "team", capabilities: [], ownerName: "Ops",
  })),
  terminals: [], channels: [], pendingApprovals: [],
};
const searchParams = new URLSearchParams();
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: ({ queryKey: key }: { queryKey: readonly unknown[] }) => ({
    data: key[1] === "detail" ? (key[0] === "issues" ? issue : mission)
      : key[0] === "enterprise-bots" && key[1] === "snapshot" ? undefined
      : key[1] === "active-run" ? null : key[1] === "attachments" ? [{
        id: "attachment-1", originalFilename: "notes.txt", contentType: "text/plain",
        byteSize: 100, contentPath: "/notes.txt",
      }] : [],
    isLoading: harness.loading, isFetching: false, error: harness.error,
  }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ issueId: "ISS-1", missionId: "mission-1" }),
  useLocation: () => ({ state: null }), useNavigate: () => vi.fn(),
  useSearchParams: () => [searchParams, vi.fn()],
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("../../context/CompanyContext", async (original) => ({
  ...await original<typeof import("../../context/CompanyContext")>(),
  useCompany: () => ({ selectedCompanyId: "company-1", canWrite: true }),
}));
vi.mock("../../context/PanelContext", () => ({ usePanel: () => ({
  openPanel: vi.fn(), closePanel: vi.fn(), panelVisible: harness.panelVisible,
  setPanelVisible: harness.setPanelVisible,
}) }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openNewIssue: vi.fn(), openNewMission: vi.fn() }) }));
vi.mock("../../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: harness.setBreadcrumbs }) }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../hooks/useProjectOrder", () => ({ useProjectOrder: () => ({ orderedProjects: [] }) }));
// Keep shared editor/runtime widgets outside this page-owned markup audit.
vi.mock("../../components/InlineEditor", () => ({ InlineEditor: ({ value }: { value: string }) => <span>{value}</span> }));
vi.mock("../../components/CommentThread", () => ({ CommentThread: () => null }));
vi.mock("../../components/IssueDocumentsSection", () => ({ IssueDocumentsSection: () => null }));
vi.mock("../../components/ScrollToBottom", () => ({ ScrollToBottom: () => null }));
vi.mock("../../components/MissionExecutionOverview", () => ({ MissionExecutionOverview: () => null }));
vi.mock("../../components/MissionRevisionActions", () => ({ MissionRevisionActions: () => null }));

let host: HTMLDivElement;
let root: Root;
const render = async (page: ReactNode) => { await act(async () => { root.render(page); }); };
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };
const textButton = (text: string) => [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;
function checkControls(scope: Element) {
  const controls = [...scope.querySelectorAll("input, textarea, select")];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(Boolean(control.getAttribute("aria-label")?.trim()) ||
      Boolean(control.id && scope.querySelector(`label[for="${control.id}"]`))).toBe(true);
  }
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  harness.loading = false; harness.error = null; harness.panelVisible = false;
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("detail page accessibility and keyboard navigation", () => {
  it("names issue icon actions and the attachment control without implicit submit buttons", async () => {
    await render(<IssueDetail />);
    for (const label of ["Sub-item", "Copy work item as markdown", "Properties", "Show properties", "More work item actions", "Delete attachment: notes.txt"]) {
      expect(button(label), label).toBeTruthy();
      expect(button(label).type).toBe("button");
      expect(button(label).getAttribute("type")).toBe("button");
    }
    checkControls(host);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("This work item is hidden");
    await click(button("Show properties"));
    expect(harness.setPanelVisible).toHaveBeenCalledWith(true);
    harness.panelVisible = true;
    await render(<IssueDetail />);
    expect(button("Show properties").tabIndex).toBe(-1);
  });

  it("announces issue loading and load failures", async () => {
    harness.loading = true;
    await render(<IssueDetail />);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Loading...");
    harness.loading = false; harness.error = new Error("Issue unavailable");
    await render(<IssueDetail />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Issue unavailable");
  });

  it("keeps the mission refresh action named and announces mission load failures", async () => {
    await render(<MissionDetail />);
    expect(button("Refresh mission detail").getAttribute("type")).toBe("button");
    await click(button("Refresh mission detail"));
    expect(harness.invalidateQueries).toHaveBeenCalled();
    harness.error = new Error("Mission unavailable");
    await render(<MissionDetail />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Mission unavailable");
  });

  it("announces live bot loading and snapshot failures", async () => {
    const client = new QueryClient();
    const context = { selectedCompanyId: "company-1", selectedCompany: null } as ContextType<typeof CompanyContext>;
    const page = <QueryClientProvider client={client}><CompanyContext.Provider value={context}><EnterpriseBots /></CompanyContext.Provider></QueryClientProvider>;
    harness.loading = true;
    await render(page);
    expect([...host.querySelectorAll('[aria-live="polite"]')].some((el) => el.textContent?.includes("엔터프라이즈 봇 로드 중"))).toBe(true);
    harness.loading = false; harness.error = new Error("Bots unavailable");
    await render(<QueryClientProvider client={client}><CompanyContext.Provider value={context}><EnterpriseBots /></CompanyContext.Provider></QueryClientProvider>);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Bots unavailable");
    client.clear();
  });

  it.each(["Enter", " "])("selects bot cards with %j and prevents default scrolling", async (key) => {
    await render(<EnterpriseBots initialData={data} />);
    const cards = [...host.querySelectorAll<HTMLElement>('[role="button"]')];
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    cards[1].focus();
    expect(document.activeElement).toBe(cards[1]);
    await act(async () => { cards[1].dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(cards[1].getAttribute("data-selected")).toBe("true");
    expect(host.querySelector('section[aria-label$="detail"] h2')?.textContent).toBe("Second");
  });

  it("labels connector and terminal form controls and announces team loading errors", async () => {
    await render(<EnterpriseBots initialData={data} teamsLoadError="Teams unavailable" />);
    checkControls(host);
    await click(textButton("커넥터 연결"));
    const connector = host.querySelector('[role="dialog"]')!;
    checkControls(connector);
    expect(button("커넥터 연결 대화상자 닫기").type).toBe("button");
    await click(button("커넥터 연결 대화상자 닫기"));
    await click(textButton("터미널 등록"));
    const terminal = host.querySelector('[role="dialog"]')!;
    checkControls(terminal);
    const kind = terminal.querySelector<HTMLSelectElement>('[aria-label="Terminal Kind"]')!;
    await act(async () => { kind.value = "worker_node"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
    const error = terminal.querySelector('[data-teams-error="true"]');
    expect(error?.getAttribute("aria-live")).toBe("polite");
    expect(error?.textContent).toContain("Teams unavailable");
  });

  it.each([true, false])("announces bot ping results (ok=%s)", async (ok) => {
    await render(<EnterpriseBots initialData={data} onPingBot={vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503 })} />);
    await click(textButton("Test Ping"));
    const result = host.querySelector("[data-ping-result]");
    expect(result?.getAttribute("aria-live")).toBe("polite");
    expect(result?.textContent).toContain(ok ? "Ping OK" : "Ping failed");
  });
});

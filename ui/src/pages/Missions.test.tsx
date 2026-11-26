/** @vitest-environment jsdom */
// jsdom keeps the existing static-markup assertions and allows real row/keyboard interaction tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Missions } from "./Missions";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let currentSearchParams = new URLSearchParams();
const observedQueryKeys: unknown[][] = [];
// Extra canned responses for telemetry queries, keyed by the first query-key element.
let telemetryData: Record<string, unknown> = {};

const step = (stepId: string, name: string, status: string) => ({
  stepId, name, status, type: "agent", agentId: "agent-1", dependencies: [], description: null,
  toolNames: [], knowledgeBaseIds: [], issueId: null, issue: null, workProducts: [],
  startedAt: null, completedAt: null,
});
const WORKFLOW_RUN = {
  id: "run-1", workflowId: "wf-1", companyId: "company-1", missionId: "mission-1", status: "running",
  triggeredBy: "agent", startedAt: null, completedAt: null, createdAt: "2026-04-27T08:00:00.000Z",
  workflowName: "Launch flow", stepRuns: [],
  steps: [step("s1", "Draft checklist", "completed"), step("s2", "QA review", "running"), step("s3", "Publish", "pending")],
  progress: { totalSteps: 3, pendingSteps: 1, runningSteps: 1, completedSteps: 1, failedSteps: 0, skippedSteps: 0 },
};
const MISSIONS = [
  {
    id: "mission-1", companyId: "company-1", ownerAgentId: "agent-1", title: "Launch readiness",
    description: "Prepare the launch checklist.", status: "planning",
    createdAt: "2026-04-26T12:34:00.000Z", updatedAt: "2026-04-27T08:00:00.000Z",
  },
  {
    id: "mission-2", companyId: "company-1", ownerAgentId: "agent-1", title: "Weekly digest",
    description: null, status: "active",
    createdAt: "2026-04-25T09:15:00.000Z", updatedAt: "2026-04-28T10:00:00.000Z",
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    observedQueryKeys.push([...queryKey]);
    const settled = (data: unknown) => ({ data, isLoading: false, isFetching: false, error: null, refetch: vi.fn() });

    if (queryKey[0] === "missions") {
      return settled(queryKey[1] === "detail" ? (queryKey[2] === "mission-1" ? [WORKFLOW_RUN] : []) : MISSIONS);
    }
    if (queryKey[0] === "agents") {
      return settled([{ id: "agent-1", name: "Rocket QA" }]);
    }
    return settled(telemetryData[String(queryKey[0])]);
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useSearchParams: () => [currentSearchParams, vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewMission: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

vi.mock("@/components/ui/button", () => ({
  // Pass through real button props (className, aria-label, title) so toolbar assertions can see them.
  Button: ({ children, variant, size, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("lucide-react", () => ({
  Inbox: () => <span>Inbox</span>,
  MessageSquare: () => <span>MessageSquare</span>,
  PanelRightOpen: () => <span>PanelRightOpen</span>,
  Plus: () => <span>Plus</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  Rocket: () => <span>Rocket</span>,
  ShieldCheck: () => <span>ShieldCheck</span>,
  UserRoundCheck: () => <span>UserRoundCheck</span>,
  X: () => <span>X</span>,
}));

describe("Missions", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 30, 12, 0, 0));
    currentSearchParams = new URLSearchParams();
    observedQueryKeys.length = 0;
    telemetryData = {};
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  async function mount(): Promise<HTMLElement> {
    vi.useRealTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Missions />); });
    return host;
  }

  const selectedRow = (container: HTMLElement) =>
    container.querySelector("[data-mission-row][data-selected]")?.getAttribute("data-mission-row") ?? null;
  const press = (key: string, target: EventTarget = document.body) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

  it("links mission rows to the company-relative mission detail route", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Launch readiness");
    expect(html).toContain('href="/missions/mission-1"');
    expect(html).not.toContain('href="missions/mission-1"');
  });

  it("labels the mission owner as the main executor", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Main executor");
    expect(html).toContain("Rocket QA");
  });

  it("shows mission creation date and time to distinguish repeated workflow-created titles", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Launch readiness");
    expect(html).toMatch(/\d{2}:\d{2}/);
  });

  it("includes paging, sorting, owner filtering, and date filters in the missions query key", () => {
    currentSearchParams = new URLSearchParams(
      "status=active&ownerAgentId=agent-1&from=2026-04-29&to=2026-04-30&sortBy=title&sortOrder=asc&pageSize=10&page=3",
    );

    renderToStaticMarkup(<Missions />);

    expect(observedQueryKeys).toContainEqual([
      "missions",
      "company-1",
      {
        status: "active",
        ownerAgentId: "agent-1",
        from: "2026-04-29",
        to: "2026-04-30",
        sortBy: "title",
        sortOrder: "asc",
        limit: 10,
        offset: 20,
      },
    ]);
  });

  it("defaults the created-from filter to yesterday when URL params are absent", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain('value="2026-04-29"');
    expect(observedQueryKeys).toContainEqual([
      "missions",
      "company-1",
      {
        from: "2026-04-29",
        sortBy: "updatedAt",
        sortOrder: "desc",
        limit: 25,
        offset: 0,
      },
    ]);
  });

  it("renders mission list controls for filtering, sorting, and paging", () => {
    currentSearchParams = new URLSearchParams("page=2&pageSize=10");

    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("All executors");
    expect(html).toContain("Recently updated");
    expect(html).toContain("Page 2");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });

  it("renders a refresh action for the current missions tab", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Refresh");
    expect(html).toContain("RefreshCw");
  });

  it("renders the cockpit command header and quick operator links on Missions", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("명령 헤더");
    expect(html).toContain("Active agents");
    expect(html).toContain("Waiting / blocked");
    expect(html).toContain(">—<");
    expect(html).toContain('href="/worktree/rules"');
    expect(html).toContain('href="/channels"');
    expect(html).toContain('href="/human-operator"');
    expect(html).toContain("우측 인스펙터");
  });

  it("renders the live metrics as one 5-column cockpit strip with a single-line queue ticker", () => {
    telemetryData = {
      dashboard: {
        companyId: "company-1",
        agents: { active: 3, running: 2, paused: 0, error: 1 },
        tasks: { open: 4, inProgress: 5, blocked: 7, done: 9 },
        costs: { monthSpendCents: 123456, monthBudgetCents: 250000, monthUtilizationPercent: 49 },
        pendingApprovals: 1,
        budgets: { activeIncidents: 0, pendingApprovals: 1, pausedAgents: 0, pausedProjects: 0 },
      },
      "operator-decisions": { data: [{ id: "d-1", title: "Approve source list" }], page: { nextCursor: null } },
      "ops-console-queue": { items: [{ id: "q-1", reason: "Heartbeat stalled" }] },
    };

    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("grid-cols-2 lg:grid-cols-5 divide-x divide-[#242d3f] bg-[#111622] border border-[#242d3f] rounded-md");
    expect(html.match(/text-xl font-semibold/g)).toHaveLength(5);
    expect(html).toContain("Active agents");
    expect(html).toContain("6 enabled");
    expect(html).toContain("Running work");
    expect(html).toContain("7 blocked");
    expect(html).toContain("Active missions");
    expect(html).toContain("1 planning");
    expect(html).toContain("Monthly spend");
    expect(html).toContain("$1234.56");
    expect(html).toContain("of $2500.00 · 49%");
    expect(html).toContain("Waiting / blocked");
    expect(html).toContain("2 waiting on humans");
    expect(html).toContain("Decision");
    expect(html).toContain("Approve source list");
    expect(html).toContain("Queued");
    expect(html).toContain("Heartbeat stalled");
    expect(html).toContain("Review →");
  });

  it("aligns status tabs, compact executor/sort controls, and the new mission CTA on one toolbar row", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain('aria-label="Filter missions by status"');
    for (const tab of ["All", "Planning", "Active", "Paused", "Completed", "Cancelled"]) {
      expect(html).toContain(`>${tab}</button>`);
    }
    expect(html).toContain("All executors");
    expect(html).toContain('aria-label="Main executor"');
    expect(html).toContain('aria-label="Sort missions"');
    expect(html).toContain("Recently created");
    expect(html).toContain('aria-label="Created from"');
    expect(html).toContain('aria-label="Created to"');
    expect(html).toContain('aria-label="Toggle mission preview pane"');
    expect(html).toContain('value="2026-04-29"');
    expect(html).toContain('bg-[#2563eb]');
    expect(html).toContain("New Mission");
  });

  it("opens the split preview pane from a row with summary, step checklist, and the full-mission link", async () => {
    const container = await mount();
    expect(container.querySelector("[data-mission-preview]")).toBeNull();

    const row = container.querySelector('[data-mission-row="mission-1"]') as HTMLElement;
    await act(async () => { row.click(); });

    const pane = container.querySelector("[data-mission-preview]") as HTMLElement;
    expect(pane.textContent).toContain("Launch readiness");
    expect(pane.textContent).toContain("Prepare the launch checklist.");
    expect(pane.textContent).toContain("Rocket QA");
    expect(pane.textContent).toContain("1/3 · 33%");
    expect(pane.textContent).toContain("Draft checklist");
    expect(pane.textContent).toContain("QA review");
    expect(pane.textContent).toContain("Publish");
    expect(pane.textContent).toContain("Open Full Mission →");
    expect(pane.querySelector("a")?.getAttribute("href")).toBe("/missions/mission-1");
    expect(selectedRow(container)).toBe("mission-1");
    expect(observedQueryKeys).toContainEqual(["missions", "detail", "mission-1", "workflow-runs"]);
  });

  it("moves the preview with j/k, ignores typing targets, and closes on Esc or the toolbar toggle", async () => {
    const container = await mount();

    await press("j");
    expect(selectedRow(container)).toBe("mission-1");
    await press("j");
    expect(selectedRow(container)).toBe("mission-2");
    await press("j");
    expect(selectedRow(container)).toBe("mission-2");
    await press("k");
    expect(selectedRow(container)).toBe("mission-1");
    await press("k");
    expect(selectedRow(container)).toBe("mission-1");

    await press("j", container.querySelector('input[type="date"]')!);
    expect(selectedRow(container)).toBe("mission-1");

    await press("Escape", document.body);
    expect(container.querySelector("[data-mission-preview]")).not.toBeNull();
    await press("Escape", container.querySelector("[data-mission-preview] button")!);
    expect(container.querySelector("[data-mission-preview]")).toBeNull();

    const toggle = container.querySelector('button[aria-label="Toggle mission preview pane"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-mission-preview]")?.textContent).toContain("Launch readiness");
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-mission-preview]")).toBeNull();
  });
});

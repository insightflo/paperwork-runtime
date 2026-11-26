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
      if (queryKey[1] === "detail") {
        if (queryKey[3] === "issues") return settled([]);
        return settled(queryKey[2] === "mission-1" ? [WORKFLOW_RUN] : []);
      }
      return settled(MISSIONS);
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
  AlertTriangle: () => <span>AlertTriangle</span>,
  Inbox: () => <span>Inbox</span>,
  Loader2: () => <span>Loader2</span>,
  MessageSquare: () => <span>MessageSquare</span>,
  PanelRightOpen: () => <span>PanelRightOpen</span>,
  Pause: () => <span>Pause</span>,
  Play: () => <span>Play</span>,
  Plus: () => <span>Plus</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  Rocket: () => <span>Rocket</span>,
  Search: () => <span>Search</span>,
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
    expect(html).toMatch(/Page\s*(?:<[^>]+>)?2/);
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });

  it("renders a refresh action for the current missions tab", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Refresh");
    expect(html).toContain("RefreshCw");
  });

  it("omits the duplicate global 5-column KPI strip and hides the escalation ticker when nothing is waiting", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).not.toContain("Active agents");
    expect(html).not.toContain("Monthly spend");
    expect(html).not.toContain("Running work");
    expect(html).not.toContain("waiting on humans");
  });

  it("renders the compact escalation ticker when decisions or queue items are waiting", () => {
    telemetryData = {
      "operator-decisions": { data: [{ id: "d-1", title: "Approve source list" }], page: { nextCursor: null } },
      "ops-console-queue": { items: [{ id: "q-1", reason: "Heartbeat stalled" }] },
    };

    const html = renderToStaticMarkup(<Missions />);

    expect(html).not.toContain("Active agents");
    expect(html).not.toContain("Monthly spend");
    expect(html).toContain("2 waiting on humans");
    expect(html).toContain("Decision");
    expect(html).toContain("Approve source list");
    expect(html).toContain("Queued");
    expect(html).toContain("Heartbeat stalled");
    expect(html).toContain("Review →");
  });

  it("omits duplicate legacy status tabs and aligns executor/date/sort controls with the new mission CTA on one toolbar row", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).not.toContain('aria-label="Filter missions by status"');
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
    // Permanent Live Inspector starts open on the top-priority active mission (mission-2).
    expect(container.querySelector("[data-mission-preview]")).not.toBeNull();

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

  it("moves the preview with j/k and ArrowUp/ArrowDown, ignores typing targets, and closes on Esc or the toolbar toggle", async () => {
    const container = await mount();
    // Active mission (mission-2) is prioritized above planning mission (mission-1).
    expect(selectedRow(container)).toBe("mission-2");

    await press("j");
    expect(selectedRow(container)).toBe("mission-1");
    await press("j");
    expect(selectedRow(container)).toBe("mission-1");
    await press("k");
    expect(selectedRow(container)).toBe("mission-2");
    await press("ArrowDown");
    expect(selectedRow(container)).toBe("mission-1");
    await press("ArrowUp");
    expect(selectedRow(container)).toBe("mission-2");

    await press("j", container.querySelector('input[type="date"]')!);
    expect(selectedRow(container)).toBe("mission-2");

    await press("Escape", document.body);
    expect(container.querySelector("[data-mission-preview]")).not.toBeNull();
    await press("Escape", container.querySelector("[data-mission-preview] button")!);
    expect(container.querySelector("[data-mission-preview]")).toBeNull();

    const toggle = container.querySelector('button[aria-label="Toggle mission preview pane"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-mission-preview]")?.textContent).toContain("Weekly digest");
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-mission-preview]")).toBeNull();
  });
});

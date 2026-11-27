/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { Missions } from "./Missions";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const updateMissionMock = vi.fn().mockResolvedValue({});
const setSearchParamsMock = vi.fn();

const FLEET_MISSIONS = Array.from({ length: 42 }, (_, idx) => {
  const num = idx + 1;
  const status =
    num <= 26 ? "active" : num <= 34 ? "paused" : num <= 37 ? "planning" : "completed";
  const projects = [
    { id: "p-1", name: "youtube-report", color: "#fb7185" },
    { id: "p-2", name: "tech-blog-radar", color: "#2dd4bf" },
    { id: "p-3", name: "company-analysis", color: "#fb923c" },
  ];
  return {
    id: `mission-${num}`,
    companyId: "company-1",
    ownerAgentId: num % 2 === 0 ? "agent-2" : "agent-1",
    title: `Mission Alpha ${num}`,
    description: `Goal summary for mission ${num}.`,
    status,
    goalId: null,
    project: projects[idx % projects.length],
    startedAt: null,
    completedAt: null,
    createdAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T09:30:00.000Z",
  };
});

const PENDING_DECISIONS = {
  data: [
    {
      id: "dec-1",
      title: "Approve render farm slot",
      sourceContext: { missionId: "mission-10", workflowId: null, workflowRunId: null, artifactRefs: [] },
      continuation: null,
    },
    {
      id: "dec-2",
      title: "G3 advisor gate approval",
      sourceContext: { missionId: "mission-30", workflowId: null, workflowRunId: null, artifactRefs: [] },
      continuation: null,
    },
  ],
  page: { nextCursor: null },
};

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const settled = (data: unknown) => ({
      data,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    if (queryKey[0] === "missions") {
      if (queryKey[1] === "detail") {
        if (queryKey[3] === "issues") {
          return settled([
            { id: "iss-1", identifier: "RES-101", title: "Verify subtitle sync", status: "in_progress" },
          ]);
        }
        return settled([
          {
            id: "run-1",
            workflowId: "wf-1",
            companyId: "company-1",
            missionId: String(queryKey[2]),
            status: "running",
            triggeredBy: "agent",
            startedAt: null,
            completedAt: null,
            createdAt: "2026-11-26T09:00:00.000Z",
            workflowName: "Radar flow",
            stepRuns: [],
            steps: [
              {
                stepId: "s1",
                name: "Collect sources",
                status: "completed",
                type: "agent",
                agentId: "agent-1",
                dependencies: [],
                description: null,
                toolNames: [],
                knowledgeBaseIds: [],
                issueId: null,
                issue: null,
                workProducts: [],
                startedAt: null,
                completedAt: null,
              },
              {
                stepId: "s2",
                name: "Verify output",
                status: "running",
                type: "agent",
                agentId: "agent-2",
                dependencies: [],
                description: null,
                toolNames: [],
                knowledgeBaseIds: [],
                issueId: "iss-1",
                issue: { id: "iss-1", identifier: "RES-101", title: "Verify subtitle sync", status: "in_progress", assigneeAgentId: "agent-2" },
                workProducts: [],
                startedAt: null,
                completedAt: null,
              },
            ],
            progress: { totalSteps: 2, pendingSteps: 0, runningSteps: 1, completedSteps: 1, failedSteps: 0, skippedSteps: 0 },
          },
        ]);
      }
      // Server paginated list (has non-empty filters object) vs allMissions (no/empty filters)
      const hasFilters =
        queryKey.length > 2 &&
        typeof queryKey[2] === "object" &&
        queryKey[2] !== null &&
        Object.keys(queryKey[2] as Record<string, unknown>).length > 0;
      return settled(hasFilters ? FLEET_MISSIONS.slice(0, 25) : FLEET_MISSIONS);
    }
    if (queryKey[0] === "agents") {
      return settled([
        { id: "agent-1", name: "Lead Executor" },
        { id: "agent-2", name: "PAQO Verifier" },
      ]);
    }
    if (queryKey[0] === "operator-decisions") {
      return settled(PENDING_DECISIONS);
    }
    return settled(undefined);
  },
}));

vi.mock("../api/missions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/missions")>();
  return {
    ...actual,
    missionsApi: {
      ...actual.missionsApi,
      update: (...args: unknown[]) => updateMissionMock(...args),
    },
  };
});

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useSearchParams: () => [new URLSearchParams(), setSearchParamsMock],
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
  EmptyState: ({ message, action, onAction }: { message: string; action?: string; onAction?: () => void }) => (
    <div>
      <span>{message}</span>
      {action && (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  ),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant, size, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

describe("Missions Combo 4 High-Scale Fleet Radar & Split View", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    updateMissionMock.mockClear();
    setSearchParamsMock.mockClear();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  async function mount(): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Missions />);
    });
    return host;
  }

  it("renders status filter chips with live fleet counts and omits the legacy mission mosaic", async () => {
    const container = await mount();

    expect(container.querySelector('[data-radar-status="all"]')?.textContent).toContain("전체42");
    expect(container.querySelector('[data-radar-status="need"]')?.textContent).toContain("개입 필요2");
    expect(container.querySelector('[data-radar-status="run"]')?.textContent).toContain("실행 중25");
    expect(container.querySelector('[data-radar-status="wait"]')?.textContent).toContain("대기10");
    expect(container.querySelector('[data-radar-status="done"]')?.textContent).toContain("완료5");

    // Regression guard: legacy 1,900-block visual mosaic must never be rendered.
    expect(container.querySelector("[data-mission-mosaic]")).toBeNull();
    expect(container.querySelectorAll("[data-mosaic-tile]")).toHaveLength(0);
  });

  it("sorts the split list by the active sort (default updatedAt:desc, id tie-break) and shows permanent Live Inspector", async () => {
    const container = await mount();

    // Fleet fixtures share identical updatedAt/createdAt, so the deterministic comparator
    // falls back to the id tie-break: mission-1 leads. Attention-first pinning was removed
    // by the s26-missions-sort-fix — the Sort dropdown now always controls row order.
    const rows = Array.from(container.querySelectorAll("[data-mission-row]"));
    expect(rows[0]?.getAttribute("data-mission-row")).toBe("mission-1");
    expect(rows[0]?.getAttribute("data-radar-bucket")).toBe("run");

    const inspector = container.querySelector("[data-mission-preview]") as HTMLElement;
    expect(inspector).not.toBeNull();
    expect(inspector.textContent).toContain("Mission Alpha 1");
    expect(inspector.textContent).toContain("RES-101");
    expect(inspector.textContent).toContain("Open Full Mission →");
  });

  it("filters by status chip, search query, and workflow dropdown, and updates Live Inspector on row selection", async () => {
    const container = await mount();

    // Filter to 개입 필요 (2 missions across the 42-mission fleet)
    const needChip = container.querySelector('[data-radar-status="need"]') as HTMLButtonElement;
    await act(async () => {
      needChip.click();
    });
    const needRows = container.querySelectorAll("[data-mission-row]");
    expect(needRows).toHaveLength(2);
    expect(needRows[0]?.getAttribute("data-mission-row")).toBe("mission-10");
    expect(needRows[1]?.getAttribute("data-mission-row")).toBe("mission-30");

    // Switch to 완료 chip and select mission-42 directly from the mission list to update Live Inspector
    const doneChip = container.querySelector('[data-radar-status="done"]') as HTMLButtonElement;
    await act(async () => {
      doneChip.click();
    });
    const doneRows = container.querySelectorAll("[data-mission-row]");
    expect(doneRows).toHaveLength(5);

    const row42 = container.querySelector('[data-mission-row="mission-42"]') as HTMLElement;
    expect(row42).not.toBeNull();
    await act(async () => {
      row42.click();
    });
    const inspector = container.querySelector("[data-mission-preview]") as HTMLElement;
    expect(inspector.textContent).toContain("Mission Alpha 42");

    // Reset radar status to 전체 and filter by workflow dropdown
    const allChip = container.querySelector('[data-radar-status="all"]') as HTMLButtonElement;
    await act(async () => {
      allChip.click();
    });
    const wfSelect = container.querySelector('select[aria-label="Filter by workflow"]') as HTMLSelectElement;
    await act(async () => {
      wfSelect.value = "tech-blog-radar";
      wfSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const wfRows = container.querySelectorAll("[data-mission-row]");
    expect(wfRows.length).toBeGreaterThan(0);
    expect(wfRows.length).toBeLessThan(25);
  });

  it("supports ArrowDown/ArrowUp keyboard row selection and status toggle action in Live Inspector", async () => {
    const container = await mount();

    // Initially the first row (mission-1, deterministic id tie-break) is selected
    expect(
      container.querySelector("[data-mission-row][data-selected]")?.getAttribute("data-mission-row"),
    ).toBe("mission-1");

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(
      container.querySelector("[data-mission-row][data-selected]")?.getAttribute("data-mission-row"),
    ).toBe("mission-10");

    // Click pause action button inside Live Inspector
    const pauseBtn = Array.from(
      container.querySelectorAll("[data-mission-preview] button"),
    ).find((b) => b.textContent?.includes("일시정지")) as HTMLButtonElement;
    expect(pauseBtn).toBeDefined();
    await act(async () => {
      pauseBtn.click();
    });
    expect(updateMissionMock).toHaveBeenCalledWith("mission-10", { status: "paused" });
  });
});

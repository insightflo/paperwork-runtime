/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import type {
  DashboardTelemetryBucket,
  DashboardTelemetryWindow,
  DashboardUsageShare,
} from "@/api/dashboard";
import { RadialVelocityGauge } from "../RadialVelocityGauge";
import { HealthAndQuotaPanel } from "../HealthAndQuotaPanel";
import { TokenFlowChart } from "../TokenFlowChart";
import { UsageTreemap } from "../UsageTreemap";
import { LiveSessionsTable, type LiveSessionRow } from "../LiveSessionsTable";
import { DgateMonitorPanel, type DgateMonitorResponse } from "../DgateMonitorPanel";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(node: ReactNode) {
  act(() => {
    root.render(node);
  });
}

describe("Dashboard 1top × dgate components", () => {
  it("renders RadialVelocityGauge and switches HealthAndQuotaPanel windows with quota dot-bars", () => {
    const onWindowChange = vi.fn<(w: DashboardTelemetryWindow) => void>();
    const quotas: ProviderQuotaResult[] = [
      {
        provider: "anthropic",
        source: "oauth",
        ok: true,
        windows: [
          { label: "5h", usedPercent: 78, resetsAt: null, valueLabel: null },
          { label: "7d", usedPercent: 42, resetsAt: null, valueLabel: null },
        ],
      },
      {
        provider: "openai",
        source: "oauth",
        ok: true,
        windows: [{ label: "5h", usedPercent: 93, resetsAt: null, valueLabel: null }],
      },
    ];

    render(
      <div>
        <RadialVelocityGauge
          tokensPerHour={1_250_000}
          peakTokensPerHour={2_500_000}
          totalTokens={3_400_000}
          avgTokensPerBucket={280_000}
          activeWorkers={3}
          hostLabel="mac-studio"
        />
        <HealthAndQuotaPanel
          window="6h"
          onWindowChange={onWindowChange}
          host={{
            cpuPct: 44,
            memPct: 68,
            memUsedGb: 21.8,
            memTotalGb: 32,
            loadAvg1m: 2.15,
            activeRuns: 3,
            activeAgents: 2,
          }}
          quotas={quotas}
        />
      </div>,
    );

    expect(container.textContent).toContain("1.3M");
    expect(container.textContent).toContain("tokens/시간");
    expect(container.textContent).toContain("mac-studio · 3");
    expect(container.textContent).toContain("44%");
    expect(container.textContent).toContain("68%");

    // Quota dot-bars rendered with progressbar role
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(3);
    expect(container.textContent).toContain("93%");
    expect(container.textContent).toContain("78%");

    // Window switching: 10m / 1h / 6h / 24h
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(["10분", "1시간", "6시간", "1일"]);
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      tabs[0]?.click();
    });
    expect(onWindowChange).toHaveBeenCalledWith("10m");

    act(() => {
      tabs[1]?.click();
    });
    expect(onWindowChange).toHaveBeenCalledWith("1h");

    act(() => {
      tabs[3]?.click();
    });
    expect(onWindowChange).toHaveBeenCalledWith("24h");
  });

  it("renders TokenFlowChart and toggles UsageTreemap between 프로젝트 and 에이전트", () => {
    const buckets: DashboardTelemetryBucket[] = [
      {
        bucketStart: "2026-11-26T05:00:00Z",
        bucketEnd: "2026-11-26T05:30:00Z",
        totalTokens: 420_000,
        inputTokens: 300_000,
        outputTokens: 120_000,
        cachedInputTokens: 50_000,
        costCents: 185,
        runs: 4,
        byModel: { "claude-sonnet-4-6": 260_000, "gpt-5.4": 160_000 },
      },
      {
        bucketStart: "2026-11-26T05:30:00Z",
        bucketEnd: "2026-11-26T06:00:00Z",
        totalTokens: 580_000,
        inputTokens: 400_000,
        outputTokens: 180_000,
        cachedInputTokens: 70_000,
        costCents: 240,
        runs: 5,
        byModel: { "claude-sonnet-4-6": 380_000, "gpt-5.4": 200_000 },
      },
    ];
    const projectShares: DashboardUsageShare[] = [
      { id: "p1", name: "Paperwork Runtime", tokens: 700_000, costCents: 310, runs: 6, sharePct: 70 },
      { id: "p2", name: "Gazua Dashboard", tokens: 300_000, costCents: 115, runs: 3, sharePct: 30 },
    ];
    const agentShares: DashboardUsageShare[] = [
      { id: "a1", name: "Codex Builder", tokens: 620_000, costCents: 270, runs: 5, sharePct: 62 },
      { id: "a2", name: "Claude Reviewer", tokens: 380_000, costCents: 155, runs: 4, sharePct: 38 },
    ];

    render(
      <div>
        <TokenFlowChart
          buckets={buckets}
          models={["claude-sonnet-4-6", "gpt-5.4"]}
          avgTokensPerBucket={500_000}
          window="6h"
        />
        <UsageTreemap projectShares={projectShares} agentShares={agentShares} />
      </div>,
    );

    expect(container.textContent).toContain("토큰 흐름");
    expect(container.textContent).toContain("1.0M tok");
    expect(container.textContent).toContain("claude-sonnet-4-6");
    expect(container.textContent).toContain("gpt-5.4");

    // Default UsageTreemap mode is 프로젝트
    expect(container.textContent).toContain("Paperwork Runtime");
    expect(container.textContent).not.toContain("Codex Builder");

    const agentTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (btn) => btn.textContent === "에이전트",
    );
    expect(agentTab).toBeDefined();

    act(() => {
      agentTab!.click();
    });

    expect(container.textContent).toContain("Codex Builder");
    expect(container.textContent).toContain("Claude Reviewer");
    expect(container.textContent).not.toContain("Paperwork Runtime");
  });

  it("supports search, status filter, model filter, and sorting in LiveSessionsTable", () => {
    const sessions: LiveSessionRow[] = [
      {
        runId: "run-1",
        agentId: "ag-1",
        agentName: "Alpha Coder",
        adapterType: "claude_local",
        model: "anthropic/claude-sonnet-4-6",
        projectId: "p1",
        projectName: "Runtime Core",
        issueId: "iss-1",
        issueIdentifier: "PW-101",
        issueTitle: "Build telemetry pipeline",
        status: "running",
        startedAt: "2026-11-26T07:00:00Z",
        elapsedSec: 600,
        tokens: 180_000,
        recentTokens: 180_000,
        outputTokens: 42_000,
        totalTokens: 250_000,
        tokensPerHour: 1_080_000,
        costCents: 140,
      },
      {
        runId: "run-2",
        agentId: "ag-2",
        agentName: "Beta Verifier",
        adapterType: "codex_local",
        model: "openai/gpt-5.4",
        projectId: "p2",
        projectName: "Gazua Web",
        issueId: "iss-2",
        issueIdentifier: "PW-102",
        issueTitle: "Verify chart rendering",
        status: "succeeded",
        startedAt: "2026-11-26T06:30:00Z",
        elapsedSec: 1200,
        tokens: 90_000,
        recentTokens: 90_000,
        outputTokens: 20_000,
        totalTokens: 480_000,
        tokensPerHour: 270_000,
        costCents: 210,
      },
      {
        runId: "run-3",
        agentId: "ag-3",
        agentName: "Gamma Planner",
        adapterType: "codex_local",
        model: "openai/gpt-5.4",
        projectId: "p1",
        projectName: "Runtime Core",
        issueId: "iss-3",
        issueIdentifier: "PW-103",
        issueTitle: "Draft rollout checklist",
        status: "running",
        startedAt: "2026-11-26T07:10:00Z",
        elapsedSec: 300,
        tokens: 60_000,
        recentTokens: 60_000,
        outputTokens: 15_000,
        totalTokens: 60_000,
        tokensPerHour: 1_440_000,
        costCents: 45,
      },
    ];

    render(<LiveSessionsTable sessions={sessions} />);

    // Header counts: 3 total, 2 active, 1 idle
    expect(container.textContent).toContain("실행 중인 세션");
    expect(container.textContent).toContain("작업 중 2");
    expect(container.textContent).toContain("대기 중 1");

    const getRowIds = () =>
      Array.from(container.querySelectorAll<HTMLTableRowElement>("tr[data-session-row]")).map(
        (tr) => tr.dataset.sessionRow,
      );

    // Default sort: recent tokens desc -> run-1, run-2, run-3
    expect(getRowIds()).toEqual(["run-1", "run-2", "run-3"]);

    // Sort by burn rate desc -> run-3 (1.44M/h), run-1 (1.08M/h), run-2 (270K/h)
    const sortSelect = container.querySelector<HTMLSelectElement>('select[aria-label="정렬 기준"]')!;
    act(() => {
      sortSelect.value = "burn";
      sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getRowIds()).toEqual(["run-3", "run-1", "run-2"]);

    // Sort by total tokens desc -> run-2 (480K), run-1 (250K), run-3 (60K)
    act(() => {
      sortSelect.value = "total";
      sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getRowIds()).toEqual(["run-2", "run-1", "run-3"]);

    // Status filter: 작업 중 -> only run-1 and run-3
    const statusSelect = container.querySelector<HTMLSelectElement>('select[aria-label="상태 필터"]')!;
    act(() => {
      statusSelect.value = "active";
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getRowIds()).toEqual(["run-1", "run-3"]);

    // Model filter: openai/gpt-5.4 -> only run-3
    const modelSelect = container.querySelector<HTMLSelectElement>('select[aria-label="모델 필터"]')!;
    act(() => {
      modelSelect.value = "openai/gpt-5.4";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getRowIds()).toEqual(["run-3"]);

    // Reset filters and search by keyword "Gazua"
    act(() => {
      statusSelect.value = "all";
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      modelSelect.value = "all";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      nativeSetter?.call(searchInput, "Gazua");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(getRowIds()).toEqual(["run-2"]);
  });

  it("renders DgateMonitorPanel as Paperwork native internal control plane with live gates and never shows Mac dgate offline warning", () => {
    const liveResponse: DgateMonitorResponse = {
      connected: true,
      source: "paperwork_internal",
      timestamp: "2026-11-26T07:14:58Z",
      summary: {
        activeRuns: 2,
        queuedRuns: 1,
        activeAgents: 4,
        totalAgents: 6,
        pendingApprovals: 2,
        pendingDecisions: 1,
        openBudgetIncidents: 1,
        pendingWorktreeProposals: 2,
        passRatePct: 90,
      },
      workers: [
        {
          runId: "run-101",
          agentId: "ag-101",
          agentName: "Alpha Coder",
          role: "engineer",
          adapterType: "claude_local",
          model: "claude-sonnet-4-6",
          status: "running",
          startedAt: "2026-11-26T07:12:43Z",
          durationMs: 135_000,
          contextLabel: "Implementing internal control plane UI",
        },
        {
          runId: "run-102",
          agentId: "ag-102",
          agentName: "Beta QA",
          role: "qa",
          adapterType: "codex_local",
          model: "gpt-5.4",
          status: "queued",
          startedAt: "2026-11-26T07:14:13Z",
          durationMs: 45_000,
          contextLabel: "Queued for verification pass",
        },
      ],
      gates: {
        approvals: [
          {
            id: "ap-1",
            kind: "approval",
            title: "Approve production deploy",
            status: "pending",
            severity: "high",
            createdAt: "2026-11-26T07:10:00Z",
            linkPath: "/approvals",
          },
          {
            id: "ap-2",
            kind: "approval",
            title: "Approve agent budget bump",
            status: "pending",
            severity: "medium",
            createdAt: "2026-11-26T07:11:00Z",
            linkPath: "/approvals",
          },
        ],
        operatorDecisions: [
          {
            id: "dec-1",
            kind: "operator_decision",
            title: "Confirm Wave 2 release timing",
            status: "open",
            severity: "high",
            createdAt: "2026-11-26T07:12:00Z",
            linkPath: "/human-operator",
          },
        ],
        worktreeProposals: [
          {
            id: "wt-1",
            kind: "worktree_proposal",
            title: "Merge feat/s21-control-plane-ui",
            status: "pending",
            severity: "medium",
            createdAt: "2026-11-26T07:13:00Z",
            linkPath: "/worktree/proposals",
          },
          {
            id: "wt-2",
            kind: "worktree_proposal",
            title: "Merge feat/s21-control-plane-api",
            status: "pending",
            severity: "medium",
            createdAt: "2026-11-26T07:13:30Z",
            linkPath: "/worktree/proposals",
          },
        ],
        budgetIncidents: [
          {
            id: "bi-1",
            kind: "budget_incident",
            title: "Soft cap reached on Alpha Coder",
            status: "open",
            severity: "critical",
            createdAt: "2026-11-26T07:14:00Z",
            linkPath: "/costs",
          },
        ],
      },
      outcomes: {
        windowHours: 24,
        total: 23,
        succeeded: 18,
        failed: 2,
        cancelled: 0,
        timedOut: 0,
        running: 2,
        queued: 1,
        byAdapter: {
          claude_local: 14,
          codex_local: 9,
        },
        byProvider: {
          anthropic: 14,
          openai: 9,
        },
      },
      recentEvents: [
        {
          id: "ev-1",
          action: "approval_pending",
          entityType: "approval",
          entityId: "ap-1",
          actorType: "agent",
          createdAt: "2026-11-26T07:14:50Z",
          summary: "Requested production deploy approval",
        },
        {
          id: "ev-2",
          action: "run_succeeded",
          entityType: "heartbeat_run",
          entityId: "run-99",
          actorType: "agent",
          createdAt: "2026-11-26T07:13:20Z",
          summary: "Completed regression suite",
        },
      ],
    };

    render(<DgateMonitorPanel dgate={liveResponse} />);

    expect(container.querySelector('[data-testid="dgate-live-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("CONTROL PLANE LIVE");
    expect(container.textContent).toContain("PAPERWORK INTERNAL");
    expect(container.textContent).toContain("실행 중 워커");
    expect(container.textContent).toContain("대기 통제 게이트");
    expect(container.textContent).toContain("24h 성공률");
    expect(container.textContent).toContain("90%");
    expect(container.textContent).toContain("활성 에이전트");

    // Agent workers grid + click-through to /agents/:id
    expect(container.textContent).toContain("Alpha Coder");
    expect(container.textContent).toContain("Beta QA");
    expect(container.textContent).toContain("2m 15s");
    expect(container.textContent).toContain("claude_local");
    expect(container.textContent).toContain("Implementing internal control plane UI");
    const agentLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]')).map((a) =>
      a.getAttribute("href"),
    );
    expect(agentLinks).toContain("/agents/ag-101");
    expect(agentLinks).toContain("/agents/ag-102");

    // Internal Control Gates clickable routes + live titles
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="control-gate-approvals"]')?.getAttribute("href")).toBe("/approvals");
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="control-gate-owner-decisions"]')?.getAttribute("href")).toBe("/human-operator");
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="control-gate-worktree-proposals"]')?.getAttribute("href")).toBe("/worktree/proposals");
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="control-gate-budget-incidents"]')?.getAttribute("href")).toBe("/costs");
    expect(container.textContent).toContain("Approve production deploy");

    // Recent Control Events
    expect(container.textContent).toContain("Requested production deploy approval");
    expect(container.textContent).toContain("Completed regression suite");

    // Empty / unavailable payload still renders native control plane without any Mac dgate offline error
    const emptyResponse: DgateMonitorResponse = {
      available: false,
      fetchedAt: "2026-11-26T07:16:00Z",
      reason: "no snapshot yet",
      snapshot: null,
    };

    render(<DgateMonitorPanel dgate={emptyResponse} />);

    expect(container.querySelector('[data-testid="dgate-live-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dgate-offline-card"]')).toBeNull();
    expect(container.textContent).not.toContain("dgate 웹 모니터 미연결");
    expect(container.textContent).not.toContain("DGATE_WEB_URL");
    expect(container.textContent).not.toContain("POST /dashboard/dgate/snapshot");
    expect(container.textContent).toContain("현재 실행 중이거나 최근 실행된 에이전트 워커가 없습니다.");
  });
});

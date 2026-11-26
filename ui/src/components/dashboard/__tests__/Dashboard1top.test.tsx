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
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
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

  it("renders DgateMonitorPanel live snapshot and graceful offline fallback", () => {
    const liveResponse: DgateMonitorResponse = {
      available: true,
      sourceUrl: "http://127.0.0.1:4190",
      fetchedAt: "2026-11-26T07:15:00Z",
      stale: false,
      snapshot: {
        timestamp: "2026-11-26T07:14:58Z",
        scope: "paperwork-runtime",
        db_live: true,
        total_forks: 14,
        open_forks: 3,
        outcomes: { pass: 9, rework: 2, fail: 1, waiting_human: 2 },
        effort_level: "high",
        host_process_count: 5,
        mapped_count: 3,
        providers: [],
        repos: [],
        routes: [
          { route: "file_select", p: 0.86, mode: "sharp" },
          { route: "tool_select", p: 0.78, mode: "sharp" },
          { route: "retry_or_abort", p: 0.54, mode: "split" },
          { route: "delegate_swarm", p: 0.81, mode: "sharp" },
        ],
        active_gates: [
          { gate: "G1", status: "pass" },
          { gate: "G2", status: "pass" },
          { gate: "G3", status: "active" },
        ],
        lead: {
          slot: "L0",
          name: "lead-orchestrator",
          address: "hc-01",
          cli: "claude",
          model: "claude-opus-4-6",
          effort: "high",
          status: "active",
          repo_tag: "runtime",
          activity: "Coordinating dashboard telemetry rollout",
        },
        workers: [
          {
            slot: "W1",
            name: "worker-ui-charts",
            address: "hc-02",
            cli: "codex",
            model: "gpt-5.4",
            effort: "medium",
            status: "active",
            repo_tag: "ui",
            activity: "Building LiveSessionsTable & DgateMonitorPanel",
          },
        ],
        verifiers: [
          {
            slot: "V1",
            name: "verifier-vitest",
            address: "hc-03",
            cli: "pi",
            model: "gpt-5.4-mini",
            effort: "low",
            status: "idle",
            repo_tag: "ui",
            activity: "Waiting for build artifact",
          },
        ],
        advisors: [
          {
            slot: "A1",
            name: "advisor-g3",
            address: "hc-04",
            cli: "claude",
            model: "claude-opus-4-6",
            effort: "high",
            status: "idle",
            repo_tag: "runtime",
            activity: "Ready for merge gate review",
          },
        ],
        local_repo: {
          pipelines: [
            { name: "feat/dashboard-1top-charts", status: "running" },
            { name: "feat/dashboard-telemetry-api", status: "ready_pr" },
          ],
        },
        system: { cpu_pct: 38, mem_pct: 61, load_1m: 1.8 },
        recent_events: [
          { timestamp: "2026-11-26T07:14:50Z", kind: "dispatch", message: "Assigned Brief 3 to worker-ui-charts" },
        ],
      },
    };

    render(<DgateMonitorPanel dgate={liveResponse} />);

    expect(container.querySelector('[data-testid="dgate-live-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("dgate LIVE");
    expect(container.textContent).toContain("paperwork-runtime");
    expect(container.textContent).toContain("lead-orchestrator");
    expect(container.textContent).toContain("worker-ui-charts");
    expect(container.textContent).toContain("verifier-vitest");
    expect(container.textContent).toContain("advisor-g3");
    expect(container.textContent).toContain("file_select");
    expect(container.textContent).toContain("delegate_swarm");
    expect(container.textContent).toContain("G1");
    expect(container.textContent).toContain("G3");
    expect(container.textContent).toContain("feat/dashboard-1top-charts");
    expect(container.textContent).toContain("Assigned Brief 3 to worker-ui-charts");

    // Offline fallback
    const offlineResponse: DgateMonitorResponse = {
      available: false,
      fetchedAt: "2026-11-26T07:16:00Z",
      reason: "DGATE_WEB_URL is not configured on A1",
      snapshot: null,
    };

    render(<DgateMonitorPanel dgate={offlineResponse} />);

    expect(container.querySelector('[data-testid="dgate-offline-card"]')).not.toBeNull();
    expect(container.textContent).toContain("dgate 웹 모니터 미연결");
    expect(container.textContent).toContain("DGATE_WEB_URL is not configured on A1");
    expect(container.textContent).toContain("DGATE_WEB_URL");
    expect(container.textContent).toContain("POST /dashboard/dgate/snapshot");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Link as RouterLink } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";

vi.mock("@/lib/router", () => ({
  Link: RouterLink,
}));

import {
  AgentTelemetryCard,
  buildActivitySparklinePoints,
  computeBudgetMetrics,
  extractAgentModel,
  filterTelemetryAgents,
} from "../AgentTelemetryCard";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-11-26T08:00:00.000Z");
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "MainExec",
    urlKey: "main-exec",
    role: "engineer",
    title: "Core Execution Lead",
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-5" },
    agentConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 2000,
    spentMonthlyCents: 1500,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: now,
    defaultParentIssueId: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  const createdAt = new Date("2026-11-26T07:50:00.000Z");
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "timer",
    triggerDetail: "system",
    status: "succeeded",
    startedAt: new Date("2026-11-26T07:50:00.000Z"),
    finishedAt: new Date("2026-11-26T07:51:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: { inputTokens: 8000, outputTokens: 4000 },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function renderCard(ui: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("AgentTelemetryCard", () => {
  it("renders pulsing live status dot, adapter/model chips, and navigation links", () => {
    const agent = makeAgent();
    const html = renderCard(
      <AgentTelemetryCard
        agent={agent}
        roleLabel="Engineer"
        adapterLabel="Claude"
        detailHref="/agents/main-exec"
        liveRun={{ runId: "run-42", liveCount: 2, status: "running" }}
        liveRunHref="/agents/main-exec/runs/run-42"
        recentRuns={[
          makeRun({ id: "r1", usageJson: { totalTokens: 6000 } }),
          makeRun({ id: "r2", usageJson: { totalTokens: 12000 } }),
          makeRun({ id: "r3", usageJson: { totalTokens: 18000 } }),
        ]}
        usageShare={{ tokens: 36000, costCents: 1500, runs: 3, sharePct: 45 }}
      />,
    );

    expect(html).toContain('data-testid="agent-telemetry-card"');
    expect(html).toContain('data-testid="agent-status-dot"');
    expect(html).toContain('data-live="true"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("실행 중");
    expect(html).toContain("MainExec");
    expect(html).toContain("Engineer");
    expect(html).toContain("Core Execution Lead");
    expect(html).toContain("Claude");
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("36.0k");
    expect(html).toContain('href="/agents/main-exec"');
    expect(html).toContain('href="/agents/main-exec/runs/run-42"');
    expect(html).toContain("LIVE (2)");
  });

  it("renders inline SVG sparkline when runs exist and honest empty state when no runs exist", () => {
    const agent = makeAgent({ status: "idle", spentMonthlyCents: 0, budgetMonthlyCents: 0 });
    const withRunsHtml = renderCard(
      <AgentTelemetryCard
        agent={agent}
        roleLabel="Engineer"
        adapterLabel="Claude"
        detailHref="/agents/main-exec"
        recentRuns={[
          makeRun({ id: "r1", createdAt: new Date("2026-11-26T07:00:00Z"), usageJson: { totalTokens: 1000 } }),
          makeRun({ id: "r2", createdAt: new Date("2026-11-26T07:30:00Z"), usageJson: { totalTokens: 2500 } }),
        ]}
      />,
    );
    expect(withRunsHtml).toContain('data-testid="agent-sparkline-svg"');
    expect(withRunsHtml).toContain("<path");
    expect(withRunsHtml).toContain("<circle");

    const emptyHtml = renderCard(
      <AgentTelemetryCard
        agent={agent}
        roleLabel="Engineer"
        adapterLabel="Claude"
        detailHref="/agents/main-exec"
        recentRuns={[]}
      />,
    );
    expect(emptyHtml).toContain('data-testid="agent-sparkline-empty"');
    expect(emptyHtml).toContain("최근 실행 기록 없음");
    expect(emptyHtml).not.toContain('data-testid="agent-sparkline-svg"');
  });

  it("renders 20-dot budget bar and mini radial meter accurately", () => {
    const agent = makeAgent({
      status: "active",
      budgetMonthlyCents: 2000,
      spentMonthlyCents: 1500, // 75% => 15 / 20 dots
    });
    const html = renderCard(
      <AgentTelemetryCard
        agent={agent}
        roleLabel="Engineer"
        adapterLabel="Claude"
        detailHref="/agents/main-exec"
      />,
    );

    expect(html).toContain('data-testid="agent-radial-meter"');
    expect(html).toContain("75%");
    expect(html).toContain('data-testid="agent-dot-bar"');
    expect(html).toContain('data-filled-dots="15"');
    expect(html).toContain("$15.00 / $20.00");
    expect(html).toContain("15/20");

    const filledCount = (html.match(/data-filled="true"/g) ?? []).length;
    const emptyCount = (html.match(/data-filled="false"/g) ?? []).length;
    expect(filledCount).toBe(15);
    expect(emptyCount).toBe(5);
    expect(filledCount + emptyCount).toBe(20);
  });

  it("handles unset budget without fabricating percentages", () => {
    const metrics = computeBudgetMetrics(420, 0);
    expect(metrics.hasBudget).toBe(false);
    expect(metrics.utilizationPct).toBeNull();
    expect(metrics.filledDots).toBe(0);

    const points = buildActivitySparklinePoints([]);
    expect(points).toEqual([]);
  });

  it("filters agents cleanly by status, search query (including model), adapter, and role", () => {
    const agents: Agent[] = [
      makeAgent({
        id: "a1",
        name: "MainExec",
        role: "engineer",
        status: "running",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-4-1" },
      }),
      makeAgent({
        id: "a2",
        name: "QAWatcher",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      }),
      makeAgent({
        id: "a3",
        name: "PausedOps",
        role: "devops",
        status: "paused",
        adapterType: "hermes_local",
        adapterConfig: {},
      }),
      makeAgent({
        id: "a4",
        name: "BrokenBot",
        role: "engineer",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
      }),
      makeAgent({
        id: "a5",
        name: "RetiredBot",
        role: "general",
        status: "terminated",
        adapterType: "process",
        adapterConfig: {},
      }),
    ];

    expect(extractAgentModel(agents[0]!)).toBe("claude-opus-4-1");

    // Default "all" excludes terminated
    expect(
      filterTelemetryAgents(agents, {
        status: "all",
        query: "",
        adapter: "all",
        role: "all",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a1", "a2", "a3", "a4"]);

    // "running" filter
    expect(
      filterTelemetryAgents(agents, {
        status: "running",
        query: "",
        adapter: "all",
        role: "all",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a1"]);

    // "idle" filter
    expect(
      filterTelemetryAgents(agents, {
        status: "idle",
        query: "",
        adapter: "all",
        role: "all",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a2"]);

    // "attention" (paused + error)
    expect(
      filterTelemetryAgents(agents, {
        status: "attention",
        query: "",
        adapter: "all",
        role: "all",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a3", "a4"]);

    // Search by model name
    expect(
      filterTelemetryAgents(agents, {
        status: "all",
        query: "gpt-5.4",
        adapter: "all",
        role: "all",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a2"]);

    // Adapter + Role combined filter
    expect(
      filterTelemetryAgents(agents, {
        status: "all",
        query: "",
        adapter: "codex_local",
        role: "engineer",
        showTerminated: false,
      }).map((a) => a.id),
    ).toEqual(["a4"]);
  });
});

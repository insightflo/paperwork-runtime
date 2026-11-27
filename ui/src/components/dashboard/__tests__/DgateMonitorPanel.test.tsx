/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DgateDashboardBridgeResponse } from "@/api/dashboard";
import { DgateMonitorPanel, type DgateMonitorResponse } from "../DgateMonitorPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; [k: string]: unknown }) => <a href={to} {...rest}>{children}</a>,
}));

const DISCONNECTED_MARKERS = ["미연결", "dgate 웹 모니터", "DGATE_WEB_URL", "POST /dashboard/dgate/snapshot"];
const GATE_KEYS = ["approvals", "owner-decisions", "worktree-proposals", "budget-incidents"];
const EMPTY_WORKERS_TEXT = "현재 실행 중이거나 최근 실행된 에이전트 워커가 없습니다.";
const EMPTY_EVENTS_TEXT = "최근 통제 이벤트가 없습니다.";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

async function waitFor(assertion: () => void, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
}

function text(query: string): string | null {
  return container.querySelector(query)?.textContent ?? null;
}

function kpiCells(): string[] {
  const strip = container.querySelector('[data-testid="control-plane-kpi-strip"]');
  return Array.from(strip?.children ?? []).map((cell) => cell.textContent ?? "");
}

function expectText(labels: string[]) {
  for (const label of labels) expect(container.textContent).toContain(label);
}

function expectNoDisconnectedBanner() {
  expect(container.querySelector('[data-testid="dgate-offline-card"]')).toBeNull();
  for (const marker of DISCONNECTED_MARKERS) expect(container.textContent).not.toContain(marker);
}

function expectIdleFrame() {
  expect(container.querySelector('[data-testid="dgate-live-panel"]')).not.toBeNull();
  expectText([EMPTY_WORKERS_TEXT, EMPTY_EVENTS_TEXT]);
  expect(container.querySelectorAll('[data-testid^="control-plane-worker-"]')).toHaveLength(0);
  for (const key of GATE_KEYS) expect(text(`[data-testid="control-gate-${key}"]`)).toMatch(/0$/);
  expect(kpiCells()[1]).toContain("모두 정상");
  expectNoDisconnectedBanner();
}

function liveResponse(): DgateMonitorResponse {
  const gate = (id: string, kind: string, title: string) => ({ id, kind, title, status: "pending" });
  return {
    connected: true,
    source: "paperwork_internal",
    timestamp: "2026-11-26T07:14:58Z",
    summary: {
      activeRuns: 2, queuedRuns: 1, activeAgents: 4, totalAgents: 6,
      pendingApprovals: 2, pendingDecisions: 1, openBudgetIncidents: 1, pendingWorktreeProposals: 2, passRatePct: 90,
    },
    workers: [
      {
        runId: "run-101", agentId: "ag-101", agentName: "Alpha Coder", role: "engineer", status: "running",
        adapterType: "claude_local", model: "claude-sonnet-4-6", durationMs: 135_000, issueIdentifier: "PW-101",
        contextLabel: "Implementing internal control plane UI",
      },
      {
        runId: "run-102", agentId: "ag-102", agentName: "Beta QA", role: "qa", status: "queued",
        adapterType: "codex_local", model: "gpt-5.4", durationMs: 45_000, contextLabel: "Queued for verification pass",
      },
    ],
    gates: {
      approvals: [gate("ap-1", "approval", "Approve production deploy")],
      operatorDecisions: [gate("dec-1", "operator_decision", "Confirm Wave 2 release timing")],
      worktreeProposals: [gate("wt-1", "worktree_proposal", "Merge feat/s22-ui"), gate("wt-2", "worktree_proposal", "Merge feat/s22-api")],
      budgetIncidents: [gate("bi-1", "budget_incident", "Soft cap reached on Alpha Coder")],
    },
    outcomes: { windowHours: 24, total: 23, succeeded: 18, failed: 2, running: 2, queued: 1 },
    adapters: [
      { adapterType: "claude_local", model: "claude-sonnet-4-6", runs: 14, succeeded: 12, failed: 1, running: 1 },
      { adapterType: "codex_local", model: "gpt-5.4", runs: 9, succeeded: 6, failed: 1, running: 1 },
    ],
    recentEvents: [
      { id: "ev-1", action: "approval_pending", createdAt: "2026-11-26T07:14:50Z", summary: "Requested production deploy approval" },
      { id: "ev-2", action: "run_succeeded", createdAt: "2026-11-26T07:13:20Z", agentName: "Beta QA", summary: "Completed regression suite" },
      { id: "ev-3", kind: "budget_warning", createdAt: "2026-11-26T07:12:00Z", summary: "Soft cap at 85%" },
    ],
  };
}

describe("DgateMonitorPanel (paperwork_internal)", () => {
  it("renders live workers, gates, outcomes and recent events without any disconnected banner", () => {
    render(<DgateMonitorPanel dgate={liveResponse()} />);

    expect(container.querySelector('[data-testid="dgate-live-panel"]')).not.toBeNull();
    expectText(["CONTROL PLANE LIVE", "paperwork-internal", "PAPERWORK INTERNAL", "DB LIVE"]);
    expectNoDisconnectedBanner();

    // KPI strip: running workers, pending gates, success rate, active agents
    const cells = kpiCells();
    expect(cells).toHaveLength(4);
    for (const [index, label] of [[0, "실행 중 워커2"], [0, "대기 1"], [1, "대기 통제 게이트6"], [1, "검토 필요"], [2, "24h 성공률90%"], [2, "18/20 완료"], [3, "활성 에이전트4"], [3, "/ 6 등록"]] as Array<[number, string]>) {
      expect(cells[index]).toContain(label);
    }

    // Workers grid: active sorted first, role badge, status pill, adapter/model, duration, issue
    expectText(["2 running · 2 recent"]);
    const workerIds = Array.from(container.querySelectorAll('[data-testid^="control-plane-worker-"]')).map((el) => el.getAttribute("data-testid"));
    expect(workerIds).toEqual(["control-plane-worker-run-101", "control-plane-worker-run-102"]);
    const first = text('[data-testid="control-plane-worker-run-101"]') ?? "";
    for (const label of ["ENGINEER", "Alpha Coder", "running", "claude_local · claude-sonnet-4-6", "2m 15s", "PW-101"]) expect(first).toContain(label);
    expect(text('[data-testid="control-plane-worker-run-102"]')).toContain("queued");
    const agentHrefs = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]')).map((a) => a.getAttribute("href"));
    expect(agentHrefs).toEqual(["/agents/ag-101", "/agents/ag-102"]);

    // Gates: per-gate pending counts (2/1/2/1 = 6) and top titles
    expectText(["6 pending"]);
    const expectedGates: Array<[string, RegExp]> = [
      ["approvals", /^승인 대기.*2$/], ["owner-decisions", /^오너 의사결정.*1$/],
      ["worktree-proposals", /^워크트리 제안.*2$/], ["budget-incidents", /^예산 인시던트.*1$/],
    ];
    for (const [key, pattern] of expectedGates) expect(text(`[data-testid="control-gate-${key}"]`)).toMatch(pattern);
    expectText(["Approve production deploy", "Confirm Wave 2 release timing", "Merge feat/s22-ui", "Soft cap reached on Alpha Coder"]);

    // 24h outcomes + provider routing
    expectText(["성공 18", "실행 2", "대기 1", "실패 2", "14 runs · 61%", "9 runs · 39%"]);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("24시간 실행 결과: 성공 18, 실행 2, 대기 1, 실패 2");

    // Recent control events feed
    expectText(["Recent Control Events", "approval_pending", "Requested production deploy approval", "run_succeeded", "Beta QA: Completed regression suite", "budget_warning"]);
    expectNoDisconnectedBanner();
  });

  it("renders an idle state when workers and recent events are empty", () => {
    const idle: DgateMonitorResponse = {
      connected: true,
      source: "paperwork_internal",
      timestamp: "2026-11-26T07:16:00Z",
      workers: [],
      recentEvents: [],
      outcomes: { total: 0, succeeded: 0, failed: 0, running: 0, queued: 0 },
    };
    render(<DgateMonitorPanel dgate={idle} />);

    expectText(["CONTROL PLANE LIVE", "DB LIVE", "0 running · 0 recent", "최근 24시간 어댑터 라우팅 집계 없음"]);
    const [idleRunning, , idleRate, idleAgents] = kpiCells();
    for (const cell of [idleRunning, idleRate, idleAgents]) expect(cell ?? "").not.toContain("undefined");
    expect(idleRunning).toContain("실행 중 워커0");
    expect(idleRate).toContain("24h 성공률—");
    expect(idleAgents).toContain("활성 에이전트0");
    expectIdleFrame();

    // Missing payload (no company selected / nothing fetched yet) degrades to the same idle frame
    render(<DgateMonitorPanel dgate={null} />);
    expectIdleFrame();
  });

  it("renders the idle frame cleanly when the dashboard dgate query fails", () => {
    const queryKey = ["dashboard", "company-1", "dgate"] as const;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi.fn(async (): Promise<DgateDashboardBridgeResponse> => {
      throw new Error("Request failed with status code 500");
    });

    // Mirrors the Dashboard wiring: data ?? null, loading only while there is nothing to show.
    function Harness() {
      const { data, isLoading, error } = useQuery({ queryKey, queryFn });
      return (
        <>
          <output data-testid="harness-state">{error ? "error" : isLoading ? "loading" : "success"}</output>
          <DgateMonitorPanel dgate={data ?? null} loading={isLoading && !data} />
        </>
      );
    }

    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);

    return waitFor(() => {
      expect(queryClient.getQueryState(queryKey)?.status).toBe("error");
      expect(text('[data-testid="harness-state"]')).toBe("error");
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
      expect(container.textContent).not.toContain("status code 500");
      expect(text('[data-testid="harness-state"]')).not.toContain("loading");
      expectIdleFrame();
    });
  });
});

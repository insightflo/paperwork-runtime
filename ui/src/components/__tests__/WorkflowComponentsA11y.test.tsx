/** @vitest-environment jsdom */
// Workflow component a11y (Front-End-Checklist: named controls, ARIA, feedback banners).
// Asserts accessible names, button types and announced feedback surfaces for
// WorkflowDagPanel, MissionExecutionOverview and HumanReviewPacket.
// Visual layout and behavior unchanged.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDagPanel } from "../WorkflowDagPanel";
import { MissionExecutionOverview } from "../MissionExecutionOverview";
import { HumanReviewPacket } from "../HumanReviewPacket";
import { agentsApi } from "../../api/agents";
import { missionsApi } from "../../api/missions";
import { openWorkProductInBrowser } from "../../lib/workProductOpen";
import type { HumanReviewPacket as HumanReviewPacketValue } from "@paperclipai/shared";
import type { MissionDetailItem, MissionWorkflowRun, MissionWorkflowStep } from "../../api/missions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
}));
vi.mock("../../lib/router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
}));
vi.mock("../../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/CompanyContext")>()),
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1", name: "테스트" }], canWrite: true, canAdmin: true }),
}));
vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [{ id: "agent-1", name: "에이전트 알파" }]),
    runtimeState: vi.fn(async () => null),
  },
}));
vi.mock("../../api/missions", () => ({
  missionsApi: {
    listWorkflowRuns: vi.fn(async () => [RUN]),
    listIssues: vi.fn(async () => []),
    listAgents: vi.fn(async () => [{ agentId: "agent-1", role: "owner" as const }]),
    grantQaReworkCapBoost: vi.fn(async () => undefined),
    workflowRunFlowmapDownloadPath: vi.fn(() => "/api/missions/m-1/workflow-runs/run-1/flowmap"),
  },
}));
vi.mock("../../lib/workProductOpen", () => ({ openWorkProductInBrowser: vi.fn(async () => undefined) }));
vi.mock("../MissionGovernanceThreadPanel", () => ({ MissionGovernanceThreadPanel: () => null }));
vi.mock("../MissionDecisionLogPanel", () => ({ MissionDecisionLogPanel: () => null }));

const STEP: MissionWorkflowStep = {
  stepId: "step-1",
  name: "증상 수집",
  type: "agent",
  agentId: "agent-1",
  dependencies: [],
  description: null,
  toolNames: [],
  knowledgeBaseIds: [],
  status: "failed",
  issueId: "issue-1",
  issue: { id: "issue-1", identifier: "TST-1", title: "증상 수집 실패", status: "in_progress", assigneeAgentId: "agent-1" },
  workProducts: [{
    id: "wp-1",
    title: "수집 요약",
    type: "summary",
    url: null,
    status: "completed",
    summary: null,
    isPrimary: false,
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
  }],
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:10:00Z",
  stepRunId: "step-run-1",
  iterationIndex: 1,
  reworkCap: 1,
};

const RUN: MissionWorkflowRun = {
  id: "run-1",
  workflowId: "wf-1",
  companyId: "company-1",
  missionId: "m-1",
  status: "running",
  triggeredBy: "operator",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  workflowName: "기본 워크플로",
  stepRuns: [],
  steps: [STEP],
  progress: { totalSteps: 1, pendingSteps: 0, runningSteps: 0, completedSteps: 0, failedSteps: 1, skippedSteps: 0 },
};

const MISSION: MissionDetailItem = {
  id: "m-1",
  companyId: "company-1",
  ownerAgentId: "agent-1",
  title: "테스트 미션",
  description: null,
  status: "active",
  goalId: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  agents: [{ agentId: "agent-1", role: "owner" }],
  sessionBindings: [],
};

const PACKET: HumanReviewPacketValue = {
  schemaVersion: "human-review-v1",
  symptom: null,
  decisionSubject: "재시작 승인",
  evidence: [{ label: "이슈 본문", href: "/issues/TST-1", location: "L12-L18", description: null }],
  interpretation: "수집 단계가 반복 실패해 재시작이 필요합니다.",
  impact: { ifApproved: "다음 단계를 재시작합니다.", ifRejected: "보류합니다.", ifWrong: "비용이 낭비됩니다." },
  unresolvedFacts: [],
  questions: [],
  recommendedNextStep: "재시작을 승인해 주세요.",
  requiredReviewer: "미션 오너",
};

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
async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("WorkflowDagPanel a11y", () => {
  it("exposes the named view toggle and labeled graph step buttons", async () => {
    await mount(<WorkflowDagPanel missionId="m-1" />);
    const group = container.querySelector('[role="group"][aria-label="Execution flow view"]');
    expect(group).toBeTruthy();
    const toggles = [...(group?.querySelectorAll("button") ?? [])];
    expect(toggles.length).toBe(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute("type")).toBe("button");
      expect(toggle.getAttribute("aria-pressed")).toBeTruthy();
      expect((toggle.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    const node = container.querySelector('button[title="증상 수집"]');
    expect(node?.getAttribute("type")).toBe("button");
    expect(node?.getAttribute("aria-pressed")).toBe("false");
    expect((node?.textContent ?? "").includes("증상 수집")).toBe(true);
  });

  it("announces the workflow run query error", async () => {
    (missionsApi.listWorkflowRuns as Mock).mockRejectedValueOnce(new Error("워크플로 조회 실패"));
    await mount(<WorkflowDagPanel missionId="m-1" />);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("Failed to load workflow runs.");
  });

  it("names the cap boost inputs and announces boost success politely", async () => {
    await mount(<WorkflowDagPanel missionId="m-1" />);
    await click(container.querySelector('button[title="증상 수집"]')!);
    expect(container.querySelector('input[aria-label="Boost amount"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Boost reason"]')).toBeTruthy();
    const grant = [...container.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Grant")!;
    await click(grant);
    expect(container.querySelector('p[aria-live="polite"]')?.textContent).toContain("Cap boost granted");
    expect(missionsApi.grantQaReworkCapBoost).toHaveBeenCalled();
  });

  it("announces boost failures with role=alert", async () => {
    (missionsApi.grantQaReworkCapBoost as Mock).mockRejectedValueOnce(new Error("부스트 거부"));
    await mount(<WorkflowDagPanel missionId="m-1" />);
    await click(container.querySelector('button[title="증상 수집"]')!);
    const grant = [...container.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Grant")!;
    await click(grant);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("부스트 거부");
  });

  it("announces work product open status and failures", async () => {
    await mount(<WorkflowDagPanel missionId="m-1" />);
    await click(container.querySelector('button[title="증상 수집"]')!);
    const open = [...container.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Open")!;
    await click(open);
    expect(container.querySelector('p[aria-live="polite"]')?.textContent).toContain("Opened");
    (openWorkProductInBrowser as Mock).mockRejectedValueOnce(new Error("열기 실패"));
    await click(open);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("Open failed");
  });
});

describe("MissionExecutionOverview a11y", () => {
  it("announces the primary query error", async () => {
    (agentsApi.list as Mock).mockRejectedValueOnce(new Error("에이전트 조회 실패"));
    await mount(<MissionExecutionOverview missionId="m-1" mission={MISSION} />);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("에이전트 조회 실패");
  });

  it("announces runtime state errors in the continuity section", async () => {
    (agentsApi.runtimeState as Mock).mockRejectedValueOnce(new Error("런타임 상태 조회 실패"));
    await mount(<MissionExecutionOverview missionId="m-1" mission={MISSION} />);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("런타임 상태 조회 실패");
  });

  it("announces work product open status and failures", async () => {
    await mount(<MissionExecutionOverview missionId="m-1" mission={MISSION} />);
    const open = container.querySelector('button[title="Open in your browser"]')!;
    expect(open.getAttribute("type")).toBe("button");
    expect((open.textContent ?? "").trim().length).toBeGreaterThan(0);
    await click(open);
    expect(container.querySelector('p[aria-live="polite"]')?.textContent).toContain("Opened");
    (openWorkProductInBrowser as Mock).mockRejectedValueOnce(new Error("열기 실패"));
    await click(open);
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain("열기 실패");
  });
});

describe("HumanReviewPacket a11y", () => {
  it("announces the incomplete-packet warning banner", async () => {
    await mount(<HumanReviewPacket packet={null} />);
    const banner = container.querySelector('section[data-testid="human-review-incomplete"][role="alert"]');
    expect(banner?.textContent).toContain("Insufficient review information to approve");
  });

  it("renders the full packet without unlabeled interactive controls", async () => {
    await mount(<HumanReviewPacket packet={PACKET} />);
    expect(container.querySelector('[data-testid="human-review-packet"]')).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input,select,textarea")).toBeNull();
    expect(container.querySelector('p[role="alert"]')).toBeNull();
  });
});

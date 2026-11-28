/** @vitest-environment jsdom */
// Agent-detail component a11y (Front-End-Checklist: named icon-only controls,
// labeled form controls, announced error/status banners). Asserts aria
// attributes only — visual layout and behavior are unchanged.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigurePage } from "../ConfigureViews";
import { LogViewer } from "../LogViewer";
import { PromptsTab } from "../PromptsTab";
import type { Agent, AgentDetail as AgentDetailRecord, HeartbeatRun } from "@paperclipai/shared";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noop = () => {};
const stubCallbacks = {
  onDirtyChange: noop,
  onSaveActionChange: noop,
  onCancelActionChange: noop,
  onSavingChange: noop,
};

vi.mock("../../../api/heartbeats", () => ({
  heartbeatsApi: {
    events: vi.fn(async () => []),
    workspaceOperations: vi.fn(async () => []),
    log: vi.fn(async () => {
      throw new Error("런 로그 조회에 실패했습니다");
    }),
    liveRunsForCompany: vi.fn(async () => []),
  },
}));
vi.mock("../../../api/instanceSettings", () => ({
  instanceSettingsApi: { getGeneral: vi.fn(async () => ({})) },
}));
vi.mock("../../../adapters", () => ({
  getUIAdapter: () => ({ parseStdoutLine: () => null }),
  buildTranscript: () => [],
}));
vi.mock("../../transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => <div data-testid="transcript-stub" />,
}));
vi.mock("../../../pages/agent-detail-workspace-operations", () => ({
  WorkspaceOperationsSection: () => null,
}));
vi.mock("../../../api/agents", () => ({
  agentsApi: {
    listConfigRevisions: vi.fn(async () => []),
    adapterModels: vi.fn(async () => []),
    listKeys: vi.fn(async () => []),
    rollbackConfigRevision: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    createKey: vi.fn(async () => ({})),
    revokeKey: vi.fn(async () => ({})),
    instructionsBundle: vi.fn(async () => ({
      mode: "managed",
      rootPath: "/repo",
      entryFile: "AGENTS.md",
      files: [
        { path: "AGENTS.md", version: 1 },
        { path: "run.sh", version: 1 },
      ],
    })),
    instructionsFile: vi.fn(async (_agentId: string, path: string) => ({
      path,
      content: "echo hi",
      version: 1,
    })),
  },
}));
vi.mock("../../../api/assets", () => ({
  assetsApi: { upload: vi.fn(async () => "") },
}));
vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../../AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="config-form-stub" />,
}));
vi.mock("../../MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="md-editor-stub" />,
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
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("agent-detail a11y", () => {
  it("names the icon-only permission switch buttons", async () => {
    const agent = {
      id: "agent-1",
      urlKey: "agent-1",
      name: "알파",
      adapterType: "pi_local",
      status: "running",
      role: "manager",
      permissions: { canCreateAgents: true },
      access: { canAssignTasks: false },
    } as unknown as AgentDetailRecord;
    await mount(
      <AgentConfigurePage
        agent={agent}
        agentId="agent-1"
        companyId="company-1"
        {...stubCallbacks}
        updatePermissions={{ mutate: noop, isPending: false }}
      />,
    );
    const switches = container.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
    expect(switches.length).toBe(2);
    for (const sw of switches) {
      expect(sw.getAttribute("type")).toBe("button");
      expect(sw.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
      expect(sw.getAttribute("aria-checked")).toBeTruthy();
    }
    expect(switches[0]!.getAttribute("aria-label")).not.toBe(switches[1]!.getAttribute("aria-label"));
  });

  it("labels the file contents textarea for non-markdown files", async () => {
    const agent = {
      id: "agent-1",
      name: "알파",
      adapterType: "pi_local",
      status: "running",
      role: "manager",
    } as unknown as Agent;
    await mount(<PromptsTab agent={agent} companyId="company-1" {...stubCallbacks} />);
    const scriptButton = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("run.sh"));
    expect(scriptButton).toBeTruthy();
    await act(async () => { scriptButton!.click(); });
    await flush();
    await flush();
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(textarea!.getAttribute("aria-label")).toBe("File contents");
  });

  it("announces log load errors and the failure details banner", async () => {
    const run = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "failed",
      logRef: "logs/run-1",
      error: "boom",
      stderrExcerpt: "boom: exit 1",
      exitCode: 1,
    } as unknown as HeartbeatRun;
    await mount(<LogViewer run={run} adapterType="pi_local" />);
    await flush();
    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts.some((el) => el.textContent?.includes("런 로그 조회에 실패했습니다"))).toBe(true);
    expect(alerts.some((el) => el.textContent?.includes("Failure details"))).toBe(true);
  });
});

/** @vitest-environment jsdom */
// Complex-form a11y (Front-End-Checklist: complex forms) for AgentConfigForm and
// OnboardingWizard. Asserts explicit accessible names on form inputs, typed and
// named step-navigation/icon buttons, alert semantics for errors and polite live
// regions for status messages. Visual layout and behavior unchanged.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestResult, Agent, Company } from "@paperclipai/shared";
import { AgentConfigForm } from "../AgentConfigForm";
import { OnboardingWizard } from "../OnboardingWizard";
import { agentsApi } from "../../api/agents";
import { companiesApi } from "../../api/companies";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const AGENT = {
  id: "agent-1",
  name: "CEO 에이전트",
  title: "CEO",
  role: "ceo",
  status: "running",
  adapterType: "claude_local",
  adapterConfig: {},
  agentConfig: {},
  runtimeConfig: {},
  metadata: {},
} as unknown as Agent;

const PASS_RESULT: AdapterEnvironmentTestResult = {
  adapterType: "claude_local",
  status: "pass",
  checks: [],
  testedAt: "2026-01-01T00:00:00Z",
};

const CREATED_COMPANY = {
  id: "company-1",
  name: "테스트",
  issuePrefix: "TST",
} as unknown as Company;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
}));
vi.mock("../../context/DialogContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/DialogContext")>()),
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: {},
    openOnboarding: vi.fn(),
    closeOnboarding: vi.fn(),
  }),
}));
vi.mock("../../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/CompanyContext")>()),
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", name: "테스트", issuePrefix: "TST" }],
    setSelectedCompanyId: vi.fn(),
    loading: false,
    canWrite: true,
    canAdmin: true,
  }),
}));
vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "agent-1" })),
    update: vi.fn(async () => ({})),
    adapterModels: vi.fn(async () => []),
    testEnvironment: vi.fn(async () => PASS_RESULT),
  },
}));
vi.mock("../../api/companies", () => ({
  companiesApi: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "company-1", name: "테스트", issuePrefix: "TST" })),
  },
}));
vi.mock("../../api/issues", () => ({
  issuesApi: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "issue-1", identifier: "TST-1" })),
  },
}));
vi.mock("../../api/secrets", () => ({
  secretsApi: { list: vi.fn(async () => []), create: vi.fn(async () => ({})) },
}));
vi.mock("../../api/instanceSettings", () => ({
  instanceSettingsApi: { getUsageLimitGate: vi.fn(async () => null) },
}));
vi.mock("../../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn(async () => ({ contentPath: "assets/x.png" })) },
}));
vi.mock("../../adapters", () => ({
  getUIAdapter: () => ({
    label: "Claude (local)",
    buildAdapterConfig: () => ({ adapterType: "claude_local" }),
    ConfigFields: () => null,
  }),
  listUIAdapters: () => [],
}));
vi.mock("../../adapters/claude-local/config-fields", () => ({
  ClaudeLocalAdvancedFields: () => null,
}));
vi.mock("../../adapters/commandcode-local/config-fields", () => ({
  CommandCodeLocalAdvancedFields: () => null,
}));
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("../ReportsToPicker", () => ({ ReportsToPicker: () => null }));
vi.mock("../AgentFallbackChainEditor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AgentFallbackChainEditor")>()),
  AgentFallbackChainEditor: () => null,
}));
vi.mock("../agent-settings/AgentPermissionsFoldersTab", () => ({
  AgentPermissionsFoldersTab: () => null,
}));
vi.mock("../agent-settings/AgentBehaviorTab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-settings/AgentBehaviorTab")>()),
  AgentBehaviorTab: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../agent-config-form-fields", () => ({
  AdapterTypeDropdown: ({ value }: { value?: string }) => (
    <div data-testid="adapter-type">{String(value)}</div>
  ),
  AdapterEnvironmentResult: () => null,
  EnvVarEditor: () => null,
  ModelDropdown: ({ value }: { value?: string }) => (
    <div data-testid="model-dropdown">{String(value)}</div>
  ),
  ThinkingEffortDropdown: () => null,
}));
vi.mock("../PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("../../hooks/useAdapterModelEfforts", () => ({
  useAdapterModelEfforts: () => ({ data: [], isSuccess: true }),
}));
vi.mock("../AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));

const container = document.createElement("div");
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(ui: ReactNode) {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </TooltipProvider>,
    );
  });
  await flush();
  await flush();
}

function click(element: Element | null | undefined) {
  expect(element, "click target must exist").toBeTruthy();
  act(() => {
    (element as HTMLElement).click();
  });
}

/** React-controlled input typing: native value setter + bubbling input event. */
function type(element: Element, value: string) {
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonWithText(text: string, scope: ParentNode = container) {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset queued once-implementations from earlier tests, then re-prime defaults.
  vi.mocked(agentsApi.testEnvironment).mockReset().mockResolvedValue(PASS_RESULT);
  vi.mocked(companiesApi.create).mockReset().mockResolvedValue(CREATED_COMPANY);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
  document.body.innerHTML = "";
});

describe("AgentConfigForm a11y", () => {
  it("names remediated inputs and types the settings tablist", async () => {
    await mount(<AgentConfigForm mode="edit" agent={AGENT} onSave={vi.fn()} />);

    const tablist = container.querySelector('[role="tablist"][aria-label="Agent settings sections"]');
    expect(tablist).toBeTruthy();
    const tabs = [...(tablist?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      expect(tab.getAttribute("type")).toBe("button");
      expect(tab.getAttribute("aria-selected")).toBeTruthy();
    }

    expect(container.querySelector('input[aria-label="Agent name"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="Agent title"]')).toBeTruthy();
    expect(buttonWithText("Test environment")?.getAttribute("type")).toBe("button");
  });

  it("announces the unsaved-changes bar politely with a text save button", async () => {
    await mount(<AgentConfigForm mode="edit" agent={AGENT} onSave={vi.fn()} />);

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Agent name"]');
    expect(nameInput).toBeTruthy();
    type(nameInput!, "이름 변경");

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Unsaved changes");
    expect(live?.querySelector("button")?.textContent).toBe("Save");
  });

  it("announces adapter-environment failures as alerts", async () => {
    (agentsApi.testEnvironment as Mock).mockRejectedValueOnce(new Error("환경 점검 실패"));
    await mount(<AgentConfigForm mode="edit" agent={AGENT} onSave={vi.fn()} />);

    click(buttonWithText("Test environment"));
    await flush();
    await flush();

    expect(container.querySelector('div[role="alert"]')?.textContent).toContain("환경 점검 실패");
  });
});

describe("OnboardingWizard a11y", () => {
  it("labels every wizard input and types navigation buttons", async () => {
    await mount(<OnboardingWizard />);

    const close = document.querySelector('button[aria-label="Close onboarding"]');
    expect(close?.getAttribute("type")).toBe("button");

    const tabs = [...document.querySelectorAll('button[aria-label^="Go to step"]')];
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      expect(tab.getAttribute("type")).toBe("button");
    }
    expect(tabs[0]?.getAttribute("aria-current")).toBe("step");

    expect(document.querySelector('label[for="onboarding-company-name"]')?.textContent).toContain("Company name");
    expect(document.querySelector("input#onboarding-company-name")).toBeTruthy();

    click(tabs[1]);
    await flush();

    expect(document.querySelector('label[for="onboarding-agent-name"]')?.textContent).toContain("Agent name");
    expect(document.querySelector("input#onboarding-agent-name")).toBeTruthy();

    const group = document.querySelector(
      '[role="group"][aria-labelledby="onboarding-adapter-type-label"]',
    );
    expect(group).toBeTruthy();
    expect(group?.querySelectorAll("button[aria-pressed]").length).toBe(2);

    const more = document.querySelector('button[aria-controls="onboarding-more-adapters"]');
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    click(more);
    await flush();
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("onboarding-more-adapters")?.querySelectorAll("button[aria-pressed]").length).toBe(3);

    const modelTrigger = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Default"),
    );
    click(modelTrigger);
    await flush();
    expect(document.querySelector('input[aria-label="Search models"]')).toBeTruthy();

    const step3 = document.querySelector('button[aria-label="Go to step 3: Work"]');
    click(step3);
    await flush();

    expect(document.querySelector('label[for="onboarding-task-title"]')?.textContent).toContain("Work item title");
    expect(document.querySelector("input#onboarding-task-title")).toBeTruthy();
    expect(document.querySelector('label[for="onboarding-task-description"]')?.textContent).toContain("Description");
    expect(document.querySelector("textarea#onboarding-task-description")).toBeTruthy();
  });

  it("announces step errors as alerts and environment results politely", async () => {
    (companiesApi.create as Mock).mockRejectedValueOnce(new Error("회사 생성 실패"));
    await mount(<OnboardingWizard />);

    type(document.querySelector("input#onboarding-company-name")!, "테스트사");
    click(buttonWithText("Next", document));
    await flush();
    await flush();

    expect(document.querySelector('p[role="alert"]')?.textContent).toContain("회사 생성 실패");

    click(buttonWithText("Next", document));
    await flush();
    await flush();

    click(buttonWithText("Test now", document));
    await flush();
    await flush();

    const status = document.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain("Passed");
  });
});

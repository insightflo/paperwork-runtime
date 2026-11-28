/** @vitest-environment jsdom */
// A11y regression guard for Missions / CompanySettings / Workflows pages
// (Front-End-Checklist: icon-only buttons need aria-label + type="button",
// form controls need accessible names, dynamic error/status feedback needs
// role="alert" or role="status"). Visual layout is intentionally untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Missions } from "../Missions";
import { CompanySettings } from "../CompanySettings";
import { Workflows } from "../Workflows";
import { TooltipProvider } from "@/components/ui/tooltip";
import { missionsApi } from "../../api/missions";
import { companiesApi } from "../../api/companies";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = {
  id: "company-1",
  name: "Acme",
  description: null,
  brandColor: null,
  timezone: null,
  logoUrl: null,
  defaultLanguage: "en",
  requireBoardApprovalForNewAgents: false,
  issuePrefix: "ACM",
  status: "active",
};
const MISSIONS = [
  {
    id: "mission-1", companyId: "company-1", ownerAgentId: "agent-1", title: "Launch readiness",
    description: "Prepare the launch checklist.", status: "planning",
    createdAt: "2026-04-26T12:34:00.000Z", updatedAt: "2026-04-27T08:00:00.000Z",
  },
];

// Stable identities: the Workflows page re-runs a labels effect keyed on overview.data?.labels,
// so a fresh array per render would loop forever and OOM the worker.
const OVERVIEW = vi.hoisted(() => ({
  data: { workflows: [], activeRuns: [], recentRuns: [], projects: [], labels: [] },
}));

const state = {
  company: {
    companies: [COMPANY],
    selectedCompany: COMPANY as typeof COMPANY | null,
    selectedCompanyId: "company-1" as string | null,
    setSelectedCompanyId: vi.fn(),
    canWrite: true,
    canAdmin: true,
    currentRole: "owner",
  },
};

vi.mock("../../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context/CompanyContext")>()),
  useCompany: () => state.company,
}));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openNewMission: vi.fn() }) }));
vi.mock("../../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
  useOptionalToast: () => undefined,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("../../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }));
vi.mock("../../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("../../components/CompanyPatternIcon", () => ({ CompanyPatternIcon: () => null }));
vi.mock("../../components/CompanyWorkProductStorageSettings", () => ({ CompanyWorkProductStorageSettings: () => null }));
vi.mock("../../components/CompanyDataStorageSettings", () => ({ CompanyDataStorageSettings: () => null }));
vi.mock("../../components/access-settings/AccessSettingsSection", () => ({ AccessSettingsSection: () => null }));

vi.mock("../../api/missions", () => ({
  missionsApi: {
    list: vi.fn(async () => MISSIONS),
    update: vi.fn(async () => ({})),
    listWorkflowRuns: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
  },
}));
vi.mock("../../api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Rocket QA" }]) } }));
vi.mock("../../api/client", () => ({ api: { get: vi.fn(async () => []) } }));
vi.mock("../../api/operator-decisions", () => ({ operatorDecisionsApi: { list: vi.fn(async () => ({ data: [] })) } }));
vi.mock("../../api/companies", () => ({ companiesApi: { update: vi.fn(async () => COMPANY), archive: vi.fn(async () => undefined) } }));
vi.mock("../../api/assets", () => ({ assetsApi: { uploadCompanyLogo: vi.fn() } }));

vi.mock("../workflows/workflow-page-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workflows/workflow-page-api.js")>()),
  useHostContext: () => ({ companyId: "company-1" }),
  useWorkflowOverview: () => ({
    loading: false,
    data: OVERVIEW.data,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
  useAvailableWorkflowTools: () => ({ tools: [], grants: [], toolSystem: { available: false } }),
  usePluginAction: () => vi.fn(async () => ({})),
}));
vi.mock("../workflows/workflow-definitions-table.js", () => ({ DefinitionsTable: () => null }));
vi.mock("../workflows/workflow-run-sections.js", () => ({ WorkflowRunSections: () => null }));
vi.mock("../workflows/workflow-create-form.js", () => ({ WorkflowCreateForm: () => null }));
vi.mock("../workflows/workflow-help-overlay.js", () => ({ WorkflowHelpOverlay: () => null }));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(ui: ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </TooltipProvider>,
    );
  });
  await flush();
  await flush();
  return host;
}

async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const buttonWithText = (name: string) =>
  [...(host?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(name));

beforeEach(() => {
  state.company = { ...state.company, selectedCompany: COMPANY, selectedCompanyId: "company-1" };
  vi.mocked(missionsApi.list).mockClear();
  vi.mocked(missionsApi.update).mockClear();
  vi.mocked(companiesApi.update).mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("Missions a11y", () => {
  it("announces the missions query error via role=alert", async () => {
    vi.mocked(missionsApi.list).mockRejectedValueOnce(new Error("list failed"));
    await mount(<Missions />);
    const alert = host!.querySelector("p[role='alert']");
    expect(alert, "error paragraph has role=alert").toBeTruthy();
    expect(alert!.textContent).toContain("list failed");
  });

  it("icon-only refresh button has an accessible name and an explicit type", async () => {
    await mount(<Missions />);
    const refresh = host!.querySelector("button[aria-label='현재 미션 탭 새로고침']");
    expect(refresh, "refresh button keeps its aria-label").toBeTruthy();
    expect(refresh!.getAttribute("type")).toBe("button");
  });

  it("announces a failed pause/resume action via role=alert", async () => {
    vi.mocked(missionsApi.update).mockRejectedValueOnce(new Error("toggle failed"));
    await mount(<Missions />);
    await click(buttonWithText("재개"));
    const alert = host!.querySelector("p[role='alert']");
    expect(alert, "action error paragraph has role=alert").toBeTruthy();
    expect(alert!.textContent).toContain("toggle failed");
  });
});

describe("CompanySettings a11y", () => {
  it("gives every general/appearance form control an accessible name", async () => {
    await mount(<CompanySettings />);
    const labels = [
      "Company name",
      "Company description",
      "Timezone",
      "Default user-facing language",
      "Paperwork local work folder",
      "Company logo",
      "Brand color",
      "Brand color hex value",
    ];
    for (const label of labels) {
      expect(host!.querySelector(`[aria-label='${label}']`), label).toBeTruthy();
    }
  });

  it("announces a failed settings save via role=alert", async () => {
    vi.mocked(companiesApi.update).mockRejectedValueOnce(new Error("save failed"));
    await mount(<CompanySettings />);
    setInputValue(host!.querySelector("input[aria-label='Company name']")!, "Acme Two");
    await flush();
    await click(buttonWithText("Save changes"));
    const alert = host!.querySelector("[role='alert']");
    expect(alert, "save error span has role=alert").toBeTruthy();
    expect(alert!.textContent).toContain("save failed");
  });
});

describe("Workflows a11y", () => {
  it("keeps explicit button types, the Help accessible name, and a status region", async () => {
    await mount(<Workflows />);
    const header = host!.querySelector("#wf-header");
    expect(header, "workflow control bar rendered").toBeTruthy();
    const buttons = [...header!.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      expect(button.getAttribute("type"), `type=button on "${button.textContent}"`).toBe("button");
    }
    expect(header!.querySelector("button[aria-label='Help']")).toBeTruthy();
    expect(header!.querySelector("[role='status']")).toBeTruthy();
  });
});

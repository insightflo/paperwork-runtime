/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";

const mocks = vi.hoisted(() => ({
  createCompany: vi.fn(),
  createGoal: vi.fn(),
  listGoals: vi.fn(),
  adapterModels: vi.fn(),
  createAgent: vi.fn(),
  testEnvironment: vi.fn(),
  updateAgent: vi.fn(),
  createIssue: vi.fn(),
  invalidateQueries: vi.fn(),
  setSelectedCompanyId: vi.fn(),
  closeOnboarding: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: { create: mocks.createCompany },
}));
vi.mock("../api/goals", () => ({
  goalsApi: {
    create: mocks.createGoal,
    list: mocks.listGoals,
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("../api/agents", () => ({
  agentsApi: {
    adapterModels: mocks.adapterModels,
    create: mocks.createAgent,
    testEnvironment: mocks.testEnvironment,
    update: mocks.updateAgent,
  },
}));
vi.mock("../api/issues", () => ({
  issuesApi: { create: mocks.createIssue },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/onboarding" }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: {},
    closeOnboarding: mocks.closeOnboarding,
  }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    setSelectedCompanyId: mocks.setSelectedCompanyId,
    loading: false,
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DialogPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => ({ buildAdapterConfig: () => ({}) }),
}));
vi.mock("./AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => null,
}));

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OnboardingWizard goals cleanup", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCompany.mockResolvedValue({
      id: "company-1",
      issuePrefix: "ACM",
    });
    mocks.adapterModels.mockResolvedValue([]);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("creates the step 1 company without any live goalsApi call", async () => {
    await act(async () => {
      root.render(<OnboardingWizard />);
    });

    const input = host.querySelector<HTMLInputElement>(
      'input[placeholder="Acme Corp"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "Acme");
    });

    const next = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Next"),
    );
    expect(next).not.toBeNull();
    await act(async () => {
      next!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.createCompany).toHaveBeenCalledTimes(1);
    expect(mocks.createCompany).toHaveBeenCalledWith({ name: "Acme" });
    expect(mocks.setSelectedCompanyId).toHaveBeenCalledWith("company-1");
    expect(mocks.createGoal).not.toHaveBeenCalled();
    expect(mocks.listGoals).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Create your first agent");
  });
});

/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => ({
    data: options?.queryKey?.[0] === "plugins" ? [] : { deploymentMode: "local_trusted", bootstrapStatus: "ready" },
    isLoading: false,
    error: null,
  }),
}));

const company = { id: "company-1", name: "Acme", issuePrefix: "RES" };

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [company],
    selectedCompany: company,
    selectedCompanyId: company.id,
    loading: false,
  }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ onboardingOpen: false, openOnboarding: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../components/Layout", async () => {
  const { Outlet, useParams } = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  const { NotFoundPage } = await vi.importActual<typeof import("../pages/NotFound")>("../pages/NotFound");
  const { useCompany } = await vi.importMock<typeof import("../context/CompanyContext")>("../context/CompanyContext");
  const Layout = () => {
    const { companyPrefix } = useParams<{ companyPrefix?: string }>();
    const { companies, loading } = useCompany();
    const known = !companyPrefix || loading || companies.length === 0 ||
      companies.some((entry) => entry.issuePrefix.toUpperCase() === companyPrefix.toUpperCase());
    return known ? <Outlet /> : <NotFoundPage scope="board" />;
  };
  return { Layout };
});

let lastPathname = "";
function LocationProbe() {
  lastPathname = useLocation().pathname;
  return null;
}

describe("Phase 0-4/5 Wave 1: design-guide and ux-lab routes removed", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderPath(path: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
          <LocationProbe />
        </MemoryRouter>,
      );
    });
    const deadline = Date.now() + 3000;
    while (!host.textContent?.includes("Page not found") && Date.now() < deadline) {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    }
  }

  it.each([
    ["/design-guide", "/RES/design-guide"],
    ["/RES/design-guide", "/RES/design-guide"],
    ["/run-transcript-ux-lab", "/run-transcript-ux-lab"],
    ["/RES/run-transcript-ux-lab", "/RES/run-transcript-ux-lab"],
  ])("%s falls back to not found (final pathname %s)", async (path, expected) => {
    await renderPath(path);
    expect(lastPathname).toBe(expected);
    expect(host.textContent).toContain("Page not found");
  });
});

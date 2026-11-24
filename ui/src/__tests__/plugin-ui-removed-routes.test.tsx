/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { deploymentMode: "local_trusted", bootstrapStatus: "ready" },
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
    return known ? <Outlet /> : <NotFoundPage scope="invalid_company_prefix" requestedPrefix={companyPrefix} />;
  };
  return { Layout };
});
vi.mock("../pages/CompanySettings", () => ({
  CompanySettings: () => <div>CompanySettingsPage</div>,
}));

describe("Phase 0-2 Plugin UI Wave 1: plugin routes removed", () => {
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

  async function renderPath(path: string, expected: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
    });
    const deadline = Date.now() + 3000;
    while (!host.textContent?.includes(expected) && Date.now() < deadline) {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    }
  }

  it.each([
    { path: "/RES/plugins/some-plugin", title: "Page not found" },
    { path: "/RES/some-legacy-plugin-route", title: "Page not found" },
    { path: "/instance/settings/plugins", title: "Company not found" },
    { path: "/instance/settings/plugins/some-plugin", title: "Company not found" },
  ])("$path falls through to NotFoundPage", async ({ path, title }) => {
    await renderPath(path, title);
    expect(host.textContent).toContain(title);
    expect(host.textContent).toContain(`Requested path: ${path}`);
  });

  it("adjacent /RES/company/settings still resolves", async () => {
    await renderPath("/RES/company/settings", "CompanySettingsPage");
    expect(host.textContent).toContain("CompanySettingsPage");
    expect(host.textContent).not.toContain("Page not found");
  });
});

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
  const { Outlet } = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("../pages/CompanySettings", () => ({
  CompanySettings: () => <div>CompanySettingsPage</div>,
}));

describe("Phase 0-4 Wave 2: company export/import routes removed", () => {
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
        </MemoryRouter>,
      );
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it.each(["/RES/company/export", "/RES/company/import"])(
    "%s falls through to the board not-found route",
    async (path) => {
      await renderPath(path);
      expect(host.textContent).toContain("Page not found");
      expect(host.textContent).toContain("This route does not exist.");
      expect(host.textContent).toContain(`Requested path: ${path}`);
    },
  );

  it("adjacent /RES/company/settings still resolves", async () => {
    await renderPath("/RES/company/settings");
    expect(host.textContent).toContain("CompanySettingsPage");
    expect(host.textContent).not.toContain("Page not found");
  });
});

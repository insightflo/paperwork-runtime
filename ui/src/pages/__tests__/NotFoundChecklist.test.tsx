// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BreadcrumbProvider } from "../../context/BreadcrumbContext";
import { CompanyContext } from "../../context/CompanyContext";
import { CompanyLanguageProvider } from "../../lib/companyLanguage";
import { koCompanyContext } from "../../test-utils/koCompanyContext";
import { NotFoundPage } from "../NotFound";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const enCompanyContext = {
  ...koCompanyContext,
  selectedCompany: koCompanyContext.selectedCompany
    ? { ...koCompanyContext.selectedCompany, defaultLanguage: "en" as const }
    : null,
};

async function renderNotFound(language: "ko" | "en" = "ko") {
  const company = language === "ko" ? koCompanyContext : enCompanyContext;
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/totally/unknown/path"]}>
        <CompanyContext.Provider value={company}>
          <CompanyLanguageProvider language={language}>
            <BreadcrumbProvider>
              <NotFoundPage />
            </BreadcrumbProvider>
          </CompanyLanguageProvider>
        </CompanyContext.Provider>
      </MemoryRouter>,
    );
  });
}

describe("NotFoundChecklist", () => {
  it("renders a clear heading and a helpful explanation", async () => {
    await renderNotFound("ko");
    const heading = host.querySelector("h1");
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe("페이지를 찾을 수 없습니다");
    expect(host.textContent).toContain("존재하지 않거나");
    expect(host.textContent).toContain("워크스페이스 홈으로 돌아가세요");
  });

  it("exposes a main landmark wrapping the 404 content", async () => {
    await renderNotFound("ko");
    const main = host.querySelector("main");
    expect(main).not.toBeNull();
    expect(main!.querySelector("h1")).not.toBeNull();
    expect(main!.querySelector('a[href="/"]')).not.toBeNull();
  });

  it("offers an accessible recovery link back to the workspace home", async () => {
    await renderNotFound("ko");
    const homeLink = host.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(homeLink).not.toBeNull();
    expect(homeLink!.textContent).toBe("홈으로");
  });

  it("keeps English copy when the company language is en", async () => {
    await renderNotFound("en");
    expect(host.querySelector("h1")!.textContent).toBe("Page not found");
    const homeLink = host.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(homeLink!.textContent).toBe("Go home");
    expect(mainLandmark().querySelector("h1")).not.toBeNull();
  });
});

function mainLandmark(): HTMLElement {
  return host.querySelector("main")!;
}

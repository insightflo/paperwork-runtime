// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Research Company", issuePrefix: "RES" },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false, isFetching: false, isStale: false }),
}));

vi.mock("./SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarProjects", () => ({ SidebarProjects: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOOLS_TOGGLE_SELECTOR = 'button[aria-label="운영 · 관리 도구"]';
const TOOLS_OPEN_STORAGE_KEY = "paperwork:sidebar-tools-open";

let host: HTMLDivElement;
let root: Root;

async function renderSidebar(initialEntry = "/RES/missions") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Sidebar />
      </MemoryRouter>,
    );
  });
}

function toolsToggle(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(TOOLS_TOGGLE_SELECTOR);
  if (!button) throw new Error("운영 · 관리 도구 toggle button not found");
  return button;
}

function link(href: string): HTMLAnchorElement | null {
  return host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("SidebarSimplified (Stage 31B W2)", () => {
  it("shows the 4 primary workspace items immediately on default render without Inbox", async () => {
    await renderSidebar();
    expect(link("/channels")).not.toBeNull();
    expect(link("/RES/missions")).not.toBeNull();
    expect(link("/RES/agents")).not.toBeNull();
    expect(link("/RES/inbox")).toBeNull();
    expect(link("/RES/company/settings")).not.toBeNull();
    expect(link("/RES/missions")!.textContent).toContain("Missions");
    expect(host.querySelector('nav[aria-label="워크스페이스"]')?.textContent).not.toContain("Inbox");
  });

  it("collapses 운영 · 관리 도구 by default and hides secondary admin items", async () => {
    await renderSidebar();
    const toggle = toolsToggle();
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(link("/RES/dashboard")).toBeNull();
    expect(link("/workflows")).toBeNull();
    expect(link("/scheduler")).toBeNull();
    expect(window.localStorage.getItem(TOOLS_OPEN_STORAGE_KEY)).toBeNull();
  });

  it("expands secondary admin items on click and persists the open preference", async () => {
    await renderSidebar();
    await act(async () => {
      toolsToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toolsToggle().getAttribute("aria-expanded")).toBe("true");
    for (const href of ["/RES/dashboard", "/RES/issues", "/workflows", "/worktree/rules", "/scheduler", "/RES/projects"]) {
      expect(link(href)).not.toBeNull();
    }
    expect(window.localStorage.getItem(TOOLS_OPEN_STORAGE_KEY)).toBe("true");
  });

  it("restores the persisted open state on remount", async () => {
    window.localStorage.setItem(TOOLS_OPEN_STORAGE_KEY, "true");
    await renderSidebar("/RES/quality");
    expect(toolsToggle().getAttribute("aria-expanded")).toBe("true");
    expect(link("/RES/quality")).not.toBeNull();
  });

  it("keeps personal endpoints and workspace primitives inside the expanded tools section", async () => {
    await renderSidebar();
    const destinations = [
      ["/personal-endpoints", "개인 단말 봇"],
      ["/workspace-primitives", "공유 표 · 대기"],
      ["/channel-config", "Channel"],
    ] as const;
    for (const [href] of destinations) expect(link(href)).toBeNull();
    expect(link("/channels")?.textContent).toBe("Threads");
    expect(Array.from(host.querySelectorAll('nav[aria-label="워크스페이스"] a'), (item) => item.textContent))
      .toEqual(["Threads", "Missions", "Agents", "Settings"]);

    await act(async () => {
      toolsToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const contentId = toolsToggle().getAttribute("aria-controls")!;
    for (const [href, label] of destinations) {
      expect(link(href)?.textContent).toBe(label);
      expect(document.getElementById(contentId)?.contains(link(href))).toBe(true);
    }
  });

  it.each(["/personal-endpoints", "/workspace-primitives"])(
    "shows the active dot on %s only while tools are collapsed",
    async (pathname) => {
      window.history.replaceState({}, "", pathname);
      await renderSidebar(pathname);
      expect(toolsToggle().getAttribute("aria-expanded")).toBe("false");
      expect(toolsToggle().querySelector("[data-tools-active]")).not.toBeNull();

      await act(async () => {
        toolsToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(link(pathname)?.getAttribute("aria-current")).toBe("page");
      expect(toolsToggle().querySelector("[data-tools-active]")).toBeNull();

      await act(async () => {
        toolsToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(link(pathname)).toBeNull();
      expect(toolsToggle().querySelector("[data-tools-active]")).not.toBeNull();
    },
  );

  it("marks a collapsed tools toggle with an active dot only on secondary routes", async () => {
    window.history.replaceState({}, "", "/RES/quality");
    await renderSidebar("/RES/quality");
    expect(toolsToggle().getAttribute("aria-expanded")).toBe("false");
    expect(toolsToggle().querySelector("[data-tools-active]")).not.toBeNull();

    window.history.replaceState({}, "", "/RES/missions");
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/RES/missions"]}>
          <Sidebar />
        </MemoryRouter>,
      );
    });
    expect(toolsToggle().querySelector("[data-tools-active]")).toBeNull();
  });
});

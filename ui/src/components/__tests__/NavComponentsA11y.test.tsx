// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "../BreadcrumbBar";
import { MobileBottomNav } from "../MobileBottomNav";
import { CommandPalette } from "../CommandPalette";
import { Sidebar } from "../Sidebar";

const hoisted = vi.hoisted(() => ({
  crumbs: [] as Array<{ label: string; href?: string }>,
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs: hoisted.crumbs, setBreadcrumbs: () => {} }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: null, selectedCompany: null, canWrite: true }),
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({
    openNewMission: vi.fn(),
    openNewIssue: vi.fn(),
    openNewAgent: vi.fn(),
    openNewProject: vi.fn(),
  }),
  useOptionalDialog: () => null,
}));

vi.mock("../../context/SidebarContext", () => ({
  useSidebar: () => ({ sidebarOpen: true, toggleSidebar: vi.fn(), isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0 }),
}));

vi.mock("../SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("../SidebarProjects", () => ({ SidebarProjects: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// cmdk instantiates ResizeObserver when its list mounts; jsdom does not provide one.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// cmdk/selection scrolling expects scrollIntoView, which jsdom does not implement.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
  });
}

let host: HTMLDivElement;
let root: Root;

async function renderWith(children: React.ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/missions"]}>{children}</MemoryRouter>);
  });
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  hoisted.crumbs = [];
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("NavComponentsA11y", () => {
  it("BreadcrumbBar renders a labelled breadcrumb nav with aria-current on the current crumb", async () => {
    hoisted.crumbs = [
      { label: "Missions", href: "/missions" },
      { label: "Launch Plan" },
    ];
    await renderWith(<BreadcrumbBar />);

    const nav = host.querySelector("nav[aria-label]");
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute("aria-label")).toBe("breadcrumb");

    const current = host.querySelector('[aria-current="page"]');
    expect(current).not.toBeNull();
    expect(current!.textContent).toBe("Launch Plan");
  });

  it("BreadcrumbBar icon-only buttons carry explicit labels and type=button", async () => {
    await renderWith(<BreadcrumbBar />);

    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("type")).toBe("button");
    expect(toggle!.getAttribute("aria-label")).toBeTruthy();
  });

  it("BreadcrumbBar live telemetry chip exposes a status role so its label is announced", async () => {
    hoisted.crumbs = [{ label: "Dashboard" }];
    await renderWith(<BreadcrumbBar />);

    const chip = host.querySelector('[role="status"][aria-label="Live telemetry status"]');
    expect(chip).not.toBeNull();
  });

  it("MobileBottomNav renders a labelled nav landmark with typed action button", async () => {
    await renderWith(<MobileBottomNav visible />);

    const nav = host.querySelector('nav[aria-label="Mobile navigation"]');
    expect(nav).not.toBeNull();

    const create = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Create"),
    );
    expect(create).not.toBeUndefined();
    expect(create!.getAttribute("type")).toBe("button");
  });

  it("MobileBottomNav marks the active link with aria-current=page", async () => {
    await renderWith(<MobileBottomNav visible />);

    // initialEntries = ["/missions"] so the Missions NavLink is active
    const current = host.querySelector('a[aria-current="page"]');
    expect(current).not.toBeNull();
    expect(current!.textContent).toContain("Missions");
  });

  it("Sidebar labels collaboration threads separately from channel configuration", async () => {
    await renderWith(
      <QueryClientProvider client={makeQueryClient()}>
        <Sidebar />
      </QueryClientProvider>,
    );

    const threads = host.querySelector<HTMLAnchorElement>('a[href="/channels"]');
    expect(threads).not.toBeNull();
    expect(threads!.textContent).toBe("Threads");

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="운영 · 관리 도구"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const channelConfig = host.querySelector<HTMLAnchorElement>('a[href="/channel-config"]');
    expect(channelConfig).not.toBeNull();
    expect(channelConfig!.textContent).toBe("Channel");
    expect(threads!.textContent).not.toBe(channelConfig!.textContent);
  });

  it("CommandPalette dialog has an accessible name and a labelled search input", async () => {
    await renderWith(
      <QueryClientProvider client={makeQueryClient()}>
        <CommandPalette />
      </QueryClientProvider>,
    );

    // Open via the ⌘K shortcut the component listens for on document.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Radix wires the sr-only DialogTitle into aria-labelledby, giving the dialog a name.
    const labelledBy = dialog!.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Paperwork command palette");

    const input = document.body.querySelector('input[aria-label^="Search"]');
    expect(input).not.toBeNull();

    const shortcutKbd = document.body.querySelector('[role="dialog"] kbd[aria-hidden="true"]');
    expect(shortcutKbd).not.toBeNull();
  });
});

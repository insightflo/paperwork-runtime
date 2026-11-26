// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { SidebarProvider } from "../context/SidebarContext";

const hoisted = vi.hoisted(() => ({
  crumbs: [] as Array<{ label: string; href?: string }>,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs: hoisted.crumbs, setBreadcrumbs: () => {} }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

async function renderBar() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/issues"]}>
        <SidebarProvider>
          <BreadcrumbBar />
        </SidebarProvider>
      </MemoryRouter>,
    );
  });
}

function menuButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!button) throw new Error("sidebar toggle button not found");
  return button;
}

function searchButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Meta+K"]');
  if (!button) throw new Error("⌘K search button not found");
  return button;
}

beforeEach(() => {
  hoisted.crumbs = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("BreadcrumbBar", () => {
  it("renders an empty 48px command header with only the sidebar toggle and no crumbs", async () => {
    await renderBar();

    const header = host.firstElementChild as HTMLElement;
    expect(header.className).toContain("h-12");
    expect(header.className).not.toContain("h-11");
    expect(header.className).toContain("border-[#242d3f]");
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("bg-[#0b0e14]/95");
    expect(header.className).toContain("backdrop-blur-sm");
    // Legacy semantic token colours must not leak back into the cockpit shell.
    expect(header.className).not.toContain("bg-background/95");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("nav")).toBeNull();
    expect(menuButton().getAttribute("aria-label")).toBe("Collapse sidebar");
  });

  it("centers the ⌘K search button in the header's middle grid column", async () => {
    await renderBar();

    const header = host.firstElementChild as HTMLElement;
    // [left: toggle + crumbs] | search | [right slot] -> the search sits in the center column.
    expect(header.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
    expect(header.children).toHaveLength(3);

    const search = header.children[1] as HTMLElement;
    expect(search.tagName).toBe("BUTTON");
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(search.getAttribute("aria-label")).toBe("Open command palette");
    expect(search.getAttribute("type")).toBe("button");
    expect(search.textContent).toContain("Search missions, agents, approvals");
    expect(search.textContent).toContain("⌘K");
    expect(search.querySelector("kbd")?.textContent).toBe("⌘K");
    expect(search.className).toContain("justify-start");
    expect(search.className).toContain("rounded-lg");
    expect(search.className).toContain("md:flex");
  });

  it("opens the command palette by replaying ⌘K on document when the search button is clicked", async () => {
    await renderBar();

    const seen: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event);
    document.addEventListener("keydown", listener);
    try {
      await act(async () => {
        searchButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    } finally {
      document.removeEventListener("keydown", listener);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("k");
    expect(seen[0].metaKey).toBe(true);
    expect(seen[0].ctrlKey).toBe(false);
  });

  it("renders a single breadcrumb as an uppercase tabular page title", async () => {
    hoisted.crumbs = [{ label: "Work" }];

    await renderBar();

    const title = host.querySelector("h1");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Work");
    expect(title!.className).toContain("uppercase");
    expect(title!.className).toContain("tracking-wider");
    expect(title!.className).toContain("tabular-nums");
    expect(host.querySelector("nav")).toBeNull();
  });

  it("renders a multi-breadcrumb trail with links for ancestors and a page label for the current item", async () => {
    hoisted.crumbs = [
      { label: "Work", href: "/issues" },
      { label: "Paperclip Runtime" },
    ];

    await renderBar();

    expect(host.querySelector("h1")).toBeNull();
    const link = host.querySelector<HTMLAnchorElement>('a[href="/issues"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("Work");

    const page = host.querySelector('[data-slot="breadcrumb-page"]');
    expect(page).not.toBeNull();
    expect(page!.textContent).toBe("Paperclip Runtime");
    expect(page!.getAttribute("aria-current")).toBe("page");

    expect(host.querySelector('[data-slot="breadcrumb-separator"]')).not.toBeNull();
    const list = host.querySelector('[data-slot="breadcrumb-list"]');
    expect(list!.className).toContain("uppercase");
    expect(list!.className).toContain("tabular-nums");
  });

  it("keeps aria-expanded in sync with sidebar open state across toggle clicks", async () => {
    await renderBar();

    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(menuButton().getAttribute("aria-label")).toBe("Collapse sidebar");

    await act(async () => {
      menuButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(menuButton().getAttribute("aria-label")).toBe("Expand sidebar");

    await act(async () => {
      menuButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(menuButton().getAttribute("aria-label")).toBe("Collapse sidebar");
  });
});

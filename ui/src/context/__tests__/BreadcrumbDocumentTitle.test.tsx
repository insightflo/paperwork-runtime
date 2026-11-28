// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "../BreadcrumbContext";

let host: HTMLDivElement;
let root: Root;
let originalTitle: string;
let context: ReturnType<typeof useBreadcrumbs>;

function BreadcrumbProbe() {
  context = useBreadcrumbs();
  return <span>{context.breadcrumbs.map((crumb) => crumb.label).join(" / ")}</span>;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  originalTitle = document.title;
  document.title = "Previous route";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<BreadcrumbProvider><BreadcrumbProbe /></BreadcrumbProvider>);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.title = originalTitle;
  vi.unstubAllGlobals();
});

describe("breadcrumb document title", () => {
  it("defaults to Paperwork when mounted with no breadcrumbs", () => {
    expect(document.title).toBe("Paperwork");
  });

  it("updates reactively for route changes and resets when breadcrumbs are cleared", async () => {
    const setBreadcrumbs = context.setBreadcrumbs;
    await act(async () => setBreadcrumbs([{ label: "Dashboard", href: "/" }]));
    expect(document.title).toBe("Dashboard — Paperwork");

    await act(async () => setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: "Website" },
    ]));
    expect(document.title).toBe("Projects · Website — Paperwork");

    await act(async () => setBreadcrumbs([]));
    expect(document.title).toBe("Paperwork");
    expect(context.breadcrumbs).toEqual([]);
    expect(context.setBreadcrumbs).toBe(setBreadcrumbs);
  });

  it("uses the first and last labels without changing the breadcrumb data", async () => {
    const breadcrumbs = [
      { label: "Projects", href: "/projects" },
      { label: "Website", href: "/projects/website" },
      { label: "Settings" },
    ];
    await act(async () => context.setBreadcrumbs(breadcrumbs));

    expect(document.title).toBe("Projects · Settings — Paperwork");
    expect(context.breadcrumbs).toEqual(breadcrumbs);
    expect(host.textContent).toBe("Projects / Website / Settings");
  });

  it.each([
    [{ label: "A".repeat(100) }],
    [{ label: "Projects" }, { label: "B".repeat(100) }],
  ])("limits long titles to 80 characters and retains the brand suffix (%j)", async (...breadcrumbs) => {
    await act(async () => context.setBreadcrumbs(breadcrumbs));

    expect(document.title).toHaveLength(80);
    expect(document.title).toMatch(/… — Paperwork$/);
    expect(context.breadcrumbs).toEqual(breadcrumbs);
  });

  it("keeps a title at the length limit intact", async () => {
    const label = "A".repeat(68);
    await act(async () => context.setBreadcrumbs([{ label }]));

    expect(document.title).toBe(`${label} — Paperwork`);
    expect(document.title).toHaveLength(80);
  });
});

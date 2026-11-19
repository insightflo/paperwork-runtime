// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { forwardRef, type ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { SidebarDensityContext } from "../lib/sidebar-slide-physics";
import { SidebarNavItem } from "./SidebarNavItem";

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: {
      id: "company-1",
      name: "Research Company",
      issuePrefix: "RES",
    },
  }),
}));

vi.mock("@/lib/router", async () => {
  const React = await import("react");
  const RouterDom = await import("react-router-dom");
  const { applyCompanyPrefix } = await import("../lib/company-routes");
  return {
    ...RouterDom,
    NavLink: React.forwardRef<
      HTMLAnchorElement,
      React.ComponentProps<typeof RouterDom.NavLink>
    >(function CompanyNavLink({ to, ...props }, ref) {
      const resolvedTo = typeof to === "string" ? applyCompanyPrefix(to, "RES") : to;
      return <RouterDom.NavLink ref={ref} to={resolvedTo} {...props} />;
    }),
  };
});

const Icon = forwardRef<SVGSVGElement, ComponentProps<LucideIcon>>(
  function Icon(props, ref) {
    return <svg ref={ref} data-icon="quality" {...props} />;
  },
) as LucideIcon;

describe("SidebarNavItem", () => {
  it("renders the Quality menu link with the active company prefix", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/RES/dashboard"]}>
        <SidebarNavItem to="/quality" label="Quality" icon={Icon} />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/RES/quality"');
    expect(html).not.toContain('href="/quality"');
  });

  it("renders icon-only tile with tooltip attributes and numeric badge in 88px compact mode", () => {
    const html = renderToStaticMarkup(
      <SidebarDensityContext.Provider value={{ width: 88, compact: true }}>
        <MemoryRouter initialEntries={["/RES/missions"]}>
          <SidebarNavItem to="/missions" label="Missions" icon={Icon} badge={4} />
        </MemoryRouter>
      </SidebarDensityContext.Provider>,
    );

    expect(html).toContain('href="/RES/missions"');
    expect(html).toContain('title="Missions"');
    expect(html).toContain('aria-label="Missions"');
    expect(html).toContain(">4<");
    expect(html).not.toContain('<span class="flex-1 truncate">Missions</span>');
  });

  it("exposes amber textBadge status via title and status dot in compact mode", () => {
    const html = renderToStaticMarkup(
      <SidebarDensityContext.Provider value={{ width: 88, compact: true }}>
        <MemoryRouter initialEntries={["/RES/missions"]}>
          <SidebarNavItem
            to="/human-operator"
            label="Human Operator"
            icon={Icon}
            textBadge="status stale"
            textBadgeTone="amber"
          />
        </MemoryRouter>
      </SidebarDensityContext.Provider>,
    );

    expect(html).toContain('title="Human Operator (status stale)"');
    expect(html).toContain('aria-label="Human Operator (status stale)"');
    expect(html).toContain("var(--openbot-wait-question)");
  });
});

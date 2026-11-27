// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  companies: [
    {
      id: "company-alpha",
      name: "Alpha Robotics",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "ALPHA",
      issueCounter: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      timezone: null,
      workProductRoot: null,
      defaultLanguage: "en",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    {
      id: "company-beta",
      name: "Beta Systems",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "BETA",
      issueCounter: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      timezone: null,
      workProductRoot: null,
      defaultLanguage: "en",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/ALPHA/missions" }),
  useNavigate: () => hoisted.navigate,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: hoisted.companies,
    selectedCompanyId: "company-alpha",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <span data-tooltip-content>{children}</span>,
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName, className }: { companyName: string; className?: string }) => (
    <span className={className}>{companyName.slice(0, 1)}</span>
  ),
}));

vi.mock("./ProviderUsageRings", () => ({
  ProviderUsageRings: () => null,
}));

let host: HTMLDivElement;
let root: Root;

async function renderRail() {
  await act(async () => {
    root.render(<CompanyRail />);
  });
}

function railItem(companyId: string): HTMLElement {
  const item = host.querySelector<HTMLElement>(`[data-company-rail-item="${companyId}"]`);
  if (!item) throw new Error(`company rail item not found: ${companyId}`);
  return item;
}

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

describe("CompanyRail", () => {
  it("renders companies in the slim 52px workspace rail with Paperwork chrome and active indicator", async () => {
    await renderRail();

    const rail = host.firstElementChild as HTMLElement;
    expect(rail.className).toContain("w-[52px]");
    expect(rail.className).not.toContain("w-[72px]");
    // Rail surface and borders are driven by the Paperwork semantic tokens, not hard-coded hex.
    expect(rail.className).toContain("bg-[var(--pw-rail)]");
    expect(rail.className).toContain("border-r");
    expect(rail.className).toContain("border-border");
    expect(rail.className).not.toContain("#090c12");
    // Legacy semantic rail tokens must not leak back into the cockpit shell.
    expect(rail.className).not.toContain("bg-sidebar");
    expect(rail.className).not.toContain("border-sidebar-border");
    expect(host.textContent).toContain("Alpha Robotics");
    expect(host.textContent).toContain("Beta Systems");

    const activeItem = railItem("company-alpha");
    const inactiveItem = railItem("company-beta");
    expect(activeItem.dataset.active).toBe("true");
    expect(inactiveItem.dataset.active).toBeUndefined();

    // The rail owns the active indicator bar through arbitrary-variant overrides on the item link.
    // Selection is expressed through the semantic `primary` token for both light and dark themes.
    expect(activeItem.className).toContain("[&_a>div:first-child]:left-0");
    expect(activeItem.className).toContain("[&_a>div:first-child]:w-[3px]");
    expect(activeItem.className).toContain("[&_a>div:first-child]:h-5");
    expect(activeItem.className).toContain("[&_a>div:first-child]:bg-primary");
    expect(activeItem.className).not.toContain("#2563eb");
    expect(activeItem.className).not.toContain("#a3e635");

    expect(inactiveItem.className).toContain("[&_a>div:first-child]:left-0");
    expect(inactiveItem.className).toContain("[&_a>div:first-child]:w-[3px]");
    expect(inactiveItem.className).toContain("[&_a>div:first-child]:h-0");
    expect(inactiveItem.className).toContain("[&:hover_a>div:first-child]:h-2");
    expect(inactiveItem.className).toContain("[&:hover_a>div:first-child]:bg-primary/60");
    expect(inactiveItem.className).not.toContain("#2563eb");
    expect(inactiveItem.className).not.toContain("#60a5fa");

    const activeLink = activeItem.querySelector("a");
    const inactiveLink = inactiveItem.querySelector("a");
    const activeIndicator = activeLink?.querySelector<HTMLElement>(":scope > div:first-child");
    const inactiveIndicator = inactiveLink?.querySelector<HTMLElement>(":scope > div:first-child");
    expect(activeIndicator?.className).toContain("h-5");
    expect(inactiveIndicator?.className).toContain("h-0");
  });

  it("aligns the logo slot with the 48px header and keeps the hairline divider and accented add control", async () => {
    await renderRail();

    const rail = host.firstElementChild as HTMLElement;
    const logoSlot = rail.firstElementChild as HTMLElement;
    expect(logoSlot.className).toContain("h-12");

    const divider = host.querySelector<HTMLElement>(".h-px.w-6");
    expect(divider).not.toBeNull();

    const addButton = host.querySelector<HTMLButtonElement>('button[aria-label="회사 추가"]');
    expect(addButton?.className).toContain("hover:text-primary");
    expect(addButton?.className).toContain("hover:border-primary/70");
    expect(addButton?.className).not.toContain("#a3e635");
    expect(addButton?.className).not.toContain("#2563eb");
  });

  it("keeps high-density spacing and the add-company control intact", async () => {
    await renderRail();

    const scrollRail = host.querySelector<HTMLElement>(".scrollbar-none");
    expect(scrollRail?.className).toContain("gap-1.5");
    expect(scrollRail?.className).toContain("py-2");
    expect(host.querySelector('button[aria-label="회사 추가"]')).not.toBeNull();
  });
});

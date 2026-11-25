/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Project } from "@paperclipai/shared";
import { ActivityRow } from "../components/ActivityRow";
import { CommandPalette } from "../components/CommandPalette";
import { ProjectProperties } from "../components/ProjectProperties";
import { Sidebar } from "../components/Sidebar";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false, isFetching: false, isStale: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className }: {
    to: string;
    children?: ReactNode;
    className?: string | ((state: { isActive: boolean; isPending: boolean; isTransitioning: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false, isPending: false, isTransitioning: false }) : className}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Acme", issuePrefix: "AC" } }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn(), openNewMission: vi.fn(), openNewAgent: vi.fn() }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("../lib/sidebar-slide-physics", () => ({
  useSidebarDensity: () => ({ width: 256, compact: false }),
}));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }) }));
vi.mock("../hooks/useAfterInitialPaint", () => ({ useAfterInitialPaint: () => true }));
vi.mock("../components/SidebarProjects", () => ({ SidebarProjects: () => null }));
vi.mock("../components/SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("../components/Identity", () => ({ Identity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("../components/InlineEditor", () => ({ InlineEditor: ({ value }: { value: string }) => <div>{value}</div> }));
vi.mock("../components/PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("../components/agent-config-primitives", () => ({ DraftInput: () => null }));
vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandInput: () => <div />,
  CommandList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const project: Project = {
  id: "proj-1", companyId: "company-1", urlKey: "proj-1",
  goalId: null, goalIds: ["goal-1"], goals: [{ id: "goal-1", title: "Ship v1" }],
  name: "Ctx", description: null, status: "in_progress",
  leadAgentId: null, targetDate: null, color: null, pauseReason: null, pausedAt: null,
  executionWorkspacePolicy: null,
  codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null, localFolder: null, managedFolder: "", effectiveLocalFolder: "", origin: "local_folder" },
  workspaces: [], primaryWorkspace: null, archivedAt: null,
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
};

const goalEvent: ActivityEvent = {
  id: "ev-1", companyId: "company-1", actorType: "user", actorId: "board",
  action: "goal.created", entityType: "goal", entityId: "goal-1",
  agentId: null, runId: null, details: null, createdAt: new Date("2026-01-01"),
};

describe("Phase 0-3 Goals Wave 1: inbound /goals links removed", () => {
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

  it("Sidebar exposes no /goals navigation item", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).not.toContain("/goals");
    expect(html).not.toContain(">Goals<");
  });

  it("CommandPalette exposes no /goals command", () => {
    const html = renderToStaticMarkup(<CommandPalette />);
    expect(html).not.toContain("/goals");
    expect(html).not.toContain(">Goals<");
  });

  it("ProjectProperties renders goal title without /goals link and preserves goalIds on save", async () => {
    const onFieldUpdate = vi.fn();
    await act(async () => {
      root.render(<ProjectProperties project={project} onFieldUpdate={onFieldUpdate} />);
    });
    expect(host.querySelector('a[href^="/goals"]')).toBeNull();
    expect(host.textContent).toContain("Ship v1");

    const remove = host.querySelector<HTMLElement>('button[aria-label="Remove goal Ship v1"]')!;
    expect(remove).not.toBeNull();
    await act(async () => remove.click());
    expect(onFieldUpdate).toHaveBeenCalledWith("goals", { goalIds: [] });
  });

  it("ActivityRow renders goal entity text without a /goals link", () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        event={goalEvent}
        agentMap={new Map()}
        entityNameMap={new Map([["goal:goal-1", "Ship v1"]])}
      />,
    );
    expect(html).toContain("Ship v1");
    expect(html).not.toContain('href="/goals');
  });
});

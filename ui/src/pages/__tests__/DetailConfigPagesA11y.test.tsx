// @vitest-environment node
// Accessibility contract tests for ProjectDetail / AgentDetail / ChannelConfig
// (Front-End-Checklist: icon-only button names, form label association, live regions).
// Follows the repo's SSR static-markup convention (renderToStaticMarkup + node env),
// mirroring components/OperatorDecisionCard.accessibility.test.tsx.
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "../AgentDetail";
import { ChannelConfig, TelegramSection } from "../ChannelConfig";
import { ProjectDetail } from "../ProjectDetail";

const mocks = vi.hoisted(() => {
  const COMPANY_ID = "c1-1111-2222-3333-4444";
  const PROJECT_ID = "p1-1111-2222-3333-4444";
  const AGENT_ID = "a1-1111-2222-3333-4444";
  const project = {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    name: "Project Alpha",
    description: "Alpha description",
    targetDate: null,
    color: "#6366f1",
    updatedAt: "2026-02-01T00:00:00.000Z",
    pausedAt: null,
    pauseReason: null,
  };
  const agent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    status: "active",
    name: "Agent Alpha",
    role: "worker",
    title: null,
    icon: "bot",
    reportsTo: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
  };
  const channel = { enabled: true, botUsername: "alpha_bot", botTokenSecretId: "secret-1" };
  const flags = { projectsFail: false, agentsFail: false, channelFail: false };
  const queryData = (key: string[]): unknown => {
    const head = key[0] ?? "";
    if (head === "projects") return project;
    if (head === "agents") {
      if (key[1] === "detail") return agent;
      if (key[1] === "runtime-state") return null;
      return [];
    }
    if (head === "issues") return [];
    if (head === "budgets") return { policies: [] };
    if (head === "heartbeats") return key[3] === "stats" ? {} : { items: [], nextCursor: null };
    if (head === "live-runs") return [];
    if (head === "channel-config") return channel;
    if (head === "secrets") return [];
    return undefined;
  };
  return { COMPANY_ID, PROJECT_ID, AGENT_ID, flags, queryData };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = Array.isArray(opts?.queryKey) ? opts.queryKey.map((part) => String(part)) : [];
    const head = key[0] ?? "";
    const failed =
      (mocks.flags.projectsFail && head === "projects") ||
      (mocks.flags.agentsFail && head === "agents" && key[1] === "detail") ||
      (mocks.flags.channelFail && head === "channel-config");
    if (failed) return { data: undefined, isLoading: false, error: new Error("Lookup failed") };
    return { data: mocks.queryData(key), isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({ id: "created-secret", contentPath: "/assets/x.png" })),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useParams: () => ({
      companyPrefix: "ACME",
      projectId: mocks.PROJECT_ID,
      agentId: mocks.AGENT_ID,
      tab: "dashboard",
    }),
    useNavigate: () => vi.fn(),
    useLocation: () => ({
      pathname: `/projects/${mocks.PROJECT_ID}/overview`,
      search: "",
      hash: "",
      state: null,
      key: "test",
    }),
    Navigate: () => null,
    useBeforeUnload: () => {},
    Link: (props: { to: string; className?: string; children?: ReactNode }) =>
      createElement("a", { href: props.to, className: props.className }, props.children),
  };
});

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: mocks.COMPANY_ID, issuePrefix: "ACME", name: "Acme" }],
    selectedCompanyId: mocks.COMPANY_ID,
    setSelectedCompanyId: vi.fn(),
    canWrite: true,
    canAdmin: true,
    currentRole: "owner",
  }),
}));
vi.mock("../../context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn() }) }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../components/InlineEditor", () => ({
  InlineEditor: (props: { as?: "h1" | "h2" | "p" | "span"; className?: string; value: string }) =>
    createElement(props.as ?? "span", { className: props.className }, props.value),
}));
vi.mock("../../components/ChannelCollaborationBoard", () => ({
  ChannelCollaborationBoard: () => createElement("div", { "data-testid": "board-stub" }),
}));
vi.mock("../../components/agent-detail/AgentOverview", () => ({ AgentOverview: () => null }));
vi.mock("../../components/agent-detail/PromptsTab", () => ({ PromptsTab: () => null }));
vi.mock("../../components/agent-detail/RunViews", () => ({ RunsTab: () => null }));
vi.mock("../../components/agent-detail/ConfigureViews", () => ({ AgentConfigurePage: () => null }));
vi.mock("../../components/agent-detail/AgentSkillsTab", () => ({ AgentSkillsTab: () => null }));

function buttonTags(html: string): string[] {
  return html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? [];
}

function visibleText(buttonTag: string): string {
  return buttonTag.replace(/<[^>]*>/g, "").trim();
}

function iconOnlyButtons(html: string): string[] {
  return buttonTags(html).filter((tag) => visibleText(tag).length === 0);
}

function expectAccessibleIconButtons(html: string): void {
  const buttons = iconOnlyButtons(html);
  expect(buttons.length).toBeGreaterThan(0);
  for (const tag of buttons) {
    expect(tag, `icon-only button needs an explicit type: ${tag}`).toMatch(/\stype="button"/);
    expect(tag, `icon-only button needs an aria-label: ${tag}`).toMatch(/\saria-label="[^"]+"/);
  }
}

function pageSource(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

beforeEach(() => {
  mocks.flags.projectsFail = false;
  mocks.flags.agentsFail = false;
  mocks.flags.channelFail = false;
});

describe("ProjectDetail accessibility", () => {
  it("gives every icon-only button an explicit type and an accessible name", () => {
    const html = renderToStaticMarkup(createElement(ProjectDetail));
    expectAccessibleIconButtons(html);
    expect(html).toContain('aria-label="Change work context color"');
  });

  it("announces the page-level error banner", () => {
    mocks.flags.projectsFail = true;
    const html = renderToStaticMarkup(createElement(ProjectDetail));
    expect(html).toMatch(/<p role="alert"[^>]*text-destructive/);
    expect(html).toContain("Lookup failed");
  });
});

describe("AgentDetail accessibility", () => {
  it("gives every icon-only button an explicit type and an accessible name", () => {
    const html = renderToStaticMarkup(createElement(AgentDetail));
    expectAccessibleIconButtons(html);
    expect(html).toContain('aria-label="Change agent icon"');
    expect(html).toContain('aria-label="More agent actions"');
  });

  it("announces the page-level error banner and keeps action errors announced", () => {
    mocks.flags.agentsFail = true;
    const html = renderToStaticMarkup(createElement(AgentDetail));
    expect(html).toMatch(/<p role="alert"[^>]*text-destructive/);
    // actionError is only rendered after a failed action (not reachable in a
    // static render), so its live-region contract is asserted on the source.
    expect(pageSource("AgentDetail.tsx")).toMatch(/actionError && <p role="alert"/);
  });
});

describe("ChannelConfig accessibility", () => {
  it("gives every button an explicit type on the board view", () => {
    const html = renderToStaticMarkup(createElement(ChannelConfig));
    const buttons = buttonTags(html);
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) {
      expect(tag, `button needs an explicit type: ${tag}`).toMatch(/\stype="button"/);
    }
    expect(html).toContain('aria-label="Channel summary"');
  });

  it("announces the page-level channel config error", () => {
    mocks.flags.channelFail = true;
    const html = renderToStaticMarkup(createElement(ChannelConfig));
    expect(html).toMatch(/<p role="alert"[^>]*text-destructive/);
  });

  it("associates every Telegram form field with its visible label", () => {
    const html = renderToStaticMarkup(
      createElement(TelegramSection, { companyId: mocks.COMPANY_ID, config: null, canWrite: true }),
    );
    for (const id of ["channel-bot-username", "channel-bot-token", "channel-secret-name"]) {
      // React SSR renders label htmlFor as the plain HTML "for" attribute.
      expect(html).toContain(`for="${id}"`);
      expect(html).toMatch(new RegExp(`<input[^>]*id="${id}"`));
    }
    expect(html).toMatch(/<input[^>]*type="password"[^>]*id="channel-bot-token"/);
  });

  it("marks connection status as a live region and saved/error feedback as announced", () => {
    const html = renderToStaticMarkup(
      createElement(TelegramSection, { companyId: mocks.COMPANY_ID, config: null, canWrite: true }),
    );
    expect(html).toMatch(/<div aria-live="polite"[^>]*>/);
    // formError / saveSuccess banners only render after submit attempts (not
    // reachable in a static render), so their contract is asserted on the source.
    const source = pageSource("ChannelConfig.tsx");
    expect(source).toMatch(/formError && \(\s*<p role="alert"/);
    expect(source).toMatch(/saveSuccess && \(\s*<p aria-live="polite"/);
  });
});

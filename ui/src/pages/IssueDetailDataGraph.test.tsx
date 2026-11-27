/** @vitest-environment jsdom */
//
// IssueDetail "연결 맥락 (Data Graph · 2-hop)" 접힘 섹션 동작 검증.
// 기본은 접혀 있어 DataGraphContextPanel이 마운트되지 않아야 하고(= queryDataGraph 0회,
// 기본 페이지 로드에 추가 API 호출 없음), 토글을 열 때 seedKind="issue"로 마운트되어야 한다.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { IssueDetail } from "./IssueDetail";

const harness = vi.hoisted(() => ({
  DataGraphContextPanel: vi.fn((props: Record<string, unknown>) => (
    <section data-testid="data-graph-context-panel" data-seed-kind={String(props.seedKind)} />
  )),
  queryDataGraph: vi.fn(),
}));

vi.mock("../api/data-graph", () => ({
  dataGraphApi: { queryDataGraph: harness.queryDataGraph },
}));

vi.mock("../components/DataGraphContextPanel", () => ({
  DataGraphContextPanel: harness.DataGraphContextPanel,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "issues" && queryKey[1] === "detail") {
      return {
        data: {
          id: "issue-1",
          identifier: "ISS-1",
          title: "Graph panel issue",
          description: "Issue body",
          status: "todo",
          priority: "medium",
          companyId: "company-1",
          projectId: null,
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          ancestors: [],
          labels: [],
        },
        isLoading: false,
        error: null,
      };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: (previous: unknown) => previous,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ issueId: "issue-1" }),
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", canWrite: true }),
}));
vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ openPanel: vi.fn(), closePanel: vi.fn(), panelVisible: false, setPanelVisible: vi.fn() }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <span>{value || placeholder}</span>
  ),
}));
vi.mock("../components/CommentThread", () => ({
  CommentThread: () => <section data-component="CommentThread" />,
}));
vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <section data-component="IssueDocumentsSection" />,
}));
vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: () => null,
}));

let host: HTMLDivElement;
let root: Root;

const toggleButton = () =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("연결 맥락"));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.DataGraphContextPanel.mockClear();
  harness.queryDataGraph.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("IssueDetail Data Graph context section", () => {
  it("renders the section collapsed by default without mounting the panel or querying the graph", async () => {
    await act(async () => {
      root.render(<IssueDetail />);
    });
    expect(toggleButton()).toBeDefined();
    expect(host.querySelector('[data-testid="data-graph-context-panel"]')).toBeNull();
    expect(harness.DataGraphContextPanel).not.toHaveBeenCalled();
    expect(harness.queryDataGraph).not.toHaveBeenCalled();
  });

  it("mounts DataGraphContextPanel with seedKind=issue when the section is expanded", async () => {
    await act(async () => {
      root.render(<IssueDetail />);
    });
    await act(async () => toggleButton()!.click());
    const panel = host.querySelector('[data-testid="data-graph-context-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-seed-kind")).toBe("issue");
    expect(harness.DataGraphContextPanel.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        companyId: "company-1",
        seedKind: "issue",
        seedId: "issue-1",
        maxHops: 2,
        includeContextPack: true,
      }),
    );
  });
});

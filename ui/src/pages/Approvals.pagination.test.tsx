/** @vitest-environment jsdom */
// Explicit server-backed paging for the Approvals page: per-tab status window, page navigation,
// tab/company reset, pinned revision-requested rows on the Pending tab, loading state and scroll-to-top.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";
import { approvalsApi } from "../api/approvals";
import { PAGE_SIZE } from "../components/CompactPagination";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = { companyId: "company-1" as string | null, route: "/approvals/pending" };
const navigateSpy = vi.fn((to: string) => { state.route = to; });
/** The real Tabs wires `onValueChange` through Radix context; the mocked Tabs publishes it here. */
const tabs = vi.hoisted(() => ({ onChange: undefined as ((value: string) => void) | undefined }));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: vi.fn((companyId: string, filter?: unknown) => Promise.resolve(respond(companyId, filter))),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/CompanyContext")>()),
  useCompany: () => ({ selectedCompanyId: state.companyId }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateSpy,
  useLocation: () => ({ pathname: state.route }),
}));
vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: ({ approval }: { approval: { id: string; status: string } }) => (
    <article data-approval={approval.id} data-status={approval.status}>{approval.id}</article>
  ),
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, onValueChange }: { children?: ReactNode; onValueChange?: (value: string) => void }) => {
    tabs.onChange = onValueChange;
    return <div data-tabs-root>{children}</div>;
  },
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items, value }: { items: { value: string; label: ReactNode }[]; value?: string }) => (
    <div data-tabs>
      {items.map((item) => (
        <button key={item.value} type="button" data-tab={item.value} aria-pressed={value === item.value} onClick={() => tabs.onChange?.(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));

type Row = { id: string; companyId: string; status: string; createdAt: string; requestedByAgentId: null; type: string; payload: null };
const COUNTS = { pending: 120, revision_requested: 3, approved: 200 } as const;
/** Minutes-ago multipliers that interleave statuses in time so the All tab mixes them on every page. */
const AGE_FACTOR: Record<string, number> = { pending: 7, revision_requested: 1000, approved: 2 };
const DATASET: Row[] = [];
for (const [status, count] of Object.entries(COUNTS)) {
  for (let i = 0; i < count; i += 1) {
    DATASET.push({
      id: `${status}-${i}`,
      companyId: "company-1",
      status,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - (AGE_FACTOR[status] * i + (status === "approved" ? 1 : 0)) * 60_000).toISOString(),
      requestedByAgentId: null,
      type: "mission_plan",
      payload: null,
    });
  }
}
type ListImpl = (companyId: string, filter?: unknown) => Promise<Row[]>;
const asListImpl = (impl: ListImpl) => impl as unknown as typeof approvalsApi.list;
/** Mirrors the server route: exact status match, newest first, SQL limit/offset. */
function respond(companyId: string, filter?: unknown): Row[] {
  if (companyId !== "company-1") return [{ ...DATASET[0], id: "company-2-only", companyId }];
  const f = (typeof filter === "string" ? { status: filter } : filter ?? {}) as { status?: string; limit?: number; offset?: number };
  const rows = f.status ? DATASET.filter((row) => row.status === f.status) : DATASET;
  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200));
}

let root: Root | null = null;
let queryClient: QueryClient | null = null;
const container = document.createElement("div");
const scrollToSpy = vi.fn();

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render() {
  if (!root) {
    document.body.appendChild(container);
    root = createRoot(container);
  }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient!}><Approvals /></QueryClientProvider>);
  });
  await flush();
  await flush();
}
async function rerender() {
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient!}><Approvals /></QueryClientProvider>);
  });
  await flush();
  await flush();
}
async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}
const button = (name: string) => [...container.querySelectorAll("nav button")].find((b) => b.textContent?.trim() === name);
const tab = (key: string) => container.querySelector<HTMLButtonElement>(`button[data-tab="${key}"]`);
const bar = () => container.querySelector("nav[aria-label='Approvals pagination']")!;
const barText = () => bar().textContent ?? "";
const rows = () => [...container.querySelectorAll("[data-approval]")] as HTMLElement[];
const listCalls = () => vi.mocked(approvalsApi.list).mock.calls;
const windowCalls = (companyId: string) =>
  listCalls().filter(([cid, filter]) => cid === companyId && typeof filter === "object" && filter !== null && "offset" in filter) as unknown as [string, { status?: string; limit: number; offset: number }][];

beforeEach(() => {
  vi.mocked(approvalsApi.list).mockClear();
  navigateSpy.mockClear();
  state.companyId = "company-1";
  state.route = "/approvals/pending";
  window.scrollTo = scrollToSpy;
  scrollToSpy.mockReset();
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  queryClient?.clear();
  container.remove();
});

describe("Approvals explicit paging", () => {
  it("requests the Pending tab window with the server status filter and limit PAGE_SIZE+1, and pins revision-requested rows", async () => {
    await render();
    expect(windowCalls("company-1")).toEqual([
      ["company-1", { status: "pending", limit: PAGE_SIZE + 1, offset: 0 }],
      ["company-1", { status: "pending", limit: PAGE_SIZE + 1, offset: PAGE_SIZE }], // next-page prefetch
    ]);
    // Unfiltered snapshot (strip/queue counts) + actionable follow-up rows for the Pending tab.
    expect(listCalls().some(([cid, filter]) => cid === "company-1" && filter === undefined)).toBe(true);
    expect(listCalls()).toContainEqual(["company-1", { status: "revision_requested", limit: PAGE_SIZE + 1 }]);

    const group = container.querySelector('section[aria-label="Revision requested"]')!;
    expect(group.querySelectorAll("[data-approval]")).toHaveLength(COUNTS.revision_requested);
    expect(([...group.querySelectorAll<HTMLElement>("[data-approval]")]).every((row) => row.dataset.status === "revision_requested")).toBe(true);
    expect(rows()).toHaveLength(PAGE_SIZE + COUNTS.revision_requested);
    expect(rows().filter((row) => row.dataset.status === "pending")).toHaveLength(PAGE_SIZE);
    expect(barText()).toContain("Page 1");
    expect(barText()).toContain("Showing 1–50");
    expect(button("Prev")).toHaveProperty("disabled", true);
    expect(button("Next")).toHaveProperty("disabled", false);
    // Strip/queue counts come from the unfiltered snapshot (server default limit 200 → 45 pending + 1 revision here).
    expect([...container.querySelectorAll('[aria-label="Approvals by status"] b')].map((b) => b.textContent)).toEqual(["45", "1", "154", "0", "0", "46"]);
    expect(container.querySelector(".cockpit-toolbar b.font-mono")?.textContent).toBe(String(PAGE_SIZE + COUNTS.revision_requested));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("pages through pending rows with Prev/Next and scrolls to top on every page change", async () => {
    await render();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");
    expect(barText()).toContain("Showing 51–100");
    expect(rows().filter((row) => row.dataset.status === "pending")[0].dataset.approval).toBe("pending-50");
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    await flush();

    await click(button("Next"));
    expect(barText()).toContain("Page 3");
    expect(barText()).toContain("Showing 101–120");
    expect(rows().filter((row) => row.dataset.status === "pending")).toHaveLength(20);
    expect(button("Next")).toHaveProperty("disabled", true);
    // The revision-requested group stays pinned on every Pending-tab page.
    expect(container.querySelectorAll('section[aria-label="Revision requested"] [data-approval]')).toHaveLength(COUNTS.revision_requested);

    await click(button("Prev"));
    expect(barText()).toContain("Page 2");
    expect(scrollToSpy).toHaveBeenCalledTimes(3);
    expect(new Set(windowCalls("company-1").map(([, f]) => f.offset))).toEqual(new Set([0, PAGE_SIZE, 2 * PAGE_SIZE]));
  });

  it("resets to page 1 when the tab changes and drops the status filter on the All tab", async () => {
    await render();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");

    await click(tab("all"));
    expect(navigateSpy).toHaveBeenCalledWith("/approvals/all");
    await rerender();
    expect(barText()).toContain("Page 1");
    expect(windowCalls("company-1")).toContainEqual(["company-1", { status: undefined, limit: PAGE_SIZE + 1, offset: 0 }]);
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(container.querySelector('section[aria-label="Revision requested"]')).toBeNull();
    expect(new Set(rows().map((row) => row.dataset.status))).toEqual(new Set(["pending", "revision_requested", "approved"]));
    expect(button("Next")).toHaveProperty("disabled", false);
  });

  it("resets to page 1 when the company changes and requests the new company's first page", async () => {
    await render();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");

    state.companyId = "company-2";
    await rerender();
    expect(barText()).toContain("Page 1");
    const company2 = windowCalls("company-2");
    expect(company2[0]).toEqual(["company-2", { status: "pending", limit: PAGE_SIZE + 1, offset: 0 }]);
    expect(rows()[0].dataset.approval).toBe("company-2-only");
  });

  it("shows the inline loading indicator while the next page is in flight and keeps the previous rows", async () => {
    let release!: (value: Row[]) => void;
    const pending = new Promise<Row[]>((resolve) => { release = resolve; });
    vi.mocked(approvalsApi.list).mockImplementation(asListImpl((companyId, filter) => {
      const f = (typeof filter === "object" && filter) as { offset?: number } | undefined;
      if (companyId === "company-1" && f?.offset === PAGE_SIZE) return pending;
      return Promise.resolve(respond(companyId, filter));
    }));
    await render();
    expect(bar().getAttribute("aria-busy")).toBe("false");
    expect(rows()).toHaveLength(PAGE_SIZE + COUNTS.revision_requested);

    await click(button("Next"));
    expect(bar().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(barText()).toContain("Page 2");
    // keepPreviousData: page 1 rows stay visible (dimmed) until page 2 arrives.
    expect(rows().filter((row) => row.dataset.status === "pending")[0].dataset.approval).toBe("pending-0");

    const page2 = respond("company-1", { status: "pending", limit: PAGE_SIZE + 1, offset: PAGE_SIZE });
    await act(async () => { release(page2); });
    await flush();
    expect(bar().getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(rows().filter((row) => row.dataset.status === "pending")[0].dataset.approval).toBe("pending-50");
    expect(barText()).toContain("Showing 51–100");
  });

  it("shows the empty state only once the page request has settled with no rows", async () => {
    vi.mocked(approvalsApi.list).mockImplementation(asListImpl(async (_companyId, filter) => {
      const f = (typeof filter === "object" && filter) as { status?: string; offset?: number } | undefined;
      if (f?.status) return [];
      return respond("company-1", filter);
    }));
    await render();
    expect(container.textContent).toContain("No pending approvals.");
    expect(rows()).toHaveLength(0);
    expect(barText()).toContain("Showing —");
    expect(button("Next")).toHaveProperty("disabled", true);
  });
});

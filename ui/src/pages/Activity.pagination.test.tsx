/** @vitest-environment jsdom */
// Explicit server-backed paging for the Activity page: window math, page navigation,
// filter/company reset, prefetch, loading indicator and scroll-to-top.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "./Activity";
import { PAGE_SIZE, pageOffset, showingRange, splitFetchedPage } from "../components/CompactPagination";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const http = vi.hoisted(() => ({
  calls: [] as string[],
  respond: null as null | ((url: string) => Promise<unknown> | unknown),
}));

vi.mock("../api/client", () => ({
  api: {
    get: (url: string) => {
      http.calls.push(url);
      return Promise.resolve(http.respond ? http.respond(url) : defaultRespond(url));
    },
  },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/ActivityRow", () => ({
  ActivityRow: ({ event }: { event: { id: string; action: string; entityType: string } }) => (
    <article data-event={event.id} data-type={event.entityType}>{event.action}</article>
  ),
}));
vi.mock("../components/OperatorDecisionActivity", () => ({
  OperatorDecisionActivity: ({ event }: { event: { id: string; action: string } }) => <article data-event={event.id}>{event.action}</article>,
}));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div data-testid="empty">{message}</div> }));

const state = { companyId: "company-1" as string | null };
const TOTAL_EVENTS = 120;
const EVENTS = Array.from({ length: TOTAL_EVENTS }, (_, i) => ({
  id: `event-${i}`,
  action: i % 2 === 0 ? "mission.updated" : "agent.heartbeat",
  entityType: i % 2 === 0 ? "mission" : "agent",
  actorId: "actor-1",
  agentId: null,
  details: null,
  createdAt: new Date(Date.now() - i * 1000).toISOString(),
}));
const windowOf = (url: string) => {
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  return { limit: Number(params.get("limit")), offset: Number(params.get("offset") ?? 0) };
};
function defaultRespond(url: string) {
  if (!url.includes("/activity?")) return [];
  const { limit, offset } = windowOf(url);
  return EVENTS.slice(offset, offset + limit);
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
    root!.render(<QueryClientProvider client={queryClient!}><Activity /></QueryClientProvider>);
  });
  await flush();
}
async function rerender() {
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient!}><Activity /></QueryClientProvider>);
  });
  await flush();
}
async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}
const button = (name: string) => [...container.querySelectorAll("nav button")].find((b) => b.textContent?.trim() === name);
const tab = (label: string) => [...container.querySelectorAll('[aria-label="활동 유형 필터"] button')].find((b) => b.textContent?.startsWith(label));
const bar = () => container.querySelector("nav[aria-label='Pagination']")!;
const barText = () => bar().textContent ?? "";
const rows = () => [...container.querySelectorAll("[data-event]")] as HTMLElement[];
const activityCalls = () => http.calls.filter((u) => u.includes("/activity?"));

beforeEach(() => {
  http.calls.length = 0;
  http.respond = null;
  state.companyId = "company-1";
  window.scrollTo = scrollToSpy;
  scrollToSpy.mockReset();
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  queryClient?.clear();
  container.remove();
});

describe("pagination window helpers", () => {
  it("maps 1-based pages to SQL offsets and splits a limit+1 fetch", () => {
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(3)).toBe(2 * PAGE_SIZE);
    expect(pageOffset(0)).toBe(0);
    const full = splitFetchedPage(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => i));
    expect(full.items).toHaveLength(PAGE_SIZE);
    expect(full.hasMore).toBe(true);
    expect(splitFetchedPage(EVENTS)).toEqual({ items: EVENTS.slice(0, PAGE_SIZE), hasMore: true });
    expect(splitFetchedPage([])).toEqual({ items: [], hasMore: false });
    expect(splitFetchedPage(undefined)).toEqual({ items: [], hasMore: false });
    expect(showingRange(2, 20)).toEqual({ from: 51, to: 70 });
    expect(showingRange(2, 0)).toBeNull();
  });
});

describe("Activity explicit paging", () => {
  it("loads page 1 with limit PAGE_SIZE+1, renders 50 rows and prefetches the next page", async () => {
    await render();
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(rows()[0].dataset.event).toBe("event-0");
    expect(activityCalls()[0]).toBe(`/companies/company-1/activity?limit=${PAGE_SIZE + 1}&offset=0`);
    await flush();
    expect(activityCalls()).toContain(`/companies/company-1/activity?limit=${PAGE_SIZE + 1}&offset=${PAGE_SIZE}`);
    expect(barText()).toContain("Page 1");
    expect(barText()).toContain("Showing 1–50");
    expect(button("Prev")).toHaveProperty("disabled", true);
    expect(button("Next")).toHaveProperty("disabled", false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(container.querySelector("[data-testid='empty']")).toBeNull();
  });

  it("navigates forward and back with Prev/Next, updating Page N / Showing and scrolling to top", async () => {
    await render();
    await flush();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");
    expect(barText()).toContain("Showing 51–100");
    expect(rows()[0].dataset.event).toBe(`event-${PAGE_SIZE}`);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    await flush();
    // Page 3 was prefetched while on page 2; it is the last (partial) page.
    expect(activityCalls()).toContain(`/companies/company-1/activity?limit=${PAGE_SIZE + 1}&offset=${2 * PAGE_SIZE}`);

    await click(button("Next"));
    expect(barText()).toContain("Page 3");
    expect(barText()).toContain("Showing 101–120");
    expect(rows()).toHaveLength(TOTAL_EVENTS - 2 * PAGE_SIZE);
    expect(button("Next")).toHaveProperty("disabled", true);
    expect(button("Prev")).toHaveProperty("disabled", false);

    await click(button("Prev"));
    expect(barText()).toContain("Page 2");
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(scrollToSpy).toHaveBeenCalledTimes(3);
  });

  it("resets to page 1 when the category filter changes and keeps the filter client-side on that page", async () => {
    await render();
    await flush();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");
    const callsBefore = activityCalls().length;

    await click(tab("미션"));
    expect(barText()).toContain("Page 1");
    expect(rows().every((row) => row.dataset.type === "mission")).toBe(true);
    expect(rows()).toHaveLength(PAGE_SIZE / 2);
    // The filter is client-side: only page 1 is (re)requested for it — never a stale page-2 window.
    expect(activityCalls().slice(callsBefore).every((url) => windowOf(url).offset === 0)).toBe(true);
    expect([...container.querySelectorAll('[aria-label="활동 유형별 건수"] b')][1].textContent).toBe(String(PAGE_SIZE / 2));
  });

  it("resets to page 1 when the company changes and requests the new company's first page", async () => {
    await render();
    await flush();
    await click(button("Next"));
    expect(barText()).toContain("Page 2");

    state.companyId = "company-2";
    await rerender();
    await flush();
    expect(barText()).toContain("Page 1");
    expect(activityCalls().find((url) => url.includes("company-2"))).toBe(`/companies/company-2/activity?limit=${PAGE_SIZE + 1}&offset=0`);
    expect(activityCalls().some((u) => u.includes("company-2") && u.includes(`offset=${PAGE_SIZE}`))).toBe(true);
  });

  it("shows the inline loading indicator while a new page is in flight and keeps the previous rows", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    http.respond = (url) => (windowOf(url).offset === PAGE_SIZE ? pending : defaultRespond(url));
    await render();
    await flush();
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(bar().getAttribute("aria-busy")).toBe("false");

    await click(button("Next"));
    expect(bar().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    // keepPreviousData: page 1 rows stay visible (dimmed) until page 2 arrives.
    expect(rows()[0].dataset.event).toBe("event-0");
    expect(barText()).toContain("Page 2");

    await act(async () => { release(EVENTS.slice(PAGE_SIZE, 2 * PAGE_SIZE + 1)); });
    await flush();
    expect(bar().getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(rows()[0].dataset.event).toBe(`event-${PAGE_SIZE}`);
    expect(barText()).toContain("Showing 51–100");
  });

  it("steps back when the current page becomes empty after a refetch", async () => {
    await render();
    await flush();
    await click(button("Next"));
    await click(button("Next"));
    expect(barText()).toContain("Page 3");

    http.respond = (url) => (windowOf(url).offset >= 2 * PAGE_SIZE ? [] : defaultRespond(url));
    queryClient!.invalidateQueries({ queryKey: ["activity", "company-1"] });
    await flush();
    await flush();
    expect(barText()).toContain("Page 2");
    expect(rows()).toHaveLength(PAGE_SIZE);
  });
});

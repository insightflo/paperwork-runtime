/** @vitest-environment jsdom */
// Real DOM interactions for the Work list's server-backed paging chrome.

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUES_PAGE_SIZE,
  IssuesPagination,
  hasIssuePageMore,
  issuePageQueryFilters,
  issuePageRequestFilters,
  issueWindowRows,
  prefetchIssuePage,
  useIssuePaging,
} from "./IssuesListChrome";
import { IssuesList } from "./IssuesList";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";

const issuesApiList = vi.mocked(issuesApi.list);
vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn(), listLabels: vi.fn() },
  ACTIVE_ISSUE_STATUS_FILTER: "backlog,todo,in_progress,in_review,blocked",
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));
// IssuesList only reads session/labels/search through useQuery; none are needed for the paging wiring.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
// Stable like a real `useRef` target: the hook scrolls on page changes, not on every render.
const scrollTarget = { current: null as HTMLElement | null };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  host = document.createElement("div");
  scrollTarget.current = host;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function click(element: Element | null, init: MouseEventInit = {}) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

describe("issue page window helpers", () => {
  it("requests one extra row so hasMore needs no count query", () => {
    expect(ISSUES_PAGE_SIZE).toBe(50);
    expect(issuePageRequestFilters("todo", 1)).toEqual({ status: "todo", limit: 51, offset: 0 });
    expect(issuePageRequestFilters("todo", 3)).toEqual({ status: "todo", limit: 51, offset: 100 });
    expect(issuePageRequestFilters("todo", 0)).toEqual({ status: "todo", limit: 51, offset: 0 });
  });

  it("hashes the same window as strings inside the list query key", () => {
    expect(issuePageQueryFilters("done", 2)).toEqual({ status: "done", limit: "51", offset: "50" });
    expect(Object.keys(queryKeys.issues.list("company-1", issuePageQueryFilters("done", 2)))).toHaveLength(3);
  });

  it("detects a following page and trims the sentinel row", () => {
    expect(hasIssuePageMore(undefined)).toBe(false);
    expect(hasIssuePageMore(Array.from({ length: 50 }))).toBe(false);
    expect(hasIssuePageMore(Array.from({ length: 51 }))).toBe(true);
    expect(issueWindowRows(Array.from({ length: 51 }, (_, i) => i))).toHaveLength(50);
    expect(issueWindowRows(undefined)).toEqual([]);
  });
});

describe("useIssuePaging", () => {
  const renders: number[] = [];
  const scrollIntoView = vi.fn();

  function Probe({ resetKey }: { resetKey: string }) {
    const paging = useIssuePaging({ resetKey, scrollTarget });
    renders.push(paging.page);
    return (
      <div>
        <span data-page={paging.page} />
        <button type="button" onClick={paging.goToNext}>next</button>
        <button type="button" onClick={paging.goToPrev}>prev</button>
      </div>
    );
  }

  beforeEach(() => {
    renders.length = 0;
    scrollIntoView.mockClear();
    host.scrollIntoView = scrollIntoView;
  });

  it("moves forward and back with Next / Prev and never drops below page 1", async () => {
    await act(async () => root.render(<Probe resetKey="a" />));
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("1");
    expect(scrollIntoView).not.toHaveBeenCalled();

    await click(button("next"));
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("2");
    await click(button("next"));
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("3");
    await click(button("prev"));
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("2");
    await click(button("prev"));
    await click(button("prev"));
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("1");

    expect(scrollIntoView).toHaveBeenCalledTimes(4);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("resets to page 1 in the same render when the filter key changes (no stale page request)", async () => {
    await act(async () => root.render(<Probe resetKey="company-1|all|no-filters" />));
    await click(button("next"));
    await click(button("next"));
    expect(renders.at(-1)).toBe(3);

    renders.length = 0;
    await act(async () => root.render(<Probe resetKey="company-1|blocked|no-filters" />));
    expect(renders).toEqual([1]);
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("1");
  });

  it("keeps the current page while the filter key stays the same", async () => {
    await act(async () => root.render(<Probe resetKey="same" />));
    await click(button("next"));
    renders.length = 0;
    await act(async () => root.render(<Probe resetKey="same" />));
    expect(renders).toEqual([2]);
  });
});

describe("IssuesPagination", () => {
  const base = { page: 2, rowCount: 50, hasMore: true, isFetching: false, onPrev: vi.fn(), onNext: vi.fn() };

  function renderBar(props: Partial<ComponentProps<typeof IssuesPagination>> = {}) {
    return act(async () => root.render(<IssuesPagination {...base} {...props} />));
  }

  it("shows Prev / Page N / Showing X–Y / Next with the right disabled states", async () => {
    await renderBar();
    const text = host.querySelector("nav")?.textContent ?? "";
    expect(text).toContain("Page 2");
    expect(text).toContain("Showing 51–100");
    expect(button("Prev").disabled).toBe(false);
    expect(button("Next").disabled).toBe(false);
    expect(host.querySelector("[data-spinner]")).toBeNull();

    await click(button("Prev"));
    await click(button("Next"));
    expect(base.onPrev).toHaveBeenCalledTimes(1);
    expect(base.onNext).toHaveBeenCalledTimes(1);

    await renderBar({ page: 1, rowCount: 12, hasMore: false });
    expect(host.querySelector("nav")?.textContent).toContain("Showing 1–12");
    expect(button("Prev").disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);
  });

  it("shows the spinner and blocks both buttons while the next/prev page is loading", async () => {
    await renderBar({ isFetching: true });
    const nav = host.querySelector("nav");
    expect(nav?.getAttribute("aria-busy")).toBe("true");
    expect(nav?.querySelector("[data-spinner] .animate-spin")).not.toBeNull();
    expect(button("Prev").disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);
    await click(button("Next"));
    expect(base.onNext).not.toHaveBeenCalled();
  });

  it("prefetches the next page on hover and focus of Next, never when there is no next page", async () => {
    const onPrefetchNext = vi.fn();
    await renderBar({ onPrefetchNext });
    const next = button("Next");
    await act(async () => next.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(async () => next.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(onPrefetchNext).toHaveBeenCalledTimes(2);

    await renderBar({ onPrefetchNext, hasMore: false });
    await act(async () => button("Next").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(onPrefetchNext).toHaveBeenCalledTimes(2);
  });
});

describe("prefetchIssuePage", () => {
  it("warms the exact query key and window the list uses for the next page", async () => {
    const queryClient = new QueryClient();
    issuesApiList.mockResolvedValue([]);
    await prefetchIssuePage(queryClient, "company-1", "todo,backlog", 2);
    expect(issuesApiList).toHaveBeenCalledWith("company-1", { status: "todo,backlog", limit: 51, offset: 50 });
    expect(queryClient.getQueryData(queryKeys.issues.list("company-1", issuePageQueryFilters("todo,backlog", 2)))).toEqual([]);
    await prefetchIssuePage(queryClient, "company-1", "todo,backlog", 2);
    expect(issuesApiList).toHaveBeenCalledTimes(1);
  });
});

describe("IssuesList filter reporting", () => {
  it("reports the active client-side filter count so the page can leave paging mode and reset the page", async () => {
    // Seeded persisted view state: one status filter active before first render.
    localStorage.setItem("paperclip:issues-view:company-1", JSON.stringify({ statuses: ["backlog"] }));
    const onFiltersChange = vi.fn();
    await act(async () => root.render(
      <IssuesList
        issues={[]}
        viewStateKey="paperclip:issues-view"
        onFiltersChange={onFiltersChange}
        onUpdateIssue={vi.fn()}
      />,
    ));
    expect(onFiltersChange).toHaveBeenLastCalledWith(1);

    // The trigger's clear (X) control drops every client filter.
    const clear = host.querySelector<HTMLButtonElement>("button > svg.lucide-x");
    expect(clear).not.toBeNull();
    await click(clear!);
    expect(onFiltersChange).toHaveBeenLastCalledWith(0);
  });
});

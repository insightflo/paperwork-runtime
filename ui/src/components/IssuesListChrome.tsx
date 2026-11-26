import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

/* ── Page-owned chrome for the IssuesList ──
 * The Work page restyles the IssuesList from the outside instead of growing the
 * legacy component. This module holds those restyle selectors and the
 * server-backed paging bar that replaced full-list scroll loading. */

/* Restyle hooks for the IssuesList chrome.
 * The component contract is unchanged; the page-owned wrapper restyles its
 * toolbar and rows. Tailwind only emits candidates that appear verbatim in
 * source, so every selector is spelled out here rather than composed. */
export const ISSUES_TOOLBAR_CLASS = [
  // 40px single-row cockpit toolbar
  "[&>div>div:first-child]:h-auto",
  "[&>div>div:first-child]:sm:h-10",
  "[&>div>div:first-child]:rounded-md",
  "[&>div>div:first-child]:border",
  "[&>div>div:first-child]:border-[#242d3f]",
  "[&>div>div:first-child]:bg-[#111622]",
  "[&>div>div:first-child]:py-0",
  "[&>div>div:first-child]:pl-2",
  "[&>div>div:first-child]:pr-1.5",
  // Deep-cobalt "+ New" CTA
  "[&>div>div:first-child>div:first-child>button:first-child]:h-7",
  "[&>div>div:first-child>div:first-child>button:first-child]:rounded-md",
  "[&>div>div:first-child>div:first-child>button:first-child]:border-[#5f8dff]/50",
  "[&>div>div:first-child>div:first-child>button:first-child]:bg-[#2563eb]",
  "[&>div>div:first-child>div:first-child>button:first-child]:font-semibold",
  "[&>div>div:first-child>div:first-child>button:first-child]:text-[#f8fafc]",
  "[&>div>div:first-child>div:first-child>button:first-child]:shadow-[inset_0_0_0_1px_rgba(95,141,255,0.45)]",
  "[&>div>div:first-child>div:first-child>button:first-child]:hover:bg-[#1d4ed8]",
  // Search field
  "[&>div>div:first-child>div:first-child_input]:h-7",
  "[&>div>div:first-child>div:first-child_input]:rounded-md",
  "[&>div>div:first-child>div:first-child_input]:border-[#242d3f]",
  "[&>div>div:first-child>div:first-child_input]:bg-[#0b0e14]",
  "[&>div>div:first-child>div:first-child_input]:text-[#e6edf7]",
  "[&>div>div:first-child>div:first-child_input]:placeholder:text-[#8b97ad]",
  "[&>div>div:first-child>div:first-child_input]:focus-visible:border-[#5f8dff]",
  "[&>div>div:first-child>div:first-child_input]:focus-visible:ring-[#5f8dff]/40",
  // View-mode toggle (list / board) styled as status tabs
  "[&>div>div:first-child>div:last-child>div:first-child]:rounded-md",
  "[&>div>div:first-child>div:last-child>div:first-child]:border-[#242d3f]",
  "[&>div>div:first-child>div:last-child>div:first-child]:bg-[#0b0e14]",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:h-6",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:w-7",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:p-0",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:text-[#8b97ad]",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:hover:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:bg-[#151b28]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>div:first-child>button.bg-accent]:shadow-[inset_0_0_0_1px_#242d3f]",
  // Filter / Sort / Group
  "[&>div>div:first-child>div:last-child>button]:h-7",
  "[&>div>div:first-child>div:last-child>button]:rounded-md",
  "[&>div>div:first-child>div:last-child>button]:text-xs",
  "[&>div>div:first-child>div:last-child>button]:text-[#8b97ad]",
  "[&>div>div:first-child>div:last-child>button]:hover:bg-[#151b28]",
  "[&>div>div:first-child>div:last-child>button]:hover:text-[#e6edf7]",
  "[&>div>div:first-child>div:last-child>button.text-blue-600]:text-[#5f8dff]",
  // Group headers
  "[&_button[data-state]]:text-[11px]",
  "[&_button[data-state]]:uppercase",
  "[&_button[data-state]]:tracking-[0.08em]",
  "[&_button[data-state]]:text-[#8b97ad]",
  // High-density rows with crisp hairlines
  "[&_[data-state=open]>a[href^='/issues']]:border-[#242d3f]",
  "[&_[data-state=open]>a[href^='/issues']]:sm:py-1.5",
  // j/k selection highlight
  "[&_[data-state=open]>a[data-pw-selected=true]]:bg-[#151b28]",
  "[&_[data-state=open]>a[data-pw-selected=true]]:shadow-[inset_2px_0_0_#5f8dff]",
].join(" ");

/* ── Server-backed paging ── */

export const ISSUES_PAGE_SIZE = 50;
/** A hovered/focused Next should not re-fetch a page that was prefetched moments ago. */
export const ISSUES_PREFETCH_STALE_MS = 30_000;

export const issuePageOffset = (page: number) => (Math.max(1, Math.floor(page)) - 1) * ISSUES_PAGE_SIZE;

/** API filters: one extra row is requested so `hasMore` needs no COUNT query. */
export function issuePageRequestFilters(status: string, page: number) {
  return { status, limit: ISSUES_PAGE_SIZE + 1, offset: issuePageOffset(page) };
}

/** React-query key filters: same window, hashed as strings inside the existing list key. */
export function issuePageQueryFilters(status: string, page: number) {
  const { limit, offset } = issuePageRequestFilters(status, page);
  return { status, limit: String(limit), offset: String(offset) };
}

export const issueWindowRows = <T,>(rows: readonly T[] | undefined): T[] => (rows ?? []).slice(0, ISSUES_PAGE_SIZE);
export const hasIssuePageMore = (rows: readonly unknown[] | undefined): boolean => (rows?.length ?? 0) > ISSUES_PAGE_SIZE;

interface IssuePagingOptions {
  /** Any change (company, status tab, search, client filters) sends the list back to page 1. */
  resetKey: string;
  /** Scrolled back into view whenever the page changes after the first render. */
  scrollTarget: RefObject<HTMLElement | null>;
}

/**
 * Page state for the Work list. The page is stored together with the reset key it
 * belongs to, so a changed key reads as page 1 in the very same render — no
 * effect, no wasted request for a stale page N.
 */
export function useIssuePaging({ resetKey, scrollTarget }: IssuePagingOptions) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const page = state.key === resetKey ? state.page : 1;

  const setPage = useCallback(
    (next: number) => setState((prev) => {
      const page = Math.max(1, Math.floor(next));
      return prev.key === resetKey && prev.page === page ? prev : { key: resetKey, page };
    }),
    [resetKey],
  );
  const goToNext = useCallback(() => setPage(page + 1), [page, setPage]);
  const goToPrev = useCallback(() => setPage(page - 1), [page, setPage]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scrollTarget.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [page, scrollTarget]);

  return { page, setPage, goToNext, goToPrev };
}

export type IssuePaging = ReturnType<typeof useIssuePaging>;

/* ── Pagination bar ── */

const PAGER_BUTTON_CLASS = [
  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium",
  "text-[#8b97ad] hover:bg-[#151b28] hover:text-[#e6edf7]",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5f8dff]",
  "disabled:cursor-default disabled:bg-transparent disabled:text-[#8b97ad]/50 disabled:hover:bg-transparent",
].join(" ");

interface IssuesPaginationProps {
  page: number;
  /** Rows rendered on this page (already trimmed to the page size). */
  rowCount: number;
  hasMore: boolean;
  /** True while the previous/next page request is in flight; shows the spinner. */
  isFetching: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Warms the next page before the click so Next feels instant. */
  onPrefetchNext?: () => void;
}

export function IssuesPagination({
  page,
  rowCount,
  hasMore,
  isFetching,
  onPrev,
  onNext,
  onPrefetchNext,
}: IssuesPaginationProps) {
  const offset = issuePageOffset(page);
  const from = rowCount === 0 ? 0 : offset + 1;
  const to = offset + rowCount;
  const busy = isFetching || undefined;

  return (
    <nav
      aria-label="Work items pages"
      aria-busy={busy}
      data-fetching={busy}
      className="cockpit-strip w-full justify-between"
    >
      <button type="button" className={PAGER_BUTTON_CLASS} disabled={page <= 1 || isFetching} onClick={onPrev}>
        <ChevronLeft className="h-3 w-3" aria-hidden />
        Prev
      </button>
      <span className="cockpit-cell gap-2" role="status" aria-live="polite">
        <span
          className="inline-flex h-3 w-3 items-center justify-center text-[#5f8dff]"
          data-spinner={busy || undefined}
          aria-hidden
        >
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </span>
        <span>
          Page <b>{page}</b>
        </span>
        <span className="text-[#8b97ad]">
          Showing {from}–{to}
        </span>
      </span>
      <button
        type="button"
        className={PAGER_BUTTON_CLASS}
        disabled={!hasMore || isFetching}
        onMouseEnter={onPrefetchNext}
        onFocus={onPrefetchNext}
        onClick={onNext}
      >
        Next
        <ChevronRight className="h-3 w-3" aria-hidden />
      </button>
    </nav>
  );
}

/** Prefetch signature shared by the hover/focus trigger and the post-settle warm-up. */
export function prefetchIssuePage(queryClient: QueryClient, companyId: string, status: string, page: number) {
  return queryClient.prefetchQuery({
    queryKey: queryKeys.issues.list(companyId, issuePageQueryFilters(status, page)),
    queryFn: () => issuesApi.list(companyId, issuePageRequestFilters(status, page)),
    staleTime: ISSUES_PREFETCH_STALE_MS,
  });
}

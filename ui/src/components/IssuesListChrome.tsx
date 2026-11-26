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
  // 40px single-row tactile cockpit toolbar
  "[&>div>div:first-child]:h-auto",
  "[&>div>div:first-child]:sm:h-10",
  "[&>div>div:first-child]:rounded-[10px]",
  "[&>div>div:first-child]:border",
  "[&>div>div:first-child]:border-slate-200/90",
  "dark:[&>div>div:first-child]:border-white/[0.08]",
  "[&>div>div:first-child]:bg-white/95",
  "dark:[&>div>div:first-child]:bg-[#0e131d]",
  "[&>div>div:first-child]:py-0",
  "[&>div>div:first-child]:pl-2",
  "[&>div>div:first-child]:pr-1.5",
  "[&>div>div:first-child]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]",
  "dark:[&>div>div:first-child]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
  // Cobalt "+ New" CTA
  "[&>div>div:first-child>div:first-child>button:first-child]:h-7",
  "[&>div>div:first-child>div:first-child>button:first-child]:rounded-md",
  "[&>div>div:first-child>div:first-child>button:first-child]:border-blue-600/20",
  "[&>div>div:first-child>div:first-child>button:first-child]:bg-blue-600",
  "[&>div>div:first-child>div:first-child>button:first-child]:font-semibold",
  "[&>div>div:first-child>div:first-child>button:first-child]:text-white",
  "[&>div>div:first-child>div:first-child>button:first-child]:shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]",
  "[&>div>div:first-child>div:first-child>button:first-child]:hover:bg-blue-500",
  "dark:[&>div>div:first-child>div:first-child>button:first-child]:border-[#60a5fa]/50",
  "dark:[&>div>div:first-child>div:first-child>button:first-child]:bg-[#2563eb]",
  "dark:[&>div>div:first-child>div:first-child>button:first-child]:text-[#f8fafc]",
  "dark:[&>div>div:first-child>div:first-child>button:first-child]:shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]",
  "dark:[&>div>div:first-child>div:first-child>button:first-child]:hover:bg-[#3b82f6]",
  // Search field
  "[&>div>div:first-child_input]:h-7",
  "[&>div>div:first-child_input]:rounded-md",
  "[&>div>div:first-child_input]:border-slate-200/90",
  "[&>div>div:first-child_input]:bg-white",
  "[&>div>div:first-child_input]:text-slate-900",
  "[&>div>div:first-child_input]:placeholder:text-slate-400",
  "[&>div>div:first-child_input]:shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]",
  "[&>div>div:first-child_input]:focus-visible:border-blue-500",
  "[&>div>div:first-child_input]:focus-visible:ring-2",
  "[&>div>div:first-child_input]:focus-visible:ring-blue-500/20",
  "dark:[&>div>div:first-child_input]:border-white/[0.1]",
  "dark:[&>div>div:first-child_input]:bg-[#090c12]",
  "dark:[&>div>div:first-child_input]:text-[#eef2f8]",
  "dark:[&>div>div:first-child_input]:placeholder:text-[#627089]",
  "dark:[&>div>div:first-child_input]:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
  "dark:[&>div>div:first-child_input]:focus-visible:border-[#60a5fa]",
  "dark:[&>div>div:first-child_input]:focus-visible:ring-[#60a5fa]/25",
  // View-mode toggle (list / board) styled as status tabs
  "[&>div>div:first-child>div:last-child>div:first-child]:rounded-[10px]",
  "[&>div>div:first-child>div:last-child>div:first-child]:border-slate-200/90",
  "[&>div>div:first-child>div:last-child>div:first-child]:bg-slate-100/90",
  "dark:[&>div>div:first-child>div:last-child>div:first-child]:border-white/[0.08]",
  "dark:[&>div>div:first-child>div:last-child>div:first-child]:bg-[#090c12]",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:h-6",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:w-7",
  "[&>div>div:first-child>div:last-child>div:first-child>button]:p-0",
  // Filter / Sort / Group
  "[&>div>div:first-child>div:last-child>button]:h-7",
  "[&>div>div:first-child>div:last-child>button]:rounded-md",
  "[&>div>div:first-child>div:last-child>button]:text-xs",
  // Group headers
  "[&_button[data-state]]:text-[11px]",
  "[&_button[data-state]]:uppercase",
  "[&_button[data-state]]:tracking-[0.12em]",
  "[&_button[data-state]]:text-slate-500",
  "dark:[&_button[data-state]]:text-[#8f9db3]",
  // High-density rows with crisp hairlines
  "[&_[data-state=open]>a[href^='/issues']]:border-slate-200/80",
  "dark:[&_[data-state=open]>a[href^='/issues']]:border-white/[0.06]",
  "[&_[data-state=open]>a[href^='/issues']]:sm:py-1.5",
  // j/k selection highlight
  "[&_[data-state=open]>a[data-pw-selected=true]]:bg-blue-50",
  "[&_[data-state=open]>a[data-pw-selected=true]]:shadow-[inset_2px_0_0_#2563eb]",
  "dark:[&_[data-state=open]>a[data-pw-selected=true]]:bg-[#151d2b]",
  "dark:[&_[data-state=open]>a[data-pw-selected=true]]:shadow-[inset_2px_0_0_#60a5fa]",
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
  "text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:focus-visible:ring-[#60a5fa]/35",
  "disabled:cursor-default disabled:bg-transparent disabled:text-slate-400 disabled:hover:bg-transparent dark:disabled:text-[#59667c]",
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
      className="cockpit-strip h-8 w-full justify-between rounded-[10px] border-slate-200/90 bg-white/95 px-2 text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]"
    >
      <button type="button" className={PAGER_BUTTON_CLASS} disabled={page <= 1 || isFetching} onClick={onPrev}>
        <ChevronLeft className="h-3 w-3" aria-hidden />
        Prev
      </button>
      <span className="cockpit-cell gap-2" role="status" aria-live="polite">
        <span
          className="inline-flex h-3 w-3 items-center justify-center text-blue-600 dark:text-[#60a5fa]"
          data-spinner={busy || undefined}
          aria-hidden
        >
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </span>
        <span>
          Page <b className="font-mono tabular-nums">{page}</b>
        </span>
        <span className="font-mono text-slate-500 tabular-nums dark:text-[#8f9db3]">
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

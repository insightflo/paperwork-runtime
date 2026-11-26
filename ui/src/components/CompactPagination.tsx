import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

/** Rows per page for explicit server-backed lists (`limit = PAGE_SIZE + 1` detects a next page). */
export const PAGE_SIZE = 50;

export const PAGE_WINDOW_KEY = "page";

/** SQL offset for a 1-based page number. */
export function pageOffset(page: number, pageSize: number = PAGE_SIZE): number {
  return (Math.max(1, Math.trunc(page)) - 1) * pageSize;
}

/** Split a `limit = pageSize + 1` fetch into the rows to render and whether another page exists. */
export function splitFetchedPage<T>(rows: readonly T[] | undefined, pageSize: number = PAGE_SIZE): { items: T[]; hasMore: boolean } {
  const list = rows ?? [];
  return { items: list.slice(0, pageSize), hasMore: list.length > pageSize };
}

/** 1-based inclusive range of the rows shown on `page`, or null when the page is empty. */
export function showingRange(page: number, count: number, pageSize: number = PAGE_SIZE): { from: number; to: number } | null {
  if (count <= 0) return null;
  const from = pageOffset(page, pageSize) + 1;
  return { from, to: from + count - 1 };
}

/**
 * 1-based page number that resets to 1 whenever `resetKey` (company, tab, filter…) changes.
 * The reset is derived during render, so a stale page never triggers a fetch for the new key.
 */
export function usePageNumber(resetKey: unknown): readonly [number, (next: number | ((page: number) => number)) => void] {
  const [state, setState] = useState<{ key: unknown; page: number }>({ key: resetKey, page: 1 });
  const page = state.key === resetKey ? state.page : 1;
  const setPage = useCallback(
    (next: number | ((current: number) => number)) => {
      setState((prev) => {
        const current = prev.key === resetKey ? prev.page : 1;
        const resolved = typeof next === "function" ? next(current) : next;
        return { key: resetKey, page: Math.max(1, Math.trunc(resolved)) };
      });
    },
    [resetKey],
  );
  return [page, setPage] as const;
}

/** Scroll the list back to its top with a smooth motion (instant when the user prefers reduced motion). */
export function scrollListToTop(anchor: HTMLElement | null | undefined): void {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
  const scroller = anchor?.closest<HTMLElement>("#main-content");
  if (scroller && scroller.scrollHeight > scroller.clientHeight && typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: 0, behavior });
    return;
  }
  if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior });
}

/** Smooth scroll-to-top whenever the page number changes (not on first render). */
export function useScrollToTopOnPageChange(page: number, anchor: RefObject<HTMLElement | null>): void {
  const previous = useRef(page);
  useEffect(() => {
    if (previous.current === page) return;
    previous.current = page;
    scrollListToTop(anchor.current);
  }, [page, anchor]);
}

export interface CompactPaginationLabels {
  /** Accessible name for the pager landmark. */
  list: string;
  prev: string;
  next: string;
  page: string;
  showing: string;
  loading: string;
}

export const DEFAULT_PAGINATION_LABELS: CompactPaginationLabels = {
  list: "Pagination",
  prev: "Prev",
  next: "Next",
  page: "Page",
  showing: "Showing",
  loading: "Loading…",
};

interface CompactPaginationProps {
  page: number;
  /** Number of rows rendered on the current page (after the client-side filter, if any). */
  count: number;
  hasMore: boolean;
  /** True while a page request is in flight (React Query `isFetching`). */
  loading: boolean;
  pageSize?: number;
  labels?: Partial<CompactPaginationLabels>;
  onPageChange: (page: number) => void;
  className?: string;
}

const NAV_CLASS = "tactile-card h-8 rounded-[10px] border-slate-200/90 bg-white/95 px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]";
const PAGER_BUTTON_CLASS =
  "h-6 cursor-pointer rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#9aa7bd] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8] dark:focus-visible:ring-[#60a5fa]/35";

/**
 * Compact Cockpit-styled pager: `Prev · Page N · Showing X–Y · Next` with an inline loading slot.
 * The bar always renders (even single-page) so the list position never jumps between pages.
 */
export function CompactPagination({ page, count, hasMore, loading, pageSize = PAGE_SIZE, labels, onPageChange, className }: CompactPaginationProps) {
  const text = { ...DEFAULT_PAGINATION_LABELS, ...labels };
  const range = showingRange(page, count, pageSize);
  return (
    <nav
      aria-label={text.list}
      aria-busy={loading}
      className={cn(NAV_CLASS, "flex items-center justify-between gap-2", className)}
    >
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" className={PAGER_BUTTON_CLASS} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          {text.prev}
        </button>
        <span className="min-w-14 px-1 text-center text-xs text-slate-700 dark:text-[#eef2f8]">
          {text.page} <b className="font-mono font-semibold tabular-nums">{page}</b>
        </span>
        <button type="button" className={PAGER_BUTTON_CLASS} disabled={!hasMore} onClick={() => onPageChange(page + 1)}>
          {text.next}
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-slate-500 dark:text-[#8f9db3]">
        <span role="status" aria-live="polite" className="inline-flex min-w-20 justify-end items-center gap-1 whitespace-nowrap text-slate-600 dark:text-[#b6c2d6]">
          <Loader2 aria-hidden className={cn("h-3.5 w-3.5 text-blue-600 transition-opacity dark:text-[#60a5fa]", loading ? "animate-spin opacity-100" : "opacity-0")} />
          {loading ? text.loading : ""}
        </span>
        <span className="truncate font-mono tabular-nums">
          {range ? `${text.showing} ${range.from}–${range.to}` : `${text.showing} —`}
        </span>
      </div>
    </nav>
  );
}

import type { ProviderQuotaResult } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";

/** A cached payload younger than this is returned without touching upstream. */
export const QUOTA_WINDOWS_FRESH_MS = 60_000;
/**
 * Stale-while-revalidate window. Up to this age a stale payload is returned
 * immediately while ONE background refresh runs; older payloads make the
 * caller wait for a fresh result instead of being served.
 */
export const QUOTA_WINDOWS_MAX_STALE_MS = 180_000;
/** Cache is bounded to this many companies; the least recently used entry is evicted. */
export const QUOTA_WINDOWS_MAX_ENTRIES = 200;

export interface SwrGetOptions {
  /** Bypass freshness and wait for a new upstream result (still deduplicated). */
  forceRefresh?: boolean;
}

export interface SingleFlightSwrCacheOptions<V> {
  fetch: (key: string) => Promise<V>;
  freshMs: number;
  maxStaleMs: number;
  maxEntries: number;
  now?: () => number;
  /**
   * A background (stale-while-revalidate) refresh failed. The previously cached
   * payload stays served and the failure is NOT stored, so the next request retries.
   */
  onBackgroundError?: (key: string, error: unknown) => void;
}

export interface SingleFlightSwrCache<V> {
  get(key: string, options?: SwrGetOptions): Promise<V>;
  clear(): void;
  readonly size: number;
}

interface Entry<V> {
  value: V;
  fetchedAt: number;
}

/**
 * Per-key, in-memory, single-flight stale-while-revalidate cache.
 *
 * - age < freshMs: return cached value synchronously (no upstream call).
 * - freshMs <= age < maxStaleMs: return the stale value immediately and start
 *   exactly one background refresh; concurrent callers join that same refresh.
 * - no entry, age >= maxStaleMs, or forceRefresh: wait for one shared upstream call.
 *
 * A rejected upstream call never replaces or evicts a cached payload, so a
 * transient outage cannot poison fresh data or be cached as "fresh".
 */
export function createSingleFlightSwrCache<V>(opts: SingleFlightSwrCacheOptions<V>): SingleFlightSwrCache<V> {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<V>>();

  function store(key: string, value: V) {
    entries.delete(key);
    entries.set(key, { value, fetchedAt: now() });
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function revalidate(key: string, background: boolean): Promise<V> {
    let resolve!: (value: V) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<V>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Register before starting the fetch so synchronous or already-settled
    // upstreams still deduplicate, and so the finally block below can identity-check.
    inflight.set(key, promise);
    // A background refresh has no awaiting caller; its failure is reported via
    // onBackgroundError and must not surface as an unhandled rejection.
    if (background) promise.catch(() => undefined);
    (async () => {
      try {
        const value = await opts.fetch(key);
        store(key, value);
        resolve(value);
      } catch (error) {
        if (background) opts.onBackgroundError?.(key, error);
        reject(error);
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    })();
    return promise;
  }

  return {
    async get(key: string, options: SwrGetOptions = {}) {
      const forceRefresh = options.forceRefresh === true;
      const entry = entries.get(key);
      if (entry) {
        // LRU touch: Map preserves insertion order, so re-inserting moves the key to "most recent".
        entries.delete(key);
        entries.set(key, entry);
      }
      const age = entry ? now() - entry.fetchedAt : Number.POSITIVE_INFINITY;
      const pending = inflight.get(key);

      if (entry && !forceRefresh && age < opts.freshMs) {
        return entry.value;
      }

      if (!entry || forceRefresh || age >= opts.maxStaleMs) {
        // Nothing servable (or an explicit refresh): wait for one shared upstream call.
        // Failures propagate to the caller exactly as an uncached call would.
        return await (pending ?? revalidate(key, false));
      }

      // Stale: serve immediately and make sure exactly one background refresh is running.
      if (!pending) revalidate(key, true);
      return entry.value;
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}

export type QuotaWindowsCache = SingleFlightSwrCache<ProviderQuotaResult[]>;

/**
 * Quota-windows cache as used by `GET /companies/:companyId/costs/quota-windows`.
 * Keyed by companyId, bounded, and backed by {@link fetchAllQuotaWindows} unless overridden
 * (tests inject a fake upstream and clock).
 */
export function createQuotaWindowsCache(
  opts: {
    fetch?: () => Promise<ProviderQuotaResult[]>;
    now?: () => number;
    onBackgroundError?: (key: string, error: unknown) => void;
  } = {},
): QuotaWindowsCache {
  const fetchQuotaWindows = opts.fetch ?? fetchAllQuotaWindows;
  return createSingleFlightSwrCache<ProviderQuotaResult[]>({
    fetch: () => fetchQuotaWindows(),
    freshMs: QUOTA_WINDOWS_FRESH_MS,
    maxStaleMs: QUOTA_WINDOWS_MAX_STALE_MS,
    maxEntries: QUOTA_WINDOWS_MAX_ENTRIES,
    now: opts.now,
    onBackgroundError:
      opts.onBackgroundError ??
      ((companyId, error) =>
        logger.warn({ err: String(error), companyId }, "quota-windows background refresh failed")),
  });
}

const TRUTHY_FLAGS = new Set(["", "1", "true", "yes", "on"]);

/**
 * Parses an explicit `?refresh=1` / `?forceRefresh=true` escape hatch from an
 * Express query value (string, string[] with the "qs" parser, or undefined).
 * Anything else — including `0`, `false`, or a missing parameter — is not a refresh request.
 */
export function parseForceRefresh(raw: unknown): boolean {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return TRUTHY_FLAGS.has(value.trim().toLowerCase());
}

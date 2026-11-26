import express from "express";
import request from "supertest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  company: { getById: vi.fn(), update: vi.fn() },
  agent: { getById: vi.fn(), update: vi.fn() },
  heartbeat: { cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined) },
  budget: { overview: vi.fn().mockResolvedValue({}), upsertPolicy: vi.fn() },
  logActivity: vi.fn(),
  fetchAllQuotaWindows: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  budgetService: () => h.budget, costService: () => ({}), financeService: () => ({}),
  companyService: () => h.company, agentService: () => h.agent,
  heartbeatService: () => h.heartbeat, logActivity: h.logActivity,
}));
vi.mock("../services/quota-windows.js", () => ({ fetchAllQuotaWindows: h.fetchAllQuotaWindows }));

import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";
import { QUOTA_WINDOWS_FRESH_MS as FRESH_MS, QUOTA_WINDOWS_MAX_STALE_MS as STALE_MS, QUOTA_WINDOWS_MAX_ENTRIES,
  createQuotaWindowsCache, createSingleFlightSwrCache, parseForceRefresh } from "../services/quota-windows-cache.js";

type Payload = ProviderQuotaResult[];
type Fetch = (key: string) => Promise<Payload>;
/** Distinguishable valid payloads; `version` rides on the optional `source` label. */
const payload = (version: number): Payload => [{ provider: "openai", source: `v${version}`, ok: true, windows: [] }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Virtual clock so freshness/staleness is exact and never depends on wall time. */
function createClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Lets every pending microtask (including background refresh continuations) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeCache(fetch: Fetch, maxEntries = QUOTA_WINDOWS_MAX_ENTRIES) {
  const clock = createClock();
  const onBackgroundError = vi.fn();
  const cache = createSingleFlightSwrCache<Payload>({
    fetch, freshMs: FRESH_MS, maxStaleMs: STALE_MS,
    maxEntries, now: clock.now, onBackgroundError,
  });
  return { cache, clock, onBackgroundError };
}

describe("createSingleFlightSwrCache", () => {
  it("populates on a miss and serves fresh hits from memory without another upstream call", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(payload(1));
    const { cache, clock } = makeCache(fetch);

    const first = await cache.get("company-1");
    expect(first).toEqual(payload(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("company-1");

    clock.advance(FRESH_MS - 1);
    expect(await cache.get("company-1")).toBe(first); // same reference: no upstream call
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("dedupes N concurrent requests on a miss into exactly one upstream call", async () => {
    const upstream = deferred<Payload>();
    const fetch = vi.fn<Fetch>(() => upstream.promise);
    const { cache } = makeCache(fetch);

    const callers = Array.from({ length: 8 }, () => cache.get("company-1"));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    upstream.resolve(payload(1));
    expect(await Promise.all(callers)).toEqual(Array(8).fill(payload(1)));
  });

  it("returns stale data immediately and runs exactly ONE background refresh (single-flight)", async () => {
    const refresh = deferred<Payload>();
    const fetch = vi.fn<Fetch>().mockResolvedValueOnce(payload(1)).mockImplementationOnce(() => refresh.promise);
    const { cache, clock } = makeCache(fetch);
    await cache.get("company-1");

    clock.advance(FRESH_MS); // no longer fresh, still inside the SWR window
    expect(await cache.get("company-1")).toEqual(payload(1)); // resolves while `refresh` is pending → did not wait
    expect(fetch).toHaveBeenCalledTimes(2);

    // Concurrent pollers during the background refresh: stale again, no extra upstream call.
    expect(await Promise.all([cache.get("company-1"), cache.get("company-1")])).toEqual([payload(1), payload(1)]);
    expect(fetch).toHaveBeenCalledTimes(2);

    refresh.resolve(payload(2));
    await flush();
    expect(await cache.get("company-1")).toEqual(payload(2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a fresh result once the cached payload is older than the max-stale window", async () => {
    const refresh = deferred<Payload>();
    const fetch = vi.fn<Fetch>().mockResolvedValueOnce(payload(1)).mockImplementationOnce(() => refresh.promise);
    const { cache, clock } = makeCache(fetch);
    await cache.get("company-1");

    clock.advance(STALE_MS);
    let settled = false;
    const waiting = cache.get("company-1").then((v) => { settled = true; return v; });
    await flush();
    expect(settled).toBe(false); // too old to serve → caller waits
    expect(fetch).toHaveBeenCalledTimes(2);

    refresh.resolve(payload(2));
    expect(await waiting).toEqual(payload(2));
  });

  it("keeps serving stale data when the background refresh fails, then retries on the next poll", async () => {
    const failing = deferred<Payload>();
    const fetch = vi.fn<Fetch>().mockResolvedValueOnce(payload(1)).mockImplementationOnce(() => failing.promise)
      .mockResolvedValue(payload(2));
    const { cache, clock, onBackgroundError } = makeCache(fetch);
    await cache.get("company-1");

    clock.advance(FRESH_MS);
    expect(await cache.get("company-1")).toEqual(payload(1));
    failing.reject(new Error("upstream exploded"));
    await flush();
    expect(onBackgroundError).toHaveBeenCalledWith("company-1", new Error("upstream exploded"));
    expect(cache.size).toBe(1); // failure did not evict the good payload

    // Next poll still gets the last good payload (not poisoned) and triggers a new refresh.
    expect(await cache.get("company-1")).toEqual(payload(1));
    expect(fetch).toHaveBeenCalledTimes(3);
    await flush();
    expect(await cache.get("company-1")).toEqual(payload(2));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failed miss: the error propagates and the next request retries", async () => {
    const fetch = vi.fn<Fetch>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(payload(1));
    const { cache } = makeCache(fetch);

    await expect(cache.get("company-1")).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    expect(await cache.get("company-1")).toEqual(payload(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh waits for one deduplicated upstream call and leaves good data intact when it fails", async () => {
    const forced = deferred<Payload>();
    const fetch = vi.fn<Fetch>().mockResolvedValueOnce(payload(1)).mockImplementationOnce(() => forced.promise)
      .mockRejectedValueOnce(new Error("down"));
    const { cache } = makeCache(fetch);
    await cache.get("company-1");

    const callers = [cache.get("company-1", { forceRefresh: true }), cache.get("company-1", { forceRefresh: true })];
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    forced.resolve(payload(2));
    expect(await Promise.all(callers)).toEqual([payload(2), payload(2)]);

    await expect(cache.get("company-1", { forceRefresh: true })).rejects.toThrow("down");
    expect(await cache.get("company-1")).toEqual(payload(2)); // failure never replaced the good payload
  });

  it("bounds the cache with least-recently-used eviction", async () => {
    const fetch = vi.fn<Fetch>(async (key) => payload(Number(key)));
    const { cache } = makeCache(fetch, 2);
    await cache.get("1");
    await cache.get("2");
    await cache.get("1"); // touch → "2" is now least recently used
    await cache.get("3");
    expect(cache.size).toBe(2);

    await cache.get("1");
    expect(fetch).toHaveBeenCalledTimes(3);
    await cache.get("2"); // evicted → refetched
    expect(fetch).toHaveBeenCalledTimes(4);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("createQuotaWindowsCache", () => {
  it("binds the production windows: rapid polls share one upstream call", async () => {
    const fetch = vi.fn().mockResolvedValue(payload(1));
    const cache = createQuotaWindowsCache({ fetch });
    expect([await cache.get("c1"), await cache.get("c1")]).toEqual([payload(1), payload(1)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("parseForceRefresh", () => {
  it("accepts only explicit truthy flags", () => {
    for (const yes of ["1", "true", "YES", "", ["1"], 1]) expect(parseForceRefresh(yes)).toBe(true); // "" = bare ?refresh
    for (const no of ["0", "false", undefined, ["1", "0"], {}]) expect(parseForceRefresh(no)).toBe(false);
  });
});

describe("GET /companies/:companyId/costs/quota-windows", () => {
  const url = "/api/companies/company-1/costs/quota-windows";
  function createApp(actor: unknown = { type: "board", userId: "board-user", source: "local_implicit" }) {
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", costRoutes({} as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.company.getById.mockResolvedValue({ id: "company-1" });
    h.fetchAllQuotaWindows.mockResolvedValue(payload(1));
  });
  afterEach(() => vi.restoreAllMocks());

  it("serves repeated polls from cache and honors ?refresh=1 with a new upstream call", async () => {
    const app = createApp();
    const first = await request(app).get(url);
    const second = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(payload(1));
    expect(second.body).toEqual(first.body);
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(1);

    h.fetchAllQuotaWindows.mockResolvedValue(payload(2));
    const forced = await request(app).get(url).query({ refresh: "1" });
    expect(forced.status).toBe(200);
    expect(forced.body).toEqual(payload(2));
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });

  it("revalidates in the background once the fresh window has elapsed", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const app = createApp();
    expect((await request(app).get(url)).body).toEqual(payload(1));

    clock.mockReturnValue(started + FRESH_MS + 1);
    const refresh = deferred<Payload>();
    h.fetchAllQuotaWindows.mockImplementationOnce(() => refresh.promise);
    const stale = await request(app).get(url); // resolves while `refresh` is still pending
    expect(stale.body).toEqual(payload(1));
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(2);

    refresh.resolve(payload(2));
    await flush();
    expect((await request(app).get(url)).body).toEqual(payload(2));
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });

  it("caches per company and per router instance", async () => {
    const app = createApp();
    await Promise.all([request(app).get(url), request(app).get(url)]);
    h.company.getById.mockResolvedValue({ id: "company-2" });
    await request(app).get("/api/companies/company-2/costs/quota-windows");
    await request(createApp()).get(url); // fresh router → fresh cache
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(3);
  });

  it("preserves the 404 for unknown companies without caching it or touching upstream", async () => {
    const app = createApp();
    h.company.getById.mockResolvedValue(null);
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Company not found" });
    expect(h.fetchAllQuotaWindows).not.toHaveBeenCalled();

    h.company.getById.mockResolvedValue({ id: "company-1" });
    expect((await request(app).get(url)).status).toBe(200);
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("preserves board-only and company-scoped access checks", async () => {
    h.fetchAllQuotaWindows.mockRejectedValue(new Error("should not be reached"));
    const agent = await request(createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" })).get(url);
    expect(agent.status).toBe(403);
    const outsider = await request(createApp({ type: "board", source: "session", isInstanceAdmin: false, companyIds: ["company-2"] })).get(url);
    expect(outsider.status).toBe(403);
    expect(h.fetchAllQuotaWindows).not.toHaveBeenCalled();
    expect(h.company.getById).not.toHaveBeenCalled();
  });

  it("propagates upstream failures to the client instead of caching them", async () => {
    h.fetchAllQuotaWindows.mockRejectedValueOnce(new Error("upstream down"));
    const app = createApp();
    expect((await request(app).get(url)).status).toBe(500);
    expect((await request(app).get(url)).body).toEqual(payload(1));
    expect(h.fetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });
});

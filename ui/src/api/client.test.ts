// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isRetryableQueryError, request } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api client request timeout & abort handling", () => {
  it("resolves normally when fetch completes before timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const out = await request<{ ok: boolean }>("/health", { timeoutMs: 200 });
    expect(out).toEqual({ ok: true });
  });

  it("throws ApiError(408) when a hung request exceeds timeoutMs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    await expect(request("/slow", { timeoutMs: 25 })).rejects.toMatchObject({
      name: "ApiError",
      status: 408,
      message: "Request timed out",
    });
  });

  it("rethrows caller AbortError untouched without relabeling as 408", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("User cancelled", "AbortError")));
        }),
    );
    const caller = new AbortController();
    const p = request("/cancel-me", { signal: caller.signal, timeoutMs: 5_000 });
    caller.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as { name?: string })?.name).toBe("AbortError");
  });

  it("classifies 4xx (except 408/429) and AbortError as non-retryable, and 408/429/5xx/network errors as retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableQueryError(new ApiError("client error", status, null))).toBe(false);
    }
    expect(isRetryableQueryError(new DOMException("Aborted", "AbortError"))).toBe(false);

    for (const status of [408, 429, 500, 502, 503]) {
      expect(isRetryableQueryError(new ApiError("transient", status, null))).toBe(true);
    }
    expect(isRetryableQueryError(new TypeError("Failed to fetch"))).toBe(true);
  });
});

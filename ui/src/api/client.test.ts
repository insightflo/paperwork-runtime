// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./client";

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
});

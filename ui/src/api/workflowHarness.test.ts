import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { fetchWorkflowRunHarnessStatus, isWorkflowRunHarnessSummary } from "./workflowHarness";

const RUN_ID = "run-0199-harness";
const PATH = `/api/workflow-runs/${RUN_ID}/harness-status`;

const validSummary = {
  runId: RUN_ID,
  stallStatus: "stalled",
  idleMs: 612_000,
  route: "escalate",
  advisorGate: "g2_challenge",
  successRatePct: 66.7,
  totalSteps: 3,
  completedSteps: 2,
  failedSteps: 1,
  stalledSteps: 1,
  evaluatedAt: "2026-11-27T09:30:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isWorkflowRunHarnessSummary", () => {
  it("accepts a complete server payload", () => {
    expect(isWorkflowRunHarnessSummary(validSummary)).toBe(true);
  });

  it("accepts successRatePct null (no terminal evidence) and integer counters", () => {
    expect(isWorkflowRunHarnessSummary({ ...validSummary, successRatePct: null, stalledSteps: 0 })).toBe(true);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing runId", { ...validSummary, runId: undefined }],
    ["empty runId", { ...validSummary, runId: "" }],
    ["unknown stallStatus", { ...validSummary, stallStatus: "hung" }],
    ["unknown route", { ...validSummary, route: "retry" }],
    ["unknown advisorGate", { ...validSummary, advisorGate: "g4" }],
    ["negative idleMs", { ...validSummary, idleMs: -1 }],
    ["NaN idleMs", { ...validSummary, idleMs: Number.NaN }],
    ["string counter", { ...validSummary, totalSteps: "3" }],
    ["undefined successRatePct", { ...validSummary, successRatePct: undefined }],
    ["successRatePct over 100", { ...validSummary, successRatePct: 100.1 }],
    ["successRatePct string", { ...validSummary, successRatePct: "66.7" }],
    ["invalid evaluatedAt", { ...validSummary, evaluatedAt: "yesterday" }],
  ])("rejects %s", (_label, value) => {
    expect(isWorkflowRunHarnessSummary(value)).toBe(false);
  });

  it("rejects a partial payload missing the trailing counters", () => {
    const { stalledSteps: _s, evaluatedAt: _e, ...partial } = validSummary;
    expect(isWorkflowRunHarnessSummary(partial)).toBe(false);
  });
});

describe("fetchWorkflowRunHarnessStatus", () => {
  it("GETs the run-scoped harness-status route and returns the validated summary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validSummary));
    const out = await fetchWorkflowRunHarnessStatus(RUN_ID);
    expect(out).toEqual(validSummary);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(PATH);
  });

  it("URL-encodes the run id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validSummary));
    await fetchWorkflowRunHarnessStatus("run/../x?y=1");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/workflow-runs/run%2F..%2Fx%3Fy%3D1/harness-status");
  });

  it.each([
    ["malformed body", { error: "nope" }],
    ["partial body", { runId: RUN_ID, stallStatus: "healthy" }],
    ["wrong run id", { ...validSummary, runId: "run-other" }],
    ["array body", []],
  ])("returns null (fail closed) on %s", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
    expect(await fetchWorkflowRunHarnessStatus(RUN_ID)).toBeNull();
  });

  it("returns null without a network call when runId is blank", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await fetchWorkflowRunHarnessStatus("   ")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects with ApiError on HTTP 404 instead of returning null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Workflow run not found" }, 404));
    await expect(fetchWorkflowRunHarnessStatus(RUN_ID)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Workflow run not found",
    });
  });

  it.each([403, 500])("rejects with ApiError on HTTP %s", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, status));
    await expect(fetchWorkflowRunHarnessStatus(RUN_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it("propagates network failures untouched", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchWorkflowRunHarnessStatus(RUN_ID)).rejects.toMatchObject({
      name: "TypeError",
      message: "Failed to fetch",
    });
  });

  it("rejects with ApiError(408) when the request exceeds the client GET timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      );
      const pending = fetchWorkflowRunHarnessStatus(RUN_ID);
      // Attach the rejection handler before the clock fires so the rejection is never unhandled.
      const outcome = expect(pending).rejects.toMatchObject({
        name: "ApiError",
        status: 408,
        message: "Request timed out",
      });
      await vi.advanceTimersByTimeAsync(45_001);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});

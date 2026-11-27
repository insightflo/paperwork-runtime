// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import {
  fetchCompanyWorkflowHarnessFleet,
  isWorkflowHarnessFleetMetrics,
  type WorkflowHarnessFleetMetrics,
} from "./workflowHarnessFleet";

const COMPANY_ID = "company-1";
const URL = `/api/companies/${COMPANY_ID}/workflow-harness/fleet-metrics`;

const VALID: WorkflowHarnessFleetMetrics = {
  totalRuns: 12,
  healthyRuns: 7,
  stalledRuns: 2,
  timedOutRuns: 1,
  sharpRuns: 3,
  splitRuns: 4,
  escalatedRuns: 1,
  pendingAdvisorGates: 2,
  challengedAdvisorGates: 1,
  avgSuccessRatePct: 83.3,
  worstStallRunId: "run-9",
  maxIdleMs: 540_000,
};

const VALID_WITH_NULLS: WorkflowHarnessFleetMetrics = {
  ...VALID,
  totalRuns: 0,
  healthyRuns: 0,
  stalledRuns: 0,
  timedOutRuns: 0,
  escalatedRuns: 0,
  pendingAdvisorGates: 0,
  challengedAdvisorGates: 0,
  avgSuccessRatePct: null,
  worstStallRunId: null,
  maxIdleMs: 0,
};

function mockJson(status: number, payload: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isWorkflowHarnessFleetMetrics", () => {
  it("accepts a complete metrics object", () => {
    expect(isWorkflowHarnessFleetMetrics(VALID)).toBe(true);
    expect(isWorkflowHarnessFleetMetrics(VALID_WITH_NULLS)).toBe(true);
  });

  it("rejects non-objects and objects missing required keys", () => {
    for (const bad of [null, undefined, "x", 7, [], {}, { ...VALID, maxIdleMs: undefined }]) {
      expect(isWorkflowHarnessFleetMetrics(bad)).toBe(false);
    }
  });

  it("rejects negative, non-finite, and wrongly typed fields", () => {
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, stalledRuns: -1 })).toBe(false);
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, totalRuns: "12" })).toBe(false);
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, avgSuccessRatePct: Number.NaN })).toBe(false);
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, avgSuccessRatePct: undefined })).toBe(false);
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, worstStallRunId: "" })).toBe(false);
    expect(isWorkflowHarnessFleetMetrics({ ...VALID, worstStallRunId: 42 })).toBe(false);
  });
});

describe("fetchCompanyWorkflowHarnessFleet", () => {
  it("returns the valid response via GET on the company fleet path", async () => {
    const fetchMock = mockJson(200, VALID);

    await expect(fetchCompanyWorkflowHarnessFleet(COMPANY_ID)).resolves.toEqual(VALID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URL);
  });

  it("preserves null avgSuccessRatePct and worstStallRunId", async () => {
    mockJson(200, VALID_WITH_NULLS);

    const out = await fetchCompanyWorkflowHarnessFleet(COMPANY_ID);
    expect(out).toEqual(VALID_WITH_NULLS);
    expect(out?.avgSuccessRatePct).toBeNull();
    expect(out?.worstStallRunId).toBeNull();
  });

  it("returns null for malformed payloads without throwing", async () => {
    for (const bad of [{}, { ...VALID, healthyRuns: "7" }, [], null, "nope"]) {
      mockJson(200, bad);
      await expect(fetchCompanyWorkflowHarnessFleet(COMPANY_ID)).resolves.toBeNull();
    }
  });

  it("returns null for an empty companyId without calling fetch", async () => {
    const fetchMock = mockJson(200, VALID);

    for (const empty of ["", "   "]) {
      await expect(fetchCompanyWorkflowHarnessFleet(empty)).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates HTTP errors instead of swallowing them", async () => {
    mockJson(500, { error: "fleet unavailable" });

    await expect(fetchCompanyWorkflowHarnessFleet(COMPANY_ID)).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "fleet unavailable",
    } satisfies Partial<ApiError>);
  });

  it("propagates network errors instead of swallowing them", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchCompanyWorkflowHarnessFleet(COMPANY_ID)).rejects.toBeInstanceOf(TypeError);
  });
});

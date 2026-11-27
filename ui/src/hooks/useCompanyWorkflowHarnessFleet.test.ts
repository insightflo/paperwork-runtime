// @vitest-environment node

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  companyWorkflowHarnessFleetQueryOptions, parseWorkflowHarnessFleetSummary, useCompanyWorkflowHarnessFleet,
  WORKFLOW_HARNESS_FLEET_POLL_MS, type WorkflowHarnessFleetSummary,
} from "./useCompanyWorkflowHarnessFleet";

const COMPANY_ID = "company-1";
const KEY = ["workflows", "harness-fleet", COMPANY_ID] as const;

const VALID: WorkflowHarnessFleetSummary = {
  totalRuns: 12, healthyRuns: 7, stalledRuns: 2, timedOutRuns: 1,
  sharpRuns: 3, splitRuns: 4, escalatedRuns: 1, pendingAdvisorGates: 2, challengedAdvisorGates: 1,
  avgSuccessRatePct: 83.3, worstStallRunId: "run-9", maxIdleMs: 540_000,
};

function mockJson(status: number, payload: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
}

/** Drive the exact options the hook passes to useQuery through a real observer. */
function observe(companyId: string | null | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, companyWorkflowHarnessFleetQueryOptions(companyId));
  return { client, observer, unsubscribe: observer.subscribe(vi.fn()) };
}

afterEach(() => vi.restoreAllMocks());

describe("parseWorkflowHarnessFleetSummary", () => {
  it("accepts a valid fleet payload and ignores extra envelope fields", () => {
    expect(parseWorkflowHarnessFleetSummary({ companyId: COMPANY_ID, evaluatedAt: "2026-01-01T00:00:00.000Z", ...VALID, runs: [] }))
      .toMatchObject(VALID);
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, avgSuccessRatePct: null, worstStallRunId: null, maxIdleMs: 0 }))
      .not.toBeNull();
  });

  it("fails closed (null) on malformed numeric fields", () => {
    expect(parseWorkflowHarnessFleetSummary(null)).toBeNull();
    expect(parseWorkflowHarnessFleetSummary([])).toBeNull();
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, stalledRuns: -1 })).toBeNull();
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, totalRuns: "12" })).toBeNull();
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, maxIdleMs: Number.NaN })).toBeNull();
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, avgSuccessRatePct: undefined })).toBeNull();
    expect(parseWorkflowHarnessFleetSummary({ ...VALID, healthyRuns: undefined })).toBeNull();
  });
});

describe("companyWorkflowHarnessFleetQueryOptions", () => {
  it("is disabled when companyId is empty, blank, null or undefined", () => {
    for (const companyId of ["", "   ", null, undefined]) {
      expect(companyWorkflowHarnessFleetQueryOptions(companyId).enabled).toBe(false);
    }
  });

  it("polls every 30s without retries and targets the harness-fleet route", async () => {
    const options = companyWorkflowHarnessFleetQueryOptions(COMPANY_ID);
    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(WORKFLOW_HARNESS_FLEET_POLL_MS);
    expect(options.retry).toBe(false);
    const fetchSpy = mockJson(200, VALID);
    const client = new QueryClient();
    await expect(client.fetchQuery(options)).resolves.toMatchObject(VALID);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/api/companies/${COMPANY_ID}/workflows/harness-fleet`);
  });

  it("does not fetch when disabled", async () => {
    const fetchSpy = mockJson(200, VALID);
    const { client, unsubscribe } = observe("  ");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    const [query] = client.getQueryCache().getAll();
    expect(query?.state).toMatchObject({ fetchStatus: "idle", data: undefined, error: null });
    unsubscribe();
  });

  it("yields null (not a throw) when the payload is malformed", async () => {
    mockJson(200, { ...VALID, stalledRuns: "many" });
    const { client, unsubscribe } = observe(COMPANY_ID);
    await vi.waitFor(() => expect(client.getQueryState(KEY)?.data).toBeNull());
    expect(client.getQueryState(KEY)).toMatchObject({ status: "success", error: null });
    unsubscribe();
  });

  it("surfaces HTTP errors on the observer without throwing or retrying", async () => {
    const fetchSpy = mockJson(500, { error: "boom" });
    const { client, observer, unsubscribe } = observe(COMPANY_ID);
    await vi.waitFor(() => expect(observer.getCurrentResult().error).toBeInstanceOf(ApiError));
    const { error, data } = observer.getCurrentResult();
    expect(error).toMatchObject({ status: 500, message: "boom" });
    expect(data).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(KEY)?.status).toBe("error");
    unsubscribe();
  });
});

describe("useCompanyWorkflowHarnessFleet", () => {
  it("exposes { data, isLoading, error } and does not throw or fetch while disabled", () => {
    const fetchSpy = mockJson(200, VALID);
    let exposed: ReturnType<typeof useCompanyWorkflowHarnessFleet> | undefined;
    const Probe = () => {
      exposed = useCompanyWorkflowHarnessFleet("");
      return null;
    };
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
    expect(Object.keys(exposed!).sort()).toEqual(["data", "error", "isLoading"]);
    expect(exposed).toMatchObject({ data: undefined, isLoading: false, error: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

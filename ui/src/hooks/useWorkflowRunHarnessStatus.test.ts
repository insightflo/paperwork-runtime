// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_STATUS_POLL_MS, useWorkflowRunHarnessStatus, workflowRunHarnessStatusKey,
  workflowRunHarnessStatusOptions, type UseWorkflowRunHarnessStatusResult,
} from "./useWorkflowRunHarnessStatus";
import { fetchWorkflowRunHarnessStatus, type WorkflowRunHarnessSummary } from "../api/workflowHarness";

vi.mock("../api/workflowHarness", () => ({ fetchWorkflowRunHarnessStatus: vi.fn() }));

const fetchMock = vi.mocked(fetchWorkflowRunHarnessStatus);
const RUN_ID = "run-0199-harness";
const summary: WorkflowRunHarnessSummary = {
  runId: RUN_ID, stallStatus: "stalled", idleMs: 612_000, route: "escalate", advisorGate: "g2_challenge",
  successRatePct: 66.7, totalSteps: 3, completedSteps: 2, failedSteps: 1, stalledSteps: 1,
  evaluatedAt: "2026-11-27T09:30:00.000Z",
};
const IDLE = { summary: null, isLoading: false, error: null };

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
let observed: UseWorkflowRunHarnessStatusResult | null = null;

function Probe({ runId, isRunning }: { runId: string | null; isRunning?: boolean }) {
  observed = useWorkflowRunHarnessStatus(runId, { isRunning });
  return null;
}

/** Mounts the hook in a real QueryClientProvider whose default retries; the hook must override it. */
async function mount(runId: string | null, isRunning?: boolean) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: true } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(QueryClientProvider, { client: queryClient! }, createElement(Probe, { runId, isRunning })),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Options the mounted observer actually registered for this run's query. */
function observerOptions() {
  const observer = queryClient!.getQueryCache().find({ queryKey: workflowRunHarnessStatusKey(RUN_ID) })?.observers[0];
  if (!observer) throw new Error("query observer not registered");
  return observer.options;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  queryClient?.clear();
  root = host = queryClient = null;
  observed = null;
  fetchMock.mockReset();
});

describe("workflowRunHarnessStatusOptions", () => {
  it.each([["null", null], ["undefined", undefined], ["empty", ""], ["blank", "   "]])(
    "is disabled for %s runId",
    (_label, runId) => {
      expect(workflowRunHarnessStatusOptions(runId, true)).toMatchObject({
        enabled: false, refetchInterval: false, retry: false,
      });
    },
  );

  it("polls every 15s only while the run is running", () => {
    expect(workflowRunHarnessStatusOptions(RUN_ID, true)).toMatchObject({
      enabled: true, refetchInterval: HARNESS_STATUS_POLL_MS, retry: false,
    });
    expect(workflowRunHarnessStatusOptions(RUN_ID, false).refetchInterval).toBe(false);
  });
});

describe("useWorkflowRunHarnessStatus", () => {
  it("does not fetch when runId is null or empty", async () => {
    await mount(null);
    expect(observed).toMatchObject(IDLE);
    await mount("");
    expect(observed).toMatchObject(IDLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the parsed summary with polling and no-retry options when active", async () => {
    fetchMock.mockResolvedValue(summary);
    await mount(RUN_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(RUN_ID);
    expect(observed).toMatchObject({ summary, isLoading: false, isFetching: false, error: null });
    expect(observerOptions()).toMatchObject({ refetchInterval: HARNESS_STATUS_POLL_MS, retry: false });
  });

  it("stops polling once the run is no longer running", async () => {
    fetchMock.mockResolvedValue(summary);
    await mount(RUN_ID, false);

    expect(observed?.summary).toEqual(summary);
    expect(observerOptions().refetchInterval).toBe(false);
  });

  it("keeps null when the server body is malformed (fail closed)", async () => {
    fetchMock.mockResolvedValue(null);
    await mount(RUN_ID);

    expect(observed).toMatchObject({ summary: null, error: null });
  });

  it("returns null without throwing on error, after exactly one attempt", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    await expect(mount(RUN_ID)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observed).toMatchObject({ summary: null, isLoading: false });
    expect(observed?.error).toMatchObject({ message: "boom" });
  });
});

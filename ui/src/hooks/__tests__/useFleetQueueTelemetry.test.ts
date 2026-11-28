// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import {
  queueTelemetryApi,
  type FleetQueueTelemetryDto,
} from "../../api/queueTelemetry";
import { fleetQueueTelemetryQueryKey } from "../useFleetQueueTelemetry";

vi.mock("../../api/client", () => ({
  api: { get: vi.fn() },
}));

const apiGetMock = vi.mocked(api.get);

const fleetSummary: FleetQueueTelemetryDto = {
  totalSlots: 4,
  totalRunning: 3,
  totalQueued: 2,
  saturatedAgents: 1,
  starvingAgents: 1,
  maxQueuedWaitMs: 30_000,
  byAgent: [
    {
      agentId: "agent-1",
      agentName: "Agent One",
      maxConcurrentRuns: 2,
      runningCount: 2,
      queuedCount: 2,
      utilizationRatio: 1,
      saturated: true,
      oldestQueuedWaitMs: 30_000,
      starvationWarning: true,
      distinctQueuedIssues: 2,
    },
  ],
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(fleetSummary);
});

describe("fleetQueueTelemetryQueryKey", () => {
  it("uses the company id when present", () => {
    expect(fleetQueueTelemetryQueryKey("company-1")).toEqual(["queue-telemetry", "company-1"]);
  });

  it("uses an empty string for null or undefined company ids", () => {
    expect(fleetQueueTelemetryQueryKey(null)).toEqual(["queue-telemetry", ""]);
    expect(fleetQueueTelemetryQueryKey(undefined)).toEqual(["queue-telemetry", ""]);
  });
});

describe("queueTelemetryApi.getFleetSummary", () => {
  it("encodes the company id in the fleet queue telemetry URL", async () => {
    const result = await queueTelemetryApi.getFleetSummary("company/with space#");

    expect(result).toEqual(fleetSummary);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company%2Fwith%20space%23/queue-telemetry",
    );
  });
});

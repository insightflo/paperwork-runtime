// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import {
  fetchExceptionHuddleTelemetry,
  type ExceptionHuddleTelemetryResponse,
} from "../useExceptionHuddleTelemetry";

vi.mock("../../api/client", () => ({
  api: { get: vi.fn() },
}));

const apiGetMock = vi.mocked(api.get);

const telemetryResponse: ExceptionHuddleTelemetryResponse = {
  companyId: "company-1",
  missionId: null,
  summary: {
    total: 4,
    byStatus: { open: 1, timed_out: 1, decided: 1, cancelled: 1 },
    byDecisionKind: {
      retry_with_guidance: 1,
      accept_with_waiver: 1,
      replan_remaining: 1,
      escalate: 1,
    },
    byFailureKind: { qa_rejected: 2 },
    averageRoundsOnDecided: 1.5,
    timeoutRate: 0.25,
    chairForcedDecisionCount: 1,
    resolutionRate: 0.5,
  },
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(telemetryResponse);
});

describe("fetchExceptionHuddleTelemetry", () => {
  it("encodes the company id and omits the mission query for a company-only request", async () => {
    const result = await fetchExceptionHuddleTelemetry("company/with space#");

    expect(result).toEqual(telemetryResponse);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company%2Fwith%20space%23/collab-channels/huddles/telemetry",
    );
  });

  it("encodes the company id and mission id when both are present", async () => {
    await fetchExceptionHuddleTelemetry("company/with space#", "mission/with space#");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company%2Fwith%20space%23/collab-channels/huddles/telemetry?missionId=mission%2Fwith%20space%23",
    );
  });

  it("trims whitespace around a non-empty mission id before encoding it", async () => {
    await fetchExceptionHuddleTelemetry("company-1", " \tmission-42\n ");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company-1/collab-channels/huddles/telemetry?missionId=mission-42",
    );
  });

  it("omits the mission query when the mission id trims to an empty string", async () => {
    await fetchExceptionHuddleTelemetry("company-1", " \t\n ");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company-1/collab-channels/huddles/telemetry",
    );
  });
});

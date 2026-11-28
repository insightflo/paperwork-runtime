// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import {
  fetchExceptionHuddleAudit,
  type ExceptionHuddleAuditResponse,
} from "../useExceptionHuddleAudit";

vi.mock("../../api/client", () => ({
  api: { get: vi.fn() },
}));

const apiGetMock = vi.mocked(api.get);

const auditResponse: ExceptionHuddleAuditResponse = {
  companyId: "company-1",
  entries: [
    {
      id: "event-1",
      missionId: "mission-1",
      threadId: "thread-1",
      decisionKind: "retry_with_guidance",
      decidedByAgentId: "agent-1",
      createdAt: "2026-11-28T01:00:00.000Z",
      payload: {
        threadId: "thread-1",
        decisionKind: "retry_with_guidance",
      },
    },
  ],
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(auditResponse);
});

describe("fetchExceptionHuddleAudit", () => {
  it("encodes the company id and omits the query string for a company-only request", async () => {
    const result = await fetchExceptionHuddleAudit("company/with space#");

    expect(result).toEqual(auditResponse);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company%2Fwith%20space%23/collab-channels/huddles/audit",
    );
  });

  it("encodes missionId, threadId, and limit in query-param order", async () => {
    await fetchExceptionHuddleAudit("company/with space#", {
      missionId: "mission/with space#",
      threadId: "thread/with space#",
      limit: 25,
    });

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company%2Fwith%20space%23/collab-channels/huddles/audit?missionId=mission%2Fwith%20space%23&threadId=thread%2Fwith%20space%23&limit=25",
    );
  });

  it("trims non-empty missionId and threadId values before encoding them", async () => {
    await fetchExceptionHuddleAudit("company-1", {
      missionId: " \tmission-42\n ",
      threadId: " thread-7 ",
      limit: 50,
    });

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company-1/collab-channels/huddles/audit?missionId=mission-42&threadId=thread-7&limit=50",
    );
  });

  it("ignores missionId and threadId values that trim to empty strings", async () => {
    await fetchExceptionHuddleAudit("company-1", {
      missionId: " \t\n ",
      threadId: "",
    });

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      "/companies/company-1/collab-channels/huddles/audit",
    );
  });
});

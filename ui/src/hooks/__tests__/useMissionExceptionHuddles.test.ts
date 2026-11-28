import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import { api } from "../../api/client";
import {
  fetchMissionExceptionHuddles,
  selectActiveExceptionHuddle,
  type MissionExceptionHuddleItem,
  type MissionExceptionHuddlesResponse,
} from "../useMissionExceptionHuddles";

vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));

function metadata(status: ExceptionHuddleMetadata["status"]): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    sourceStepId: "step-1",
    sourceIssueId: "issue-1",
    workProductLinks: [],
    participants: {
      ownerAgentId: "owner-1",
      producerAgentId: "producer-1",
      validatorAgentId: "validator-1",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T12:05:00.000Z",
    status,
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
  };
}

function item(
  threadId: string,
  status: ExceptionHuddleMetadata["status"],
  updatedAt: string,
): MissionExceptionHuddleItem {
  return {
    threadId,
    channelId: `channel-${threadId}`,
    title: `Huddle ${threadId}`,
    updatedAt,
    huddle: metadata(status),
  };
}

function response(): MissionExceptionHuddlesResponse {
  return {
    missionId: "mission-1",
    counts: { open: 1, timed_out: 0, decided: 0, cancelled: 0 },
    items: [item("thread-1", "open", "2026-11-28T12:00:00.000Z")],
  };
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe("selectActiveExceptionHuddle", () => {
  it("prefers a timed_out huddle over a newer open huddle", () => {
    const timedOut = item("timed-out", "timed_out", "2026-11-28T11:00:00.000Z");
    const newerOpen = item("open-newer", "open", "2026-11-28T12:00:00.000Z");

    expect(selectActiveExceptionHuddle([newerOpen, timedOut])).toBe(timedOut);
  });

  it("selects the most recently updated timed_out huddle", () => {
    const older = item("timed-out-older", "timed_out", "2026-11-28T10:00:00.000Z");
    const newer = item("timed-out-newer", "timed_out", "2026-11-28T11:00:00.000Z");

    expect(selectActiveExceptionHuddle([older, newer])).toBe(newer);
  });

  it("selects the most recently updated open huddle when none are timed out", () => {
    const older = item("open-older", "open", "2026-11-28T10:00:00.000Z");
    const newer = item("open-newer", "open", "2026-11-28T11:00:00.000Z");

    expect(selectActiveExceptionHuddle([older, newer])).toBe(newer);
  });

  it("ignores decided and cancelled huddles", () => {
    const decided = item("decided", "decided", "2026-11-28T12:00:00.000Z");
    const cancelled = item("cancelled", "cancelled", "2026-11-28T13:00:00.000Z");

    expect(selectActiveExceptionHuddle([decided, cancelled])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectActiveExceptionHuddle([])).toBeNull();
  });

  it("never mutates the input", () => {
    const open = item("open", "open", "2026-11-28T10:00:00.000Z");
    const timedOut = item("timed-out", "timed_out", "2026-11-28T11:00:00.000Z");
    const items = Object.freeze([open, timedOut]);
    const serialized = JSON.stringify(items);

    expect(selectActiveExceptionHuddle(items)).toBe(timedOut);
    expect(JSON.stringify(items)).toBe(serialized);
  });
});

describe("fetchMissionExceptionHuddles", () => {
  it("encodes company and mission ids and omits the query string without options", async () => {
    const body = response();
    vi.mocked(api.get).mockResolvedValue(body);

    await expect(fetchMissionExceptionHuddles("company id/1", "mission?id")).resolves.toBe(body);

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(
      "/companies/company%20id%2F1/collab-channels/missions/mission%3Fid/huddles",
    );
  });

  it("adds status and limit query params", async () => {
    vi.mocked(api.get).mockResolvedValue(response());

    await fetchMissionExceptionHuddles("company-1", "mission-1", { status: "timed_out", limit: 25 });

    expect(api.get).toHaveBeenCalledWith(
      "/companies/company-1/collab-channels/missions/mission-1/huddles?status=timed_out&limit=25",
    );
  });
});

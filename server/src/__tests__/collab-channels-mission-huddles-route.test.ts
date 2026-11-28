import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleStatus,
} from "@paperclipai/shared/validators/exception-huddle";
import { errorHandler } from "../middleware/index.js";
import { collabChannelsRoutes } from "../routes/collab-channels.js";
import type {
  MissionExceptionHuddleCounts,
  MissionExceptionHuddleItem,
  MissionExceptionHuddleScope,
} from "../services/missions/exception-huddle-queries.js";

const COMPANY_ID = "company-1";
const MISSION_ID = "mission-1";

type ListMissionExceptionHuddles = (
  db: Db,
  scope: MissionExceptionHuddleScope,
) => Promise<{ items: MissionExceptionHuddleItem[]; counts: MissionExceptionHuddleCounts }>;

const mockExceptionHuddleQueries = vi.hoisted(() => ({
  listMissionExceptionHuddles: vi.fn<ListMissionExceptionHuddles>(),
}));

vi.mock("../services/missions/exception-huddle-queries.js", () => mockExceptionHuddleQueries);

const db = {} as Db;

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user",
  companyId: COMPANY_ID,
  source: "local_implicit",
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = actor;
    next();
  });
  app.use("/api", collabChannelsRoutes(db));
  app.use(errorHandler);
  return app;
}

function huddleMetadata(status: ExceptionHuddleStatus = "open") {
  return exceptionHuddleMetadataSchema.parse({
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: MISSION_ID,
    workflowRunId: "run-1",
    sourceStepId: "qa-review",
    sourceIssueId: "issue-1",
    workProductLinks: ["work-product://draft"],
    participants: {
      ownerAgentId: "owner-1",
      producerAgentId: "producer-1",
      validatorAgentId: "validator-1",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status,
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
  });
}

function huddleItem(status: ExceptionHuddleStatus = "open"): MissionExceptionHuddleItem {
  return {
    threadId: "thread-1",
    channelId: "channel-1",
    title: "[Huddle] thread-1",
    threadStatus: "open",
    huddle: huddleMetadata(status),
    updatedAt: new Date("2026-11-28T01:00:00.000Z"),
  };
}

function emptyCounts(): MissionExceptionHuddleCounts {
  return { open: 0, timedOut: 0, decided: 0, cancelled: 0 };
}

const route = () => `/api/companies/${COMPANY_ID}/collab-channels/missions/${MISSION_ID}/huddles`;

describe("mission exception huddle history route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExceptionHuddleQueries.listMissionExceptionHuddles.mockResolvedValue({
      items: [huddleItem()],
      counts: { ...emptyCounts(), open: 1 },
    });
  });

  it("returns the mission huddle history response shape", async () => {
    const res = await request(createApp()).get(route());

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["counts", "items", "missionId"]);
    expect(res.body.missionId).toBe(MISSION_ID);
    expect(res.body.counts).toEqual({ open: 1, timedOut: 0, decided: 0, cancelled: 0 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      threadId: "thread-1",
      channelId: "channel-1",
      title: "[Huddle] thread-1",
      threadStatus: "open",
      updatedAt: "2026-11-28T01:00:00.000Z",
    });
    expect(res.body.items[0].huddle).toMatchObject({ missionId: MISSION_ID, status: "open" });
    expect(mockExceptionHuddleQueries.listMissionExceptionHuddles).toHaveBeenCalledWith(db, {
      companyId: COMPANY_ID,
      missionId: MISSION_ID,
      status: undefined,
      limit: undefined,
    });
  });

  it("forwards a valid status filter and positive integer limit", async () => {
    mockExceptionHuddleQueries.listMissionExceptionHuddles.mockResolvedValue({
      items: [],
      counts: emptyCounts(),
    });

    const res = await request(createApp()).get(route()).query({ status: "timed_out", limit: "7" });

    expect(res.status).toBe(200);
    expect(mockExceptionHuddleQueries.listMissionExceptionHuddles).toHaveBeenCalledWith(db, {
      companyId: COMPANY_ID,
      missionId: MISSION_ID,
      status: "timed_out",
      limit: 7,
    });
  });

  it("rejects an invalid status filter with HTTP 400", async () => {
    const res = await request(createApp()).get(route()).query({ status: "paused" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid huddle status filter" });
    expect(mockExceptionHuddleQueries.listMissionExceptionHuddles).not.toHaveBeenCalled();
  });

  it("rejects invalid and non-positive limits with HTTP 400", async () => {
    for (const limit of ["0", "-1", "1.5", "abc"]) {
      const res = await request(createApp()).get(route()).query({ limit });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid huddle limit filter" });
    }
    expect(mockExceptionHuddleQueries.listMissionExceptionHuddles).not.toHaveBeenCalled();
  });

  it("enforces company access before querying huddle history", async () => {
    const forbiddenRes = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-2",
    })).get(route());
    expect(forbiddenRes.status).toBe(403);

    const unauthenticatedRes = await request(createApp({ type: "none" })).get(route());
    expect(unauthenticatedRes.status).toBe(401);
    expect(mockExceptionHuddleQueries.listMissionExceptionHuddles).not.toHaveBeenCalled();
  });
});
